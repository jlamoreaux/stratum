import { newId } from '../utils/ids';

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
  };
}

export async function createSession(db: D1Database, userId: string): Promise<Session> {
  const id = newId('sess');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, expiresAt)
    .run();

  return { id, userId, expiresAt };
}

export async function getSession(db: D1Database, id: string): Promise<Session | null> {
  const row = await db
    .prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>();

  return row ? rowToSession(row) : null;
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}
