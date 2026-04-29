import type { Queue } from '../types';

export type StratumEvent =
  | { type: 'change.created'; changeId: string; project: string; workspace: string }
  | { type: 'change.evaluated'; changeId: string; score: number; passed: boolean }
  | { type: 'change.merged'; changeId: string; project: string; commit: string }
  | { type: 'change.rejected'; changeId: string; project: string };

export async function publishEvent(queue: Queue | undefined | null, event: StratumEvent): Promise<void> {
  if (!queue) return;
  await queue.send(event);
}
