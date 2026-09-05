import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsTracker,
  trackerForEventActor,
  trackerForSystem,
  trackerForUser,
} from "../src/analytics/tracker";
import type { EventRecord } from "../src/storage/events";
import type { Env } from "../src/types";
import { createLogger } from "../src/utils/logger";

vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));
vi.mock("../src/storage/agents", () => ({ getAgent: vi.fn() }));

import { getAgent } from "../src/storage/agents";
import { getUser } from "../src/storage/users";

interface Captured {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

function stubCapture(): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      captured.push(JSON.parse(init?.body as string) as Captured);
      return new Response("ok");
    }),
  );
  return captured;
}

const env = { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://ph.example.com" } as Env;
const logger = createLogger({ component: "test" });

const optedInUser = { id: "user_1", telemetryOptOut: false };
const optedOutUser = { id: "user_1", telemetryOptOut: true };

function makeEvent(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt_1",
    type: "change.merged",
    project: "acme/web",
    projectId: "prj_abc",
    actorType: "user",
    actorId: "user_1",
    payload: {},
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AnalyticsTracker — the instance gate", () => {
  it("sends nothing when the instance switch is set", async () => {
    const captured = stubCapture();
    await trackerForSystem({ ...env, STRATUM_TELEMETRY_DISABLED: "true" } as Env).capture(
      "background_job_completed",
      { job: "event-consumer", outcome: "failed" },
    );
    expect(captured).toHaveLength(0);
  });

  it("sends nothing when no API key is configured", async () => {
    const captured = stubCapture();
    await trackerForSystem({ POSTHOG_HOST: "https://ph.example.com" } as Env).capture(
      "background_job_completed",
      { job: "event-consumer", outcome: "failed" },
    );
    expect(captured).toHaveLength(0);
  });
});

describe("AnalyticsTracker — the per-user gate", () => {
  it("sends for a user who has not opted out", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: optedInUser } as never);

    const tracker = await trackerForUser(env, "user_1", logger);
    await tracker.capture("auth_completed", { kind: "signin", provider: "github" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.distinct_id).toBe("user_1");
    expect(captured[0]?.properties.kind).toBe("signin");
  });

  it("sends nothing for a user who opted out", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: optedOutUser } as never);

    const tracker = await trackerForUser(env, "user_1", logger);
    await tracker.capture("auth_completed", { kind: "signin", provider: "github" });

    expect(captured).toHaveLength(0);
  });

  // A privacy control that exports whenever D1 hiccups is not a privacy control.
  it("fails closed when the preference cannot be read", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({
      success: false,
      error: new Error("D1 unavailable"),
    } as never);

    const tracker = await trackerForUser(env, "user_1", logger);
    await tracker.capture("auth_completed", { kind: "signup", provider: "email" });

    expect(captured).toHaveLength(0);
  });
});

describe("trackerForEventActor", () => {
  it("honours the owner's choice for an agent-authored event", async () => {
    const captured = stubCapture();
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { id: "agent_1", ownerId: "user_1" },
    } as never);
    vi.mocked(getUser).mockResolvedValue({ success: true, data: optedOutUser } as never);

    const tracker = await trackerForEventActor(
      env,
      makeEvent({ actorType: "agent", actorId: "agent_1" }),
      logger,
    );
    await tracker.captureDomainEvent(makeEvent({ actorType: "agent", actorId: "agent_1" }));

    expect(captured).toHaveLength(0);
    // The owner was consulted, not the agent — routing through an agent must
    // not re-enable telemetry the owner switched off.
    expect(getUser).toHaveBeenCalledWith(env.DB, "user_1", logger);
  });

  it("attributes an agent event to the agent, not to its owner", async () => {
    const captured = stubCapture();
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { id: "agent_1", ownerId: "user_1" },
    } as never);
    vi.mocked(getUser).mockResolvedValue({ success: true, data: optedInUser } as never);

    const event = makeEvent({ actorType: "agent", actorId: "agent_1" });
    const tracker = await trackerForEventActor(env, event, logger);
    await tracker.captureDomainEvent(event);

    expect(captured[0]?.distinct_id).toBe("agent_1");
    expect(captured[0]?.properties.actor_type).toBe("agent");
  });

  it("fails closed when the agent lookup fails", async () => {
    const captured = stubCapture();
    vi.mocked(getAgent).mockResolvedValue({ success: false, error: new Error("gone") } as never);

    const event = makeEvent({ actorType: "agent", actorId: "agent_1" });
    await (await trackerForEventActor(env, event, logger)).captureDomainEvent(event);

    expect(captured).toHaveLength(0);
  });

  it("captures a system-authored event personless, with no lookup", async () => {
    const captured = stubCapture();
    const event = makeEvent({ actorType: "system", actorId: undefined });

    await (await trackerForEventActor(env, event, logger)).captureDomainEvent(event);

    expect(getUser).not.toHaveBeenCalled();
    expect(captured[0]?.distinct_id).toBe("system");
    expect(captured[0]?.properties.$process_person_profile).toBe(false);
  });
});

describe("AnalyticsTracker — event shape", () => {
  it("stamps the operator's environment label on every event", async () => {
    const captured = stubCapture();
    await trackerForSystem({ ...env, STRATUM_ENVIRONMENT: "staging" } as Env).capture(
      "background_job_completed",
      { job: "webhook-delivery", outcome: "succeeded" },
    );
    expect(captured[0]?.properties.environment).toBe("staging");
  });

  it("reports `unknown` rather than guessing when no label is set", async () => {
    const captured = stubCapture();
    await trackerForSystem(env).capture("background_job_completed", {
      job: "webhook-delivery",
      outcome: "succeeded",
    });
    expect(captured[0]?.properties.environment).toBe("unknown");
  });

  it("names a domain event `stratum.<type>` and sends the id, never the project name", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: optedInUser } as never);

    const event = makeEvent({ type: "change.evaluated", payload: { score: 0.9, passed: true } });
    await (await trackerForEventActor(env, event, logger)).captureDomainEvent(event);

    expect(captured[0]?.event).toBe("stratum.change.evaluated");
    expect(captured[0]?.properties.project_id).toBe("prj_abc");
    expect(captured[0]?.properties.score).toBe(0.9);
    expect(JSON.stringify(captured[0])).not.toContain("acme/web");
  });

  it("hands the capture to waitUntil when the runtime offers one", async () => {
    stubCapture();
    const waitUntil = vi.fn();
    await AnalyticsTracker.create(
      env,
      { distinctId: "user_1", kind: "user", optedOut: false, attributed: true },
      waitUntil,
    ).capture("error_occurred", { route: "/api/changes", method: "GET", error_type: "TypeError" });

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not schedule anything for a suppressed actor", async () => {
    stubCapture();
    const waitUntil = vi.fn();
    await AnalyticsTracker.create(
      env,
      { distinctId: "user_1", kind: "user", optedOut: true, attributed: true },
      waitUntil,
    ).capture("error_occurred", { route: "/api/changes", method: "GET", error_type: "TypeError" });

    expect(waitUntil).not.toHaveBeenCalled();
  });

  // Telemetry must never be able to fail a request or a queue handler.
  it("resolves rather than rejecting when the transport throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      trackerForSystem(env).capture("background_job_completed", {
        job: "event-consumer",
        outcome: "abandoned",
        attempts: 5,
      }),
    ).resolves.toBeUndefined();
  });
});
