import type { Env } from '../types';

export interface RequestMetric {
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  userId?: string;
  agentId?: string;
}

export function recordMetric(env: Env, metric: RequestMetric): void {
  if (!env.ANALYTICS) return;

  env.ANALYTICS.writeDataPoint({
    blobs: [metric.method, metric.path, metric.userId ?? 'anon', metric.agentId ?? 'none'],
    doubles: [metric.status, metric.latencyMs],
    indexes: [metric.method + ':' + Math.floor(metric.status / 100) + 'xx'],
  });
}
