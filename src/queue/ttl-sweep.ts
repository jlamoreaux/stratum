import type { Env } from "../types";
import type { WorkspaceEntry } from "../types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function runTtlSweep(env: Env): Promise<{ deleted: number }> {
  let deleted = 0;
  let cursor: string | null = null;

  while (true) {
    const listOpts: KVNamespaceListOptions = { prefix: "workspace:" };
    if (cursor !== null) listOpts.cursor = cursor;

    const result: KVNamespaceListResult<unknown> = await env.STATE.list(listOpts);

    for (const key of result.keys) {
      try {
        const raw = await env.STATE.get(key.name);
        if (!raw) continue;

        const workspace = JSON.parse(raw) as WorkspaceEntry;
        const createdAt = new Date(workspace.createdAt).getTime();
        if (Date.now() - createdAt < THIRTY_DAYS_MS) continue;

        const workspaceId = key.name.replace(/^workspace:/, "");

        const queryResult = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM changes WHERE workspace = ? AND status = ?",
        )
          .bind(workspaceId, "open")
          .first<{ count: number }>();

        if ((queryResult?.count ?? 0) !== 0) continue;

        try {
          await env.ARTIFACTS.delete(workspace.name);
        } catch {
          // Missing artifact — proceed with KV cleanup
        }

        await env.STATE.delete(key.name);
        deleted++;
      } catch {
        // Per-item error — continue sweep
      }
    }

    if (result.list_complete) break;
    cursor = result.cursor;
  }

  return { deleted };
}
