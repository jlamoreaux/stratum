import { Hono } from "hono";
import { analyticsMiddleware } from "./middleware/analytics";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import type { StratumEvent } from "./queue/events";
import { runTtlSweep } from "./queue/ttl-sweep";
import { agentsRouter } from "./routes/agents";
import { authRouter } from "./routes/auth";
import { changesRouter } from "./routes/changes";
import { emailAuthRouter } from "./routes/email-auth";
import { orgsRouter } from "./routes/orgs";
import { projectsRouter } from "./routes/projects";
import { syncAllProjects, syncRouter } from "./routes/sync";
import { uiRouter } from "./routes/ui";
import { usersRouter } from "./routes/users";
import { workspacesRouter } from "./routes/workspaces";
import type { Env, MessageBatch } from "./types";
import { CSS } from "./ui/styles";
export { MergeQueue } from "./queue/merge-queue";

const app = new Hono<{ Bindings: Env }>();

app.use("*", analyticsMiddleware);
app.use("*", authMiddleware);
app.use("*", rateLimitMiddleware());

app.get("/health", (c) => c.json({ status: "ok", service: "stratum" }));

app.get("/", (c) => c.redirect("/ui"));

app.get("/ui.css", (c) => {
  return c.text(CSS, 200, { "Content-Type": "text/css; charset=UTF-8" });
});

app.route("/auth", authRouter);
app.route("/auth/email", emailAuthRouter);
app.route("/ui", uiRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/workspaces", workspacesRouter);
app.route("/api/users", usersRouter);
app.route("/api/agents", agentsRouter);
app.route("/api", changesRouter);
app.route("/api/orgs", orgsRouter);
app.route("/api", syncRouter);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(`[stratum] ${c.req.method} ${c.req.path} — ${err.message}`);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([runTtlSweep(env), syncAllProjects(env)]));
  },
  async queue(batch: MessageBatch<StratumEvent>, _env: Env): Promise<void> {
    for (const msg of batch.messages) {
      console.log(`[event] ${msg.body.type}`, msg.body);
      msg.ack();
    }
  },
};
