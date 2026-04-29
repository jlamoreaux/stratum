import { Hono } from 'hono';
import { createAgent, deleteAgent, getAgent, listAgents } from '../storage/agents';
import type { Env } from '../types';
import { badRequest, created, ok } from '../utils/response';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ name?: unknown; model?: unknown; description?: unknown; promptHash?: unknown }>();
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return badRequest('name is required');
  }

  const model = typeof body.model === 'string' ? body.model : undefined;
  const description = typeof body.description === 'string' ? body.description : undefined;
  const promptHash = typeof body.promptHash === 'string' ? body.promptHash : undefined;
  const { agent, plaintext } = await createAgent(c.env.DB, userId, body.name, model, description, promptHash);

  return created({
    agent: {
      id: agent.id,
      name: agent.name,
      ownerId: agent.ownerId,
      model: agent.model,
      description: agent.description,
      promptHash: agent.promptHash,
      createdAt: agent.createdAt,
    },
    token: plaintext,
  });
});

app.get('/', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const agents = await listAgents(c.env.DB, userId);

  return ok({
    agents: agents.map(({ id, name, ownerId, model, description, promptHash, createdAt }) => ({
      id,
      name,
      ownerId,
      model,
      description,
      promptHash,
      createdAt,
    })),
  });
});

app.get('/:id', async (c) => {
  const { id } = c.req.param();
  const agent = await getAgent(c.env.DB, id);
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  return ok({
    id: agent.id,
    name: agent.name,
    ownerId: agent.ownerId,
    model: agent.model,
    description: agent.description,
    promptHash: agent.promptHash,
    createdAt: agent.createdAt,
  });
});

app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { id } = c.req.param();
  const agent = await getAgent(c.env.DB, id);
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  if (agent.ownerId !== userId) return c.json({ error: 'Forbidden' }, 403);

  await deleteAgent(c.env.DB, id);
  return ok({ deleted: true, id });
});

export { app as agentsRouter };
