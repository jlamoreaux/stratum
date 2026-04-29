import { newId } from '../utils/ids';

export interface Org {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
}

export interface OrgMember {
  orgId: string;
  userId: string;
  role: 'member' | 'admin';
  joinedAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

function rowToOrg(row: OrgRow): Org {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

export async function createOrg(
  db: D1Database,
  ownerId: string,
  name: string,
  slug: string,
): Promise<Org> {
  const id = newId('org');
  const createdAt = new Date().toISOString();

  await db
    .prepare('INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, slug, ownerId, createdAt)
    .run();

  return { id, name, slug, ownerId, createdAt };
}

export async function getOrg(db: D1Database, id: string): Promise<Org | null> {
  const row = await db
    .prepare('SELECT * FROM orgs WHERE id = ?')
    .bind(id)
    .first<OrgRow>();

  return row ? rowToOrg(row) : null;
}

export async function getOrgBySlug(db: D1Database, slug: string): Promise<Org | null> {
  const row = await db
    .prepare('SELECT * FROM orgs WHERE slug = ?')
    .bind(slug)
    .first<OrgRow>();

  return row ? rowToOrg(row) : null;
}

export async function listOrgsForUser(db: D1Database, userId: string): Promise<Org[]> {
  const { results } = await db
    .prepare(
      'SELECT o.* FROM orgs o JOIN org_members m ON o.id = m.org_id WHERE m.user_id = ?',
    )
    .bind(userId)
    .all<OrgRow>();

  return results.map(rowToOrg);
}

export async function addOrgMember(
  db: D1Database,
  orgId: string,
  userId: string,
  role: 'member' | 'admin' = 'member',
): Promise<void> {
  const joinedAt = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role',
    )
    .bind(orgId, userId, role, joinedAt)
    .run();
}

export async function removeOrgMember(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId)
    .run();
}

export async function isOrgMember(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId)
    .first<OrgMemberRow>();

  return row !== null;
}

export async function isOrgAdmin(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND role = 'admin'")
    .bind(orgId, userId)
    .first<OrgMemberRow>();

  return row !== null;
}
