import type { EvalResult, EvalPolicy, Evaluator } from './types';

async function computeHmacSha256(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class WebhookEvaluator implements Evaluator {
  async evaluate(diff: string, policy: EvalPolicy): Promise<EvalResult> {
    const config = policy.evaluators.find((e) => e.type === 'webhook');
    if (!config || config.type !== 'webhook') {
      return { score: 0, passed: false, reason: 'Webhook: no configuration found.' };
    }

    const timeoutMs = config.timeoutMs ?? 10000;
    const body = JSON.stringify({ diff, policy });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (config.secret) {
      const hex = await computeHmacSha256(config.secret, body);
      headers['X-Stratum-Signature'] = `sha256=${hex}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        return { score: 0, passed: false, reason: `Webhook failed: HTTP ${response.status}` };
      }

      const json = await response.json() as { score: number; passed: boolean; reason: string };
      return { score: json.score, passed: json.passed, reason: json.reason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { score: 0, passed: false, reason: `Webhook failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
