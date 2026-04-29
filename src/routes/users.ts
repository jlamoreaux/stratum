import { Hono } from 'hono';
import { createUser, getUser } from '../storage/users';
import type { Env } from '../types';
import { badRequest, created, ok } from '../utils/response';
import { isValidEmail } from '../utils/validation';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const body = await c.req.json<{ email?: unknown }>();
  if (!isValidEmail(body.email)) return badRequest('email must be a valid email address');

  const { user, plaintext } = await createUser(c.env.DB, body.email);

  return created({
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    token: plaintext,
  });
});

app.get('/me', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const user = await getUser(c.env.DB, userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  return ok({ id: user.id, email: user.email, createdAt: user.createdAt });
});

export { app as usersRouter };
