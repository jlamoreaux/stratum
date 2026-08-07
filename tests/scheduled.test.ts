import { describe, expect, it } from "vitest";
import { jobsForCron, runScheduledJobs } from "../src/scheduled";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

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
  it("registers one waitUntil per job for the cron", () => {
    const scheduled: Promise<unknown>[] = [];
    // Empty deps: the 0 4 branch only calls runBackup, which we don't await here —
    // we assert the dispatch registers exactly one promise, not the job's result.
    runScheduledJobs("0 4 * * *", {} as Env, {} as Logger, (p) => {
      scheduled.push(p);
      // swallow the (expected) rejection from running against an empty env
      p.catch(() => {});
    });
    expect(scheduled).toHaveLength(1);
  });

  it("registers nothing for an unknown cron", () => {
    const scheduled: Promise<unknown>[] = [];
    runScheduledJobs("@bogus", {} as Env, {} as Logger, (p) => scheduled.push(p));
    expect(scheduled).toHaveLength(0);
  });
});
