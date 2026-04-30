import { Hono } from "hono";
import {
  addOrgMember,
  createOrg,
  getOrgBySlug,
  isOrgAdmin,
  listOrgsForUser,
  removeOrgMember,
} from "../storage/orgs";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
} from "../storage/teams";
import type { Env } from "../types";
import { badRequest, created, notFound, ok } from "../utils/response";
import { isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{ name?: unknown; slug?: unknown }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name is required");
  }
  if (!isValidSlug(body.slug)) {
    return badRequest("slug must be a 1-64 char alphanumeric slug");
  }

  const org = await createOrg(c.env.DB, userId, body.name, body.slug);
  await addOrgMember(c.env.DB, org.id, userId, "admin");

  return created({ org });
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const orgs = await listOrgsForUser(c.env.DB, userId);
  return ok({ orgs });
});

app.get("/:slug", async (c) => {
  const { slug } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);
  return ok({ org });
});

app.post("/:slug/members", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ userId?: unknown; role?: unknown }>();
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  const role = body.role === "admin" ? "admin" : "member";

  await addOrgMember(c.env.DB, org.id, body.userId, role);
  return ok({ added: true, orgId: org.id, userId: body.userId, role });
});

app.delete("/:slug/members/:uid", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, uid } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  await removeOrgMember(c.env.DB, org.id, uid);
  return ok({ removed: true, orgId: org.id, userId: uid });
});

app.post("/:slug/teams", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ name?: unknown; slug?: unknown; permissions?: unknown }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name is required");
  }
  if (!isValidSlug(body.slug)) {
    return badRequest("slug must be a 1-64 char alphanumeric slug");
  }

  const validPerms = ["read", "write", "admin"] as const;
  const permissions =
    typeof body.permissions === "string" &&
    (validPerms as readonly string[]).includes(body.permissions)
      ? (body.permissions as "read" | "write" | "admin")
      : "read";

  const team = await createTeam(c.env.DB, org.id, body.name, body.slug, permissions);
  return created({ team });
});

app.get("/:slug/teams", async (c) => {
  const { slug } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const teams = await listTeams(c.env.DB, org.id);
  return ok({ teams });
});

app.delete("/:slug/teams/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  const team = await getTeam(c.env.DB, id);
  if (!team || team.orgId !== org.id) return notFound("Team", id);

  await deleteTeam(c.env.DB, id);
  return ok({ deleted: true, id });
});

app.post("/:slug/teams/:id/members", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  const team = await getTeam(c.env.DB, id);
  if (!team || team.orgId !== org.id) return notFound("Team", id);

  const body = await c.req.json<{ userId?: unknown }>();
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  await addTeamMember(c.env.DB, id, body.userId);
  return ok({ added: true, teamId: id, userId: body.userId });
});

app.delete("/:slug/teams/:id/members/:uid", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id, uid } = c.req.param();
  const org = await getOrgBySlug(c.env.DB, slug);
  if (!org) return notFound("Org", slug);

  const admin = await isOrgAdmin(c.env.DB, org.id, userId);
  if (!admin) return c.json({ error: "Forbidden" }, 403);

  const team = await getTeam(c.env.DB, id);
  if (!team || team.orgId !== org.id) return notFound("Team", id);

  await removeTeamMember(c.env.DB, id, uid);
  return ok({ removed: true, teamId: id, userId: uid });
});

export { app as orgsRouter };
