import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

export function rateLimitMiddleware(opts?: { requestsPerMinute?: number }): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }

    const userId = c.get('userId');
    const agentId = c.get('agentId');
    const isAuthenticated = Boolean(userId ?? agentId);

    const defaultLimit = isAuthenticated ? 1000 : 60;
    const limit = opts?.requestsPerMinute ?? defaultLimit;

    const identifier = userId ?? agentId ?? c.req.header('CF-Connecting-IP') ?? 'anonymous';
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${identifier}:${minuteBucket}`;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const nextMinuteSeconds = (minuteBucket + 1) * 60;
    const retryAfter = nextMinuteSeconds - nowSeconds;

    try {
      const raw = await c.env.STATE.get(key);
      const count = raw !== null ? parseInt(raw, 10) : 0;

      if (count >= limit) {
        return c.json(
          { error: 'Too many requests' },
          429,
          {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': '0',
          },
        );
      }

      await c.env.STATE.put(key, String(count + 1), { expirationTtl: 120 });

      c.header('X-RateLimit-Limit', String(limit));
      c.header('X-RateLimit-Remaining', String(limit - count - 1));
      c.header('X-RateLimit-Reset', String(nextMinuteSeconds));
    } catch {
      // KV unavailable — allow request through
    }

    await next();
  };
}
