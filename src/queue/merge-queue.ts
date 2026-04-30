import { getChange, updateChangeStatus } from "../storage/changes";
import { mergeWorkspaceIntoProject } from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";

export class MergeQueue {
  env: Env;
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async merge(changeId: string): Promise<{ success: boolean; commit?: string; error?: string }> {
    const change = await getChange(this.env.DB, changeId);
    if (!change || change.status !== "approved") {
      return { success: false, error: "Change not found or not approved" };
    }

    try {
      const project = await getProject(this.env.STATE, change.project);
      if (!project) return { success: false, error: `Project '${change.project}' not found` };

      const workspace = await getWorkspace(this.env.STATE, change.workspace);
      if (!workspace) return { success: false, error: `Workspace '${change.workspace}' not found` };

      const commit = await mergeWorkspaceIntoProject(
        project.remote,
        project.token,
        workspace.remote,
        workspace.token,
      );

      await updateChangeStatus(this.env.DB, changeId, "merged", {
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
        ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
        mergedAt: new Date().toISOString(),
      });

      await recordProvenance(this.env.DB, {
        commitSha: commit,
        project: change.project,
        workspace: change.workspace,
        changeId,
        ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      });

      return { success: true, commit };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
