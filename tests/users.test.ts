import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import { usersRouter } from '../src/routes/users';
import type { Env } from '../src/types';

vi.mock('../src/storage/users', () => ({
  createUser: vi.fn(),
  getUser: vi.fn(),
  getUserByToken: vi.fn(),
}));

vi.mock('../src/storage/agents', () => ({
  getAgentByToken: vi.fn(),
}));

import { createUser, getUser, getUserByToken } from '../src/storage/users';

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', authMiddleware);
  app.route('/api/users', usersRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env['ARTIFACTS'],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

const mockUser = {
  id: 'usr_abc123',
  email: 'test@example.com',
  tokenHash: 'somehash',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('POST /api/users', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(createUser).mockResolvedValue({
      user: mockUser,
      plaintext: 'stratum_user_deadbeef',
    });
  });

  it('creates user with valid email and returns 201', async () => {
    const res = await app.fetch(
      request('POST', '/api/users', { email: 'test@example.com' }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string; email: string; createdAt: string }; token: string };
    expect(body.user.id).toBe('usr_abc123');
    expect(body.user.email).toBe('test@example.com');
    expect(body.token).toBe('stratum_user_deadbeef');
    expect(body.user).not.toHaveProperty('tokenHash');
    expect(createUser).toHaveBeenCalledWith(env.DB, 'test@example.com');
  });

  it('returns 400 for invalid email', async () => {
    const res = await app.fetch(
      request('POST', '/api/users', { email: 'not-an-email' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('email');
  });

  it('returns 400 for missing email', async () => {
    const res = await app.fetch(request('POST', '/api/users', {}), env);
    expect(res.status).toBe(400);
  });

  it('propagates D1 unique constraint error as 500', async () => {
    vi.mocked(createUser).mockRejectedValue(new Error('UNIQUE constraint failed: users.email'));
    const res = await app.fetch(
      request('POST', '/api/users', { email: 'dupe@example.com' }),
      env,
    );
    expect(res.status).toBe(500);
  });
});

describe('GET /api/users/me', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it('returns current user when authenticated', async () => {
    vi.mocked(getUserByToken).mockResolvedValue(mockUser);
    vi.mocked(getUser).mockResolvedValue(mockUser);

    const res = await app.fetch(
      request('GET', '/api/users/me', undefined, {
        Authorization: 'Bearer stratum_user_deadbeef',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string; createdAt: string };
    expect(body.id).toBe('usr_abc123');
    expect(body.email).toBe('test@example.com');
    expect(body).not.toHaveProperty('tokenHash');
  });

  it('returns 401 when no auth header', async () => {
    const res = await app.fetch(request('GET', '/api/users/me'), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when token is invalid', async () => {
    vi.mocked(getUserByToken).mockResolvedValue(null);
    const res = await app.fetch(
      request('GET', '/api/users/me', undefined, {
        Authorization: 'Bearer stratum_user_badtoken',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
