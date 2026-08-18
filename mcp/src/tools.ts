import { z } from "zod";
import { parseProjectRef, type StratumClient } from "./client.js";

export interface ToolResult {
  // Index signature matches the MCP SDK's CallToolResult so ToolDef handlers
  // can be passed to registerTool without a cast.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown, kind = "Stratum API error"): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  // stderr, never stdout — stdout carries the MCP stdio framing.
  console.error(`stratum-mcp: ${kind}: ${message}`);
  return { content: [{ type: "text", text: `${kind}: ${message}` }], isError: true };
}

/**
 * Wrap a typed handler with schema validation and error-to-result mapping.
 * Validation failures are labeled distinctly from API failures — an agent that
 * reads "Stratum API error" for a schema violation would retry the same
 * invalid arguments instead of fixing them.
 */
function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
): ToolDef {
  return {
    name,
    description,
    schema,
    handler: async (raw) => {
      let args: z.infer<z.ZodObject<Shape>>;
      try {
        args = z.object(schema).parse(raw);
      } catch (error) {
        return errorResult(error, "Invalid arguments");
      }
      try {
        return jsonResult(await handler(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

const projectArg = z
  .string()
  .describe('Project reference as "namespace/slug", e.g. "@acme/api" or "acme/api"');

/**
 * The full Stratum surface an agent needs to propose governed changes:
 * read a project, fork a workspace, commit, open an eval-gated change, and
 * follow it through review to merge. Approval stays a human gate — the
 * server rejects review approvals from agent tokens by design.
 */
export function buildTools(client: StratumClient): ToolDef[] {
  return [
    tool(
      "stratum_whoami",
      "Identify the authenticated Stratum user or agent for the configured API key.",
      {},
      () => client.me(),
    ),

    // ── Projects ──────────────────────────────────────────────────────────
    tool(
      "stratum_list_projects",
      "List Stratum projects visible to the authenticated identity.",
      {},
      () => client.listProjects(),
    ),
    tool(
      "stratum_get_project",
      "Get a Stratum project's metadata (id, namespace, visibility, git remote).",
      { project: projectArg },
      (a) => client.getProject(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_list_files",
      "List file paths at the HEAD of a Stratum project's default branch.",
      { project: projectArg },
      (a) => client.listFiles(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_get_file",
      "Read one file's content from the HEAD of a Stratum project.",
      { project: projectArg, path: z.string().describe("Repo-relative file path") },
      (a) => client.getFileContent(parseProjectRef(a.project), a.path),
    ),
    tool(
      "stratum_get_activity",
      "Get the recent activity feed for a Stratum project (changes, merges, evaluations, issues).",
      { project: projectArg },
      (a) => client.getActivity(parseProjectRef(a.project)),
    ),

    // ── Workspaces ────────────────────────────────────────────────────────
    tool(
      "stratum_create_workspace",
      "Fork an isolated workspace from a Stratum project. Returns the workspace name and its git remote. Commit work here, then open a change to propose merging it.",
      { project: projectArg, name: z.string().optional().describe("Optional workspace name") },
      (a) => client.createWorkspace(parseProjectRef(a.project), a.name),
    ),
    tool(
      "stratum_list_workspaces",
      "List open workspaces for a Stratum project.",
      { project: projectArg },
      (a) => client.listWorkspaces(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_commit",
      "Commit files to a workspace. Takes a map of repo-relative file paths to full new file contents.",
      {
        workspace: z.string().describe("Workspace name returned by stratum_create_workspace"),
        project_id: z.string().describe("Project id from stratum_get_project"),
        message: z.string().describe("Commit message"),
        files: z
          .record(z.string(), z.string())
          .describe("Map of repo-relative path to complete new file content"),
      },
      (a) => client.commitToWorkspace(a.workspace, a.project_id, a.files, a.message),
    ),

    // ── Changes (eval-gated merge proposals) ──────────────────────────────
    tool(
      "stratum_create_change",
      "Open a change (merge proposal) from a workspace. This synchronously runs the project's evaluation gates from .stratum/policy.yaml — secret scan, diff policy, LLM review, sandbox tests — and returns the verdicts. A failing gate blocks the merge.",
      { project: projectArg, workspace: z.string().describe("Source workspace name") },
      (a) => {
        const ref = parseProjectRef(a.project);
        return client.createChange(`${ref.namespace}/${ref.slug}`, a.workspace);
      },
    ),
    tool(
      "stratum_list_changes",
      "List changes for a Stratum project, optionally filtered by status (open, merged, rejected, reverted).",
      { project: projectArg, status: z.string().optional().describe("Optional status filter") },
      (a) => {
        const ref = parseProjectRef(a.project);
        return client.listChanges(`${ref.namespace}/${ref.slug}`, a.status);
      },
    ),
    tool(
      "stratum_get_change",
      "Get one change with its evaluation runs (per-gate score, pass/fail, reason) and metered costs (LLM tokens, sandbox time, git ops).",
      { change_id: z.string().describe("Change id, e.g. chg_abc123") },
      (a) => client.getChange(a.change_id),
    ),
    tool(
      "stratum_merge_change",
      "Merge a change that has passed its evaluation gates and required human approvals. Fails with the blocking reasons otherwise; a stale base is rejected until re-evaluated. Force requires the policy to allow it.",
      {
        change_id: z.string().describe("Change id"),
        force: z.boolean().optional().describe("Request a force merge (denied unless policy allows)"),
        strategy: z.enum(["merge", "squash"]).optional().describe("Merge strategy"),
      },
      (a) => client.mergeChange(a.change_id, { force: a.force, strategy: a.strategy }),
    ),
    tool(
      "stratum_reject_change",
      "Reject an open change, closing it without merging.",
      { change_id: z.string().describe("Change id") },
      (a) => client.rejectChange(a.change_id),
    ),
    tool(
      "stratum_review_change",
      "Submit a review verdict on a change. Note: approvals are a human gate — the server rejects ALL approve verdicts from agent tokens (not just on the agent's own changes); agents can only request changes.",
      {
        change_id: z.string().describe("Change id"),
        verdict: z.enum(["approve", "request_changes"]).describe("Review verdict"),
        comment: z.string().optional().describe("Optional review comment"),
      },
      (a) => client.reviewChange(a.change_id, a.verdict, a.comment),
    ),

    // ── Issues ────────────────────────────────────────────────────────────
    tool(
      "stratum_create_issue",
      "Open an issue on a Stratum project. Linking a change id auto-closes the issue when that change merges.",
      {
        project: projectArg,
        title: z.string().describe("Issue title"),
        body: z.string().optional().describe("Issue body"),
        linked_change_id: z.string().optional().describe("Change id to link"),
      },
      (a) => client.createIssue(parseProjectRef(a.project), a.title, a.body, a.linked_change_id),
    ),
    tool(
      "stratum_list_issues",
      "List issues for a Stratum project, optionally filtered by status.",
      {
        project: projectArg,
        status: z.enum(["open", "closed"]).optional().describe("Optional status filter"),
      },
      (a) => client.listIssues(parseProjectRef(a.project), a.status),
    ),
    tool(
      "stratum_update_issue",
      "Update an issue's status, title, or body by its number.",
      {
        project: projectArg,
        number: z.number().int().describe("Issue number"),
        status: z.enum(["open", "closed"]).optional().describe("New status"),
        title: z.string().optional().describe("New title"),
        body: z.string().optional().describe("New body"),
      },
      (a) =>
        client.updateIssue(parseProjectRef(a.project), a.number, {
          status: a.status,
          title: a.title,
          body: a.body,
        }),
    ),
  ];
}
