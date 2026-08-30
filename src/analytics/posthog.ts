export interface PostHogEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, string | number | boolean>;
}

export class PostHogClient {
  constructor(
    private apiKey: string,
    private host: string,
    private disabled: boolean,
  ) {}

  async capture(event: PostHogEvent): Promise<void> {
    if (this.disabled || !this.apiKey) return;
    try {
      await fetch(`${this.host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          event: event.event,
          distinct_id: event.distinctId,
          properties: { $lib: "stratum-server", ...event.properties },
        }),
      });
    } catch {
      // swallow
    }
  }
}

/**
 * Build a PostHog client for this environment.
 *
 * Two independent gates govern export, and only ONE of them lives in here:
 *
 * - The **instance** switch (`STRATUM_TELEMETRY_DISABLED`) travels with the
 *   client, so every call site inherits it for free.
 * - The **per-user** opt-out (#257) does NOT. Each call site must consult the
 *   acting user's preference itself — `src/middleware/analytics.ts` reads it
 *   from the auth context, `src/queue/event-consumer.ts` looks it up.
 *
 * That asymmetry is exactly how the queue exporter shipped without an opt-out.
 * If you add a third `capture()` call site, gate it on the actor's preference
 * or you will reintroduce the same hole.
 */
export function createPostHogClient(env: {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
}): PostHogClient {
  const disabled = env.STRATUM_TELEMETRY_DISABLED === "true" || !env.POSTHOG_API_KEY;
  return new PostHogClient(
    env.POSTHOG_API_KEY ?? "",
    env.POSTHOG_HOST ?? "https://app.posthog.com",
    disabled,
  );
}
