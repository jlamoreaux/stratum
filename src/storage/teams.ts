import { newId } from '../utils/ids';

export interface Team {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  permissions: 'read' | 'write' | 'admin';
  createdAt: string;
}

interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  permissions: string;
  created_at: string;
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    permissions: row.permissions as Team['permissions'],
    createdAt: row.created_at,
  };
}

export async function createTeam(
  db: D1Database,
  orgId: string,
  name: string,
  slug: string,
  permissions: Team['permissions'] = 'read',
): Promise<Team> {
  const id = newId('team');
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      'INSERT INTO teams (id, org_id, name, slug, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, orgId, name, slug, permissions, createdAt)
    .run();

  return { id, orgId, name, slug, permissions, createdAt };
}

export async function getTeam(db: D1Database, id: string): Promise<Team | null> {
  const row = await db
    .prepare('SELECT * FROM teams WHERE id = ?')
    .bind(id)
    .first<TeamRow>();

  return row ? rowToTeam(row) : null;
}

export async function listTeams(db: D1Database, orgId: string): Promise<Team[]> {
  const { results } = await db
    .prepare('SELECT * FROM teams WHERE org_id = ?')
    .bind(orgId)
    .all<TeamRow>();

  return results.map(rowToTeam);
}

export async function addTeamMember(
  db: D1Database,
  teamId: string,
  userId: string,
): Promise<void> {
  const addedAt = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO team_members (team_id, user_id, added_at) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO NOTHING',
    )
    .bind(teamId, userId, addedAt)
    .run();
}

export async function removeTeamMember(
  db: D1Database,
  teamId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .run();
}

export async function listTeamMembers(db: D1Database, teamId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT user_id FROM team_members WHERE team_id = ?')
    .bind(teamId)
    .all<{ user_id: string }>();

  return results.map((r) => r.user_id);
}

export async function deleteTeam(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM team_members WHERE team_id = ?').bind(id).run();
  await db.prepare('DELETE FROM teams WHERE id = ?').bind(id).run();
}
