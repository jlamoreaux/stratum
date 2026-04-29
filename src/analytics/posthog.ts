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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          event: event.event,
          distinct_id: event.distinctId,
          properties: { $lib: 'stratum-server', ...event.properties },
        }),
      });
    } catch {
      // swallow
    }
  }
}

export function createPostHogClient(env: {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
}): PostHogClient {
  const disabled = env.STRATUM_TELEMETRY_DISABLED === 'true' || !env.POSTHOG_API_KEY;
  return new PostHogClient(
    env.POSTHOG_API_KEY ?? '',
    env.POSTHOG_HOST ?? 'https://app.posthog.com',
    disabled,
  );
}
