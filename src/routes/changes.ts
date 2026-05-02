import { Hono } from "hono";
import {
  CompositeEvaluator,
  DiffEvaluator,
  LLMEvaluator,
  SandboxEvaluator,
  SecretScanEvaluator,
  WebhookEvaluator,
  loadPolicy,
} from "../evaluation";
import type { EvalPolicy, EvalResult } from "../evaluation/types";
import type { Evaluator } from "../evaluation/types";
import { publishEvent } from "../queue/events";
import { createChange, getChange, listChanges, updateChangeStatus } from "../storage/changes";
import { listEvalRuns, recordEvalRuns } from "../storage/eval-runs";
import { getDiffBetweenRepos, mergeWorkspaceIntoProject } from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Change, Env } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();
function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git|\/)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

const MERGEABLE_STATUSES: Change["status"][] = ["approved", "accepted", "promoted"];

class UnavailableEvaluator implements Evaluator {
  constructor(
    private evaluatorType: string,
    private reason: string,
  ) {}

  async evaluate(_diff: string, _policy: EvalPolicy): Promise<EvalResult> {
    return { score: 0, passed: false, reason: `${this.evaluatorType} unavailable: ${this.reason}` };
  }
}

app.post("/projects/:name/changes", async (c) => {
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: projectName } = c.req.param();

  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound("Project", projectName);
  if (!canWriteProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const body = await c.req.json<{ workspace?: unknown }>().catch(() => ({ workspace: undefined }));
  if (typeof body.workspace !== "string" || !body.workspace.trim()) {
    return badRequest("workspace is required");
  }

  const workspace = await getWorkspace(c.env.STATE, body.workspace);
  if (!workspace) return notFound("Workspace", body.workspace);

  if (workspace.parent !== projectName) {
    return badRequest(`Workspace '${body.workspace}' does not belong to project '${projectName}'`);
  }

  const change = await createChange(c.env.DB, {
    project: projectName,
    workspace: body.workspace,
    ...(agentId !== undefined ? { agentId } : {}),
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: "change.created",
    changeId: change.id,
    project: projectName,
    workspace: body.workspace,
  });

  const policy = await loadPolicy(project.remote, project.token);

  const diff = await getDiffBetweenRepos(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
  );

  const evaluators: Array<{ type: string; evaluator: Evaluator }> = [
    { type: "secret_scan", evaluator: new SecretScanEvaluator() },
  ];

  evaluators.push(
    ...policy.evaluators.flatMap((cfg): Array<{ type: string; evaluator: Evaluator }> => {
      switch (cfg.type) {
        case "diff":
          return [{ type: "diff", evaluator: new DiffEvaluator() }];
        case "webhook":
          return [{ type: "webhook", evaluator: new WebhookEvaluator() }];
        case "llm":
          if (c.env.AI) return [{ type: "llm", evaluator: new LLMEvaluator(c.env.AI) }];
          return [
            {
              type: "llm",
              evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
            },
          ];
        case "sandbox":
          if (c.env.SANDBOX) {
            return [{ type: "sandbox", evaluator: new SandboxEvaluator(c.env.SANDBOX) }];
          }
          return [
            {
              type: "sandbox",
              evaluator: new UnavailableEvaluator("sandbox", "SANDBOX binding is not configured"),
            },
          ];
        default:
          console.warn(
            `Unknown evaluator type "${(cfg as { type: string }).type}" in policy for project ${projectName}`,
          );
          return [];
      }
    }),
  );

  const evalRuns = await Promise.all(
    evaluators.map(async ({ type, evaluator }) => ({
      evaluatorType: type,
      result: await evaluator.evaluate(diff, policy),
    })),
  );

  const composite = new CompositeEvaluator(evaluators.map(({ evaluator }) => evaluator));
  const aggregateResult = composite.aggregate(
    evalRuns.map(({ result }) => result),
    policy,
  );
  const blockingFailure = evalRuns.find(
    ({ evaluatorType, result }) => evaluatorType === "secret_scan" && !result.passed,
  );
  const evalResult =
    blockingFailure === undefined
      ? aggregateResult
      : {
          score: Math.min(aggregateResult.score, blockingFailure.result.score),
          passed: false,
          reason:
            aggregateResult.reason === blockingFailure.result.reason
              ? blockingFailure.result.reason
              : `${blockingFailure.result.reason} ${aggregateResult.reason}`,
          issues: aggregateResult.issues,
        };

  const newStatus: Change["status"] = evalResult.passed ? "accepted" : "needs_changes";

  await recordEvalRuns(c.env.DB, change.id, evalRuns);
  await updateChangeStatus(c.env.DB, change.id, newStatus, {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: "change.evaluated",
    changeId: change.id,
    score: evalResult.score,
    passed: evalResult.passed,
  });

  const updatedChange: Change = {
    ...change,
    status: newStatus,
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
  };

  return created({ change: updatedChange, eval: evalResult, evalRuns });
});

app.get("/projects/:name/changes", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name: projectName } = c.req.param();

  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound("Project", projectName);
  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const statusParam = c.req.query("status");
  const validStatuses: Change["status"][] = [
    "open",
    "needs_changes",
    "accepted",
    "approved",
    "promoted",
    "merged",
    "rejected",
  ];
  const status =
    statusParam && (validStatuses as string[]).includes(statusParam)
      ? (statusParam as Change["status"])
      : undefined;

  const changes = await listChanges(c.env.DB, projectName, status);
  return ok({ project: projectName, changes });
});

app.get("/changes/:id", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { id } = c.req.param();
  const change = await getChange(c.env.DB, id);
  if (!change) return notFound("Change", id);
  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound("Project", change.project);
  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");
  const evalRuns = await listEvalRuns(c.env.DB, id);
  return ok({ change, evalRuns });
});

app.post("/changes/:id/merge", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can trigger merges directly");

  const { id } = c.req.param();
  const force = c.req.query("force") === "true";
  const strategyParam = c.req.query("strategy");
  const strategy = strategyParam === "squash" ? "squash" : "merge";
  if (strategyParam !== undefined && strategyParam !== "squash" && strategyParam !== "merge") {
    return badRequest("strategy must be 'merge' or 'squash'");
  }

  const change = await getChange(c.env.DB, id);
  if (!change) return notFound("Change", id);

  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound("Project", change.project);
  if (!canWriteProject(project, userId)) return forbidden("Project access denied");

  if (!MERGEABLE_STATUSES.includes(change.status) && !force) {
    return badRequest("Change must be approved, accepted, or promoted before merging");
  }

  if (c.env.MERGE_QUEUE && strategy === "merge") {
    const doId = c.env.MERGE_QUEUE.idFromName(change.project);
    const stub = c.env.MERGE_QUEUE.get(doId);
    const result = await (
      stub as unknown as {
        merge(changeId: string): Promise<{ success: boolean; commit?: string; error?: string }>;
      }
    ).merge(id);

    if (!result.success) {
      return badRequest(result.error ?? "Merge failed");
    }

    await publishEvent(c.env.EVENTS_QUEUE, {
      type: "change.merged",
      changeId: id,
      project: change.project,
      commit: result.commit ?? "",
    });

    return ok({
      merged: true,
      changeId: id,
      project: change.project,
      workspace: change.workspace,
      commit: result.commit,
    });
  }

  const workspace = await getWorkspace(c.env.STATE, change.workspace);
  if (!workspace) return notFound("Workspace", change.workspace);

  let commit: string;
  try {
    commit = await mergeWorkspaceIntoProject(
      project.remote,
      project.token,
      workspace.remote,
      workspace.token,
      { strategy },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return badRequest(message);
  }

  const mergedAt = new Date().toISOString();
  await updateChangeStatus(c.env.DB, id, "merged", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    mergedAt,
  });

  await recordProvenance(c.env.DB, {
    commitSha: commit,
    project: change.project,
    workspace: change.workspace,
    changeId: id,
    ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: "change.merged",
    changeId: id,
    project: change.project,
    commit,
  });

  return ok({
    merged: true,
    changeId: id,
    project: change.project,
    workspace: change.workspace,
    commit,
  });
});

app.post("/changes/:id/reject", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can reject changes");

  const { id } = c.req.param();

  const change = await getChange(c.env.DB, id);
  if (!change) return notFound("Change", id);

  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound("Project", change.project);
  if (!canWriteProject(project, userId)) return forbidden("Project access denied");

  if (change.status === "merged") {
    return badRequest("Cannot reject a merged change");
  }

  await updateChangeStatus(c.env.DB, id, "rejected", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: "change.rejected",
    changeId: id,
    project: change.project,
  });

  return ok({ rejected: true, changeId: id });
});

app.post("/changes/:id/evaluate", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can run evaluations");
  const { id } = c.req.param();
  const change = await getChange(c.env.DB, id);
  if (!change) return notFound("Change", id);
  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound("Project", change.project);
  if (!canWriteProject(project, userId)) return forbidden("Project access denied");
  if (change.status === "merged" || change.status === "rejected" || change.status === "promoted") {
    return badRequest(`Cannot re-evaluate a ${change.status} change`);
  }
  const workspace = await getWorkspace(c.env.STATE, change.workspace);
  if (!workspace) return badRequest("Change references missing project/workspace");
  const policy = await loadPolicy(project.remote, project.token);
  const diff = await getDiffBetweenRepos(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
  );
  const evaluators: Array<{ type: string; evaluator: Evaluator }> = [
    { type: "secret_scan", evaluator: new SecretScanEvaluator() },
    ...policy.evaluators.flatMap((cfg): Array<{ type: string; evaluator: Evaluator }> => {
      switch (cfg.type) {
        case "diff":
          return [{ type: "diff", evaluator: new DiffEvaluator() }];
        case "webhook":
          return [{ type: "webhook", evaluator: new WebhookEvaluator() }];
        case "llm":
          return c.env.AI
            ? [{ type: "llm", evaluator: new LLMEvaluator(c.env.AI) }]
            : [
                {
                  type: "llm",
                  evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
                },
              ];
        case "sandbox":
          return c.env.SANDBOX
            ? [{ type: "sandbox", evaluator: new SandboxEvaluator(c.env.SANDBOX) }]
            : [
                {
                  type: "sandbox",
                  evaluator: new UnavailableEvaluator(
                    "sandbox",
                    "SANDBOX binding is not configured",
                  ),
                },
              ];
        default:
          return [];
      }
    }),
  ];
  const evalRuns = await Promise.all(
    evaluators.map(async ({ type, evaluator }) => ({
      evaluatorType: type,
      result: await evaluator.evaluate(diff, policy),
    })),
  );
  const composite = new CompositeEvaluator(evaluators.map(({ evaluator }) => evaluator));
  const aggregateResult = composite.aggregate(
    evalRuns.map(({ result }) => result),
    policy,
  );
  const blockingFailure = evalRuns.find(
    ({ evaluatorType, result }) => evaluatorType === "secret_scan" && !result.passed,
  );
  const evalResult =
    blockingFailure === undefined
      ? aggregateResult
      : {
          score: Math.min(aggregateResult.score, blockingFailure.result.score),
          passed: false,
          reason:
            aggregateResult.reason === blockingFailure.result.reason
              ? blockingFailure.result.reason
              : `${blockingFailure.result.reason} ${aggregateResult.reason}`,
          issues: aggregateResult.issues,
        };
  await recordEvalRuns(c.env.DB, id, evalRuns);
  await updateChangeStatus(c.env.DB, id, evalResult.passed ? "accepted" : "needs_changes", {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
  });
  return ok({ changeId: id, eval: evalResult, evalRuns });
});

app.post("/changes/:id/github-pr", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");
  const { id } = c.req.param();
  const change = await getChange(c.env.DB, id);
  if (!change) return notFound("Change", id);
  if (change.status !== "accepted" && change.status !== "promoted") {
    return badRequest("Change must be accepted before promotion");
  }
  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound("Project", change.project);
  if (!canWriteProject(project, userId)) return forbidden("Project access denied");
  if (!project?.githubUrl) return badRequest("Project is not connected to GitHub");
  const repo = parseGitHubRepo(project.githubUrl);
  if (!repo) return badRequest("Project githubUrl is invalid");
  const body = await c.req
    .json<{ title?: string; body?: string; base?: string; draft?: boolean }>()
    .catch(() => ({}) as { title?: string; body?: string; base?: string; draft?: boolean });
  const branch = `stratum/${change.id}`;
  const prBody =
    `## Stratum review\n\n- Change: \`${change.id}\`\n- Workspace: \`${change.workspace}\`\n- Evaluation: ${change.evalPassed ? "passed" : "failed"}, score ${change.evalScore ?? "n/a"}\n\n${body.body ?? ""}`.trim();
  const ghRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${project.token}`,
      "User-Agent": "stratum",
    },
    body: JSON.stringify({
      title: body.title ?? `Stratum: ${change.id}`,
      body: prBody,
      head: branch,
      base: body.base ?? project.githubDefaultBranch ?? "main",
      draft: body.draft ?? true,
    }),
  });
  if (!ghRes.ok) return badRequest(`GitHub PR creation failed (${ghRes.status})`);
  const pr = (await ghRes.json()) as { number: number; html_url: string; state: string };
  const promotedAt = new Date().toISOString();
  await updateChangeStatus(c.env.DB, id, "promoted", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    githubOwner: repo.owner,
    githubRepo: repo.repo,
    githubBranch: branch,
    githubPrNumber: pr.number,
    githubPrUrl: pr.html_url,
    githubPrState: pr.state,
    promotedAt,
    promotedBy: userId,
  });
  return ok({
    changeId: id,
    github: {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
    },
  });
});

export { app as changesRouter };
