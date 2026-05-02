import type { User } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { newId } from "../utils/ids";

export interface CreateUserResult {
  user: User;
  plaintext: string;
}

interface UserRow {
  id: string;
  email: string;
  github_id: string | null;
  github_username: string | null;
  github_access_token: string | null;
  token_hash: string;
  created_at: string;
}

function rowToUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    email: row.email,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
  if (row.github_id !== null) user.githubId = row.github_id;
  if (row.github_username !== null) user.githubUsername = row.github_username;
  return user;
}

export async function createUser(db: D1Database, email: string): Promise<CreateUserResult> {
  const id = newId("usr");
  const plaintext = await generateApiKey("stratum_user");
  const tokenHash = await hashToken(plaintext);

  await db
    .prepare("INSERT INTO users (id, email, token_hash) VALUES (?, ?, ?)")
    .bind(id, email, tokenHash)
    .run();

  const user: User = {
    id,
    email,
    tokenHash,
    createdAt: new Date().toISOString(),
  };

  return { user, plaintext };
}

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();

  return row ? rowToUser(row) : null;
}

export async function getUserByToken(db: D1Database, plaintext: string): Promise<User | null> {
  const tokenHash = await hashToken(plaintext);
  const row = await db
    .prepare("SELECT * FROM users WHERE token_hash = ?")
    .bind(tokenHash)
    .first<UserRow>();

  return row ? rowToUser(row) : null;
}

export async function getUserByGitHubId(db: D1Database, githubId: string): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE github_id = ?")
    .bind(githubId)
    .first<UserRow>();

  return row ? rowToUser(row) : null;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();

  return row ? rowToUser(row) : null;
}

export async function linkGitHub(
  db: D1Database,
  userId: string,
  githubId: string,
  username: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET github_id = ?, github_username = ? WHERE id = ?")
    .bind(githubId, username, userId)
    .run();
}

export async function upsertGitHubUser(
  db: D1Database,
  opts: { githubId: string; email: string; username: string },
): Promise<User> {
  const byGitHubId = await getUserByGitHubId(db, opts.githubId);
  if (byGitHubId) {
    return byGitHubId;
  }

  const byEmail = await getUserByEmail(db, opts.email);
  if (byEmail) {
    await linkGitHub(db, byEmail.id, opts.githubId, opts.username);
    const updated = await getUser(db, byEmail.id);
    if (!updated) throw new Error(`User ${byEmail.id} not found after linkGitHub`);
    return updated;
  }

  const { user } = await createUser(db, opts.email);
  await linkGitHub(db, user.id, opts.githubId, opts.username);
  const linked = await getUser(db, user.id);
  if (!linked) throw new Error(`User ${user.id} not found after createUser`);
  return linked;
}

export async function setGitHubAccessToken(
  db: D1Database,
  userId: string,
  token: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET github_access_token = ? WHERE id = ?")
    .bind(token, userId)
    .run();
}

export async function getGitHubAccessToken(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT github_access_token FROM users WHERE id = ?")
    .bind(userId)
    .first<{ github_access_token: string | null }>();
  return row?.github_access_token ?? null;
}
