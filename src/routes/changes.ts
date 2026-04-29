import { Hono } from 'hono';
import { createChange, getChange, listChanges, updateChangeStatus } from '../storage/changes';
import { getDiffBetweenRepos, mergeWorkspaceIntoProject } from '../storage/git-ops';
import { getProject, getWorkspace } from '../storage/state';
import { recordProvenance } from '../storage/provenance';
import {
  CompositeEvaluator,
  DiffEvaluator,
  LLMEvaluator,
  WebhookEvaluator,
  loadPolicy,
} from '../evaluation';
import type { Evaluator } from '../evaluation/types';
import type { Change, Env } from '../types';
import { badRequest, created, notFound, ok } from '../utils/response';
import { publishEvent } from '../queue/events';

const app = new Hono<{ Bindings: Env }>();

app.post('/projects/:name/changes', async (c) => {
  const { name: projectName } = c.req.param();

  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound('Project', projectName);

  const body = await c.req.json<{ workspace?: unknown }>().catch(() => ({ workspace: undefined }));
  if (typeof body.workspace !== 'string' || !body.workspace.trim()) {
    return badRequest('workspace is required');
  }

  const workspace = await getWorkspace(c.env.STATE, body.workspace);
  if (!workspace) return notFound('Workspace', body.workspace);

  if (workspace.parent !== projectName) {
    return badRequest(`Workspace '${body.workspace}' does not belong to project '${projectName}'`);
  }

  const agentId = c.get('agentId');
  const change = await createChange(c.env.DB, {
    project: projectName,
    workspace: body.workspace,
    ...(agentId !== undefined ? { agentId } : {}),
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: 'change.created',
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

  const evaluators: Evaluator[] = policy.evaluators.flatMap((cfg) => {
    switch (cfg.type) {
      case 'diff':
        return [new DiffEvaluator()];
      case 'webhook':
        return [new WebhookEvaluator()];
      case 'llm':
        if (c.env.AI) return [new LLMEvaluator(c.env.AI)];
        return [];
      default:
        return [];
    }
  });

  const composite = new CompositeEvaluator(evaluators.length > 0 ? evaluators : [new DiffEvaluator()]);
  const evalResult = await composite.evaluateAndAggregate(diff, policy);

  const newStatus: Change['status'] = evalResult.passed ? 'approved' : 'open';

  await updateChangeStatus(c.env.DB, change.id, newStatus, {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: 'change.evaluated',
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

  return created({ change: updatedChange, eval: evalResult });
});

app.get('/projects/:name/changes', async (c) => {
  const { name: projectName } = c.req.param();

  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound('Project', projectName);

  const statusParam = c.req.query('status');
  const validStatuses: Change['status'][] = ['open', 'approved', 'merged', 'rejected'];
  const status =
    statusParam && (validStatuses as string[]).includes(statusParam)
      ? (statusParam as Change['status'])
      : undefined;

  const changes = await listChanges(c.env.DB, projectName, status);
  return ok({ project: projectName, changes });
});

app.get('/changes/:id', async (c) => {
  const { id } = c.req.param();
  const change = await getChange(c.env.DB, id);
  if (!change) return notFound('Change', id);
  return ok({ change });
});

app.post('/changes/:id/merge', async (c) => {
  const { id } = c.req.param();
  const force = c.req.query('force') === 'true';

  const change = await getChange(c.env.DB, id);
  if (!change) return notFound('Change', id);

  if (change.status !== 'approved' && !force) {
    return badRequest('Change must be approved before merging');
  }

  if (c.env.MERGE_QUEUE) {
    const doId = c.env.MERGE_QUEUE.idFromName(change.project);
    const stub = c.env.MERGE_QUEUE.get(doId);
    const result = await (stub as unknown as { merge(changeId: string): Promise<{ success: boolean; commit?: string; error?: string }> }).merge(id);

    if (!result.success) {
      return badRequest(result.error ?? 'Merge failed');
    }

    await publishEvent(c.env.EVENTS_QUEUE, {
      type: 'change.merged',
      changeId: id,
      project: change.project,
      commit: result.commit ?? '',
    });

    return ok({
      merged: true,
      changeId: id,
      project: change.project,
      workspace: change.workspace,
      commit: result.commit,
    });
  }

  const project = await getProject(c.env.STATE, change.project);
  if (!project) return notFound('Project', change.project);

  const workspace = await getWorkspace(c.env.STATE, change.workspace);
  if (!workspace) return notFound('Workspace', change.workspace);

  const commit = await mergeWorkspaceIntoProject(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
  );

  const mergedAt = new Date().toISOString();
  await updateChangeStatus(c.env.DB, id, 'merged', {
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
    type: 'change.merged',
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

app.post('/changes/:id/reject', async (c) => {
  const { id } = c.req.param();

  const change = await getChange(c.env.DB, id);
  if (!change) return notFound('Change', id);

  if (change.status === 'merged') {
    return badRequest('Cannot reject a merged change');
  }

  await updateChangeStatus(c.env.DB, id, 'rejected', {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
  });

  await publishEvent(c.env.EVENTS_QUEUE, {
    type: 'change.rejected',
    changeId: id,
    project: change.project,
  });

  return ok({ rejected: true, changeId: id });
});

export { app as changesRouter };
