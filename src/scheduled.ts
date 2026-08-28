import { runBackup } from "./backup/run-backup";
import { sweepDeletionJobs } from "./queue/deletion-runner";
import { sweepStaleEvents } from "./queue/event-consumer";
import { runTtlSweep } from "./queue/ttl-sweep";
import { syncAllProjects } from "./routes/sync";
import { purgeExpiredOidcStates } from "./storage/sso";
import type { Env } from "./types";
import type { Logger } from "./utils/logger";

export type ScheduledJob =
  | "event-sweep"
  | "deletion-sweep"
  | "backup"
  | "ttl-sweep"
  | "project-sync"
  | "oidc-state-purge";

/**
 * Cron → jobs routing. Backup runs on its OWN trigger (`0 4 * * *`), isolated
 * from the 06:00 housekeeping: a single Worker invocation has a ~15-minute
 * wall-clock budget, and a slow `project-sync` sharing that budget could starve
 * or truncate the DR-critical backup. Keeping them on separate crons gives each
 * the full invocation budget.
 */
export function jobsForCron(cron: string): ScheduledJob[] {
  switch (cron) {
    case "*/5 * * * *":
      return ["event-sweep", "deletion-sweep"];
    case "0 4 * * *":
      return ["backup"];
    case "0 6 * * *":
      return ["ttl-sweep", "project-sync", "oidc-state-purge"];
    default:
      return [];
  }
}

export type JobRunners = Record<ScheduledJob, (env: Env, logger: Logger) => Promise<unknown>>;

const JOB_RUNNERS: JobRunners = {
  "event-sweep": (env, logger) => sweepStaleEvents(env, logger),
  "deletion-sweep": (env, logger) => sweepDeletionJobs(env, logger),
  backup: (env, logger) => runBackup(env, logger, new Date().toISOString()),
  "ttl-sweep": (env, logger) => runTtlSweep(env, logger),
  "project-sync": (env) => syncAllProjects(env),
  "oidc-state-purge": (env, logger) => purgeExpiredOidcStates(env.DB, logger),
};

/**
 * Dispatch the jobs for a cron event. Each job is registered independently with
 * `waitUntil` (rather than a single `Promise.all`) so one failing job cannot
 * reject the others. `waitUntil` and `runners` are injected so this stays
 * unit-testable without executing the real jobs.
 */
export function runScheduledJobs(
  cron: string,
  env: Env,
  logger: Logger,
  waitUntil: (promise: Promise<unknown>) => void,
  runners: JobRunners = JOB_RUNNERS,
): void {
  for (const job of jobsForCron(cron)) {
    waitUntil(runners[job](env, logger));
  }
}
