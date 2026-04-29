import { Hono } from "hono";
import { projectsRouter } from "./routes/projects";
import { workspacesRouter } from "./routes/workspaces";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", service: "stratum" }));

app.route("/api/projects", projectsRouter);
app.route("/api/workspaces", workspacesRouter);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(`[stratum] ${c.req.method} ${c.req.path} — ${err.message}`);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
