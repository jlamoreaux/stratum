import { generateApiKey, hashToken } from '../utils/crypto';
import { newId } from '../utils/ids';
import type { Agent } from '../types';

export interface CreateAgentResult {
  agent: Agent;
  plaintext: string;
}

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  model: string | null;
  description: string | null;
  prompt_hash: string | null;
  token_hash: string;
  created_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
  if (row.model !== null) agent.model = row.model;
  if (row.description !== null) agent.description = row.description;
  if (row.prompt_hash !== null) agent.promptHash = row.prompt_hash;
  return agent;
}

export async function createAgent(
  db: D1Database,
  ownerId: string,
  name: string,
  model?: string,
  description?: string,
  promptHash?: string,
): Promise<CreateAgentResult> {
  const id = newId('agt');
  const plaintext = await generateApiKey('stratum_agent');
  const tokenHash = await hashToken(plaintext);

  await db
    .prepare(
      'INSERT INTO agents (id, name, owner_id, model, description, prompt_hash, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, name, ownerId, model ?? null, description ?? null, promptHash ?? null, tokenHash)
    .run();

  const agent: Agent = {
    id,
    name,
    ownerId,
    tokenHash,
    createdAt: new Date().toISOString(),
  };
  if (model !== undefined) agent.model = model;
  if (description !== undefined) agent.description = description;
  if (promptHash !== undefined) agent.promptHash = promptHash;

  return { agent, plaintext };
}

export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  const row = await db
    .prepare('SELECT * FROM agents WHERE id = ?')
    .bind(id)
    .first<AgentRow>();

  return row ? rowToAgent(row) : null;
}

export async function getAgentByToken(db: D1Database, plaintext: string): Promise<Agent | null> {
  const tokenHash = await hashToken(plaintext);
  const row = await db
    .prepare('SELECT * FROM agents WHERE token_hash = ?')
    .bind(tokenHash)
    .first<AgentRow>();

  return row ? rowToAgent(row) : null;
}

export async function listAgents(db: D1Database, ownerId: string): Promise<Agent[]> {
  const result = await db
    .prepare('SELECT * FROM agents WHERE owner_id = ?')
    .bind(ownerId)
    .all<AgentRow>();

  return result.results.map(rowToAgent);
}

export async function deleteAgent(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM agents WHERE id = ?').bind(id).run();
}
