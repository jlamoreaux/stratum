import type { Env } from '../types';
import type { WorkspaceEntry } from '../types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function runTtlSweep(env: Env): Promise<{ deleted: number }> {
  let deleted = 0;

  const list = await env.STATE.list({ prefix: 'workspace:' });

  for (const key of list.keys) {
    try {
      const raw = await env.STATE.get(key.name);
      if (!raw) continue;

      const workspace = JSON.parse(raw) as WorkspaceEntry;
      const createdAt = new Date(workspace.createdAt).getTime();
      if (Date.now() - createdAt < THIRTY_DAYS_MS) continue;

      const workspaceId = key.name.replace(/^workspace:/, '');

      const result = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM changes WHERE workspace = ? AND status = ?',
      )
        .bind(workspaceId, 'open')
        .first<{ count: number }>();

      if ((result?.count ?? 0) !== 0) continue;

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

  return { deleted };
}
