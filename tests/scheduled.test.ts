import { describe, expect, it } from "vitest";
import { type JobRunners, jobsForCron, runScheduledJobs } from "../src/scheduled";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Stub runners that resolve immediately, so the dispatch is exercised without
// executing (and failing) the real backup/sync/sweep jobs against a mock env.
const noopRunners: JobRunners = {
  "event-sweep": () => Promise.resolve(),
  "deletion-sweep": () => Promise.resolve(),
  backup: () => Promise.resolve(),
  "ttl-sweep": () => Promise.resolve(),
  "project-sync": () => Promise.resolve(),
};

describe("jobsForCron", () => {
  it("runs the backup ALONE on its dedicated 0 4 trigger", () => {
    // The whole point of F9: backup must not share a cron with project-sync,
    // whose slowness could starve the DR-critical backup's invocation budget.
    expect(jobsForCron("0 4 * * *")).toEqual(["backup"]);
  });

  it("runs housekeeping (no backup) on the 0 6 trigger", () => {
    const jobs = jobsForCron("0 6 * * *");
    expect(jobs).toEqual(["ttl-sweep", "project-sync"]);
    expect(jobs).not.toContain("backup");
  });

  it("runs the event + deletion sweeps on the */5 trigger", () => {
    expect(jobsForCron("*/5 * * * *")).toEqual(["event-sweep", "deletion-sweep"]);
  });

  it("returns nothing for an unknown cron", () => {
    expect(jobsForCron("0 0 1 1 *")).toEqual([]);
  });
});

describe("runScheduledJobs", () => {
  function collect(cron: string): Promise<unknown>[] {
    const scheduled: Promise<unknown>[] = [];
    runScheduledJobs(cron, {} as Env, {} as Logger, (p) => scheduled.push(p), noopRunners);
    return scheduled;
  }

  it("registers one waitUntil for the backup-only cron", () => {
    expect(collect("0 4 * * *")).toHaveLength(1);
  });

  it("registers a SEPARATE waitUntil per job (not one batched Promise.all)", () => {
    // The 06:00 cron has two jobs; each must be its own waitUntil so one failing
    // job can't reject the other — a single Promise.all would show up as length 1.
    expect(collect("0 6 * * *")).toHaveLength(2);
  });

  it("registers nothing for an unknown cron", () => {
    expect(collect("@bogus")).toHaveLength(0);
  });
});
