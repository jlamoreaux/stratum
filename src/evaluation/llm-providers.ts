/**
 * The operator's LLM provider allowlist, parsed from the `LLM_PROVIDERS` var.
 *
 * This is the **only** place a provider endpoint may be named. A project's
 * `.stratum/policy.yaml` may SELECT one of these by name and can never supply a
 * `baseUrl` (PRD §7): a base URL a repository's own policy chose would turn the
 * operator's Worker into a request-forgery primitive aimed at whatever host the
 * policy names, and the prompt it would receive contains the diff.
 *
 * Every URL rule below is checked once, here, at parse time — not per request.
 * Per-request checking would re-validate an immutable value on the hot path and,
 * worse, would mean a bad entry is discovered by the first project unlucky
 * enough to select it rather than by the operator who wrote it.
 */
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/**
 * Wire protocols the evaluator can speak, one per HTTP implementation in
 * `llm-provider.ts`. A third kind needs a class before it can be a value here.
 */
export const LLM_PROVIDER_KINDS = ["anthropic", "openai-compatible"] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

const KIND_SET = new Set<string>(LLM_PROVIDER_KINDS);

/** One operator-configured provider. Credentials are deliberately absent: they
 * live per project in `project_secrets`, never in an environment variable that
 * every project's policy can select. */
export interface ConfiguredLlmProvider {
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
}

/** Provider name to definition. Empty means "Workers AI only" — the default. */
export type LlmProviderCatalog = ReadonlyMap<string, ConfiguredLlmProvider>;

/** Parsing either yields a catalog or says why the operator's config is unusable. */
export type LlmProvidersParse =
  | { status: "ok"; providers: LlmProviderCatalog }
  | { status: "invalid"; reason: string };

/** Fields an `LLM_PROVIDERS` entry may carry. */
const ENTRY_KEYS = new Set(["name", "kind", "baseUrl"]);

/**
 * Provider names are as narrow as deploy names, and for the same reason: a
 * policy file selects one by name, and the name is echoed into log lines,
 * evaluation reasons, and the derived secret name.
 */
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Enough for every provider one instance realistically fronts; bounds the parse. */
const MAX_PROVIDERS = 16;

const EMPTY_CATALOG: LlmProviderCatalog = new Map();

/**
 * The `project_secrets` name holding this provider's credential.
 *
 * Derived rather than configured so an entry cannot name an arbitrary secret:
 * `LLM_PROVIDERS` is operator config, but making the secret *name* configurable
 * would let one provider entry read a credential a project stored for something
 * else entirely. `PROVIDER_NAME_PATTERN` guarantees the result matches
 * `SECRET_NAME_PATTERN` (`^[A-Z][A-Z0-9_]{0,63}$`) — an uppercased 32-char
 * name plus the suffix is 40.
 */
export function providerSecretName(providerName: string): string {
  return `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Why this host must not be fetched, or null when it is fine.
 *
 * Loopback, link-local and RFC1918 addresses are the ones that turn an outbound
 * fetch into a read of something only the Worker's own network can see. The
 * WHATWG URL parser normalizes IPv4 for special schemes, so the obfuscated
 * spellings (`0x7f.0.0.1`, `2130706433`) arrive here already in dotted-quad
 * form and are caught by the same rules.
 *
 * **Known limit:** this is an address check, not a resolution check. A public
 * DNS name that resolves to 127.0.0.1 defeats it, and nothing at parse time can
 * see that. It is defence in depth — the actual control is that only the
 * operator writes this variable, and that a policy file can never add to it.
 */
export function blockedHostReason(hostname: string): string | null {
  // A trailing dot is the same name to a resolver; lowercase for the literals.
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) {
    return "'localhost' names the loopback interface";
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (inner === "::1") return "[::1] is the IPv6 loopback address";
    if (inner === "::" || inner === "::0") return "[::] is the IPv6 unspecified address";
    if (inner.startsWith("fe80")) return `${host} is an IPv6 link-local address`;
    // fc00::/7 — unique local, the IPv6 equivalent of RFC1918.
    if (/^f[cd]/.test(inner)) return `${host} is an IPv6 unique-local address`;
    // An IPv4-mapped address exists only to reach an IPv4 host through an IPv6
    // socket; an operator has no reason to write one, and each spelling
    // (dotted-quad tail, hex tail) would need its own check to be safe.
    if (inner.includes("::ffff:")) return `${host} is an IPv4-mapped IPv6 address`;
    return null;
  }

  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return null;
  const [a, b] = [Number(quad[1]), Number(quad[2])];

  if (a === 127) return `${host} is in the loopback range 127.0.0.0/8`;
  if (a === 0) return `${host} is in the unspecified range 0.0.0.0/8`;
  if (a === 169 && b === 254) return `${host} is in the link-local range 169.254.0.0/16`;
  if (a === 10) return `${host} is in the private range 10.0.0.0/8`;
  if (a === 172 && b >= 16 && b <= 31) return `${host} is in the private range 172.16.0.0/12`;
  if (a === 192 && b === 168) return `${host} is in the private range 192.168.0.0/16`;
  return null;
}

function baseUrlError(name: string, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return `provider "${name}": "baseUrl" is required and must be a string`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `provider "${name}": "baseUrl" is not a valid absolute URL`;
  }

  if (url.protocol !== "https:") {
    // Not tidiness: the request carries the project's API key and the diff.
    return `provider "${name}": "baseUrl" must use https, not ${url.protocol.replace(":", "")}`;
  }
  if (url.username !== "" || url.password !== "") {
    return `provider "${name}": "baseUrl" must not embed credentials`;
  }
  if (url.search !== "" || url.hash !== "") {
    return `provider "${name}": "baseUrl" must not carry a query string or fragment`;
  }
  const blocked = blockedHostReason(url.hostname);
  if (blocked) {
    return `provider "${name}": "baseUrl" host is not reachable from an allowlist — ${blocked}`;
  }
  return null;
}

/**
 * Parse `LLM_PROVIDERS`, rejecting the whole document on the first problem.
 *
 * All-or-nothing rather than "keep the entries that parsed", because a
 * half-applied allowlist is the failure this is meant to prevent: an operator
 * who typo'd one entry would get merges blocked on the projects selecting it
 * with nothing anywhere saying why. One rejection with a reason is louder, and
 * `llmProvidersConfigError` puts it in the logs on the first request after a
 * bad deploy.
 *
 * An unset (or blank) value is not an error — it is the default, and it means
 * Workers AI only.
 */
export function parseLlmProviders(raw: string | undefined): LlmProvidersParse {
  if (raw === undefined || raw.trim() === "") return { status: "ok", providers: EMPTY_CATALOG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      reason: `LLM_PROVIDERS is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { status: "invalid", reason: "LLM_PROVIDERS must be a JSON array of provider objects" };
  }
  if (parsed.length > MAX_PROVIDERS) {
    return {
      status: "invalid",
      reason: `LLM_PROVIDERS declares ${parsed.length} providers; at most ${MAX_PROVIDERS} are allowed`,
    };
  }

  const providers = new Map<string, ConfiguredLlmProvider>();

  for (const [index, entry] of parsed.entries()) {
    const at = `LLM_PROVIDERS[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { status: "invalid", reason: `${at} must be an object` };
    }
    const source = entry as Record<string, unknown>;

    const unknownKeys = Object.keys(source).filter((key) => !ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
      // Rejected rather than ignored: a misspelled key here is silently
      // dropped configuration on a security boundary, and `baseURL` for
      // `baseUrl` is exactly the typo an operator would not notice.
      return {
        status: "invalid",
        reason: `${at} has unrecognized field(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")}`,
      };
    }

    if (typeof source.name !== "string" || !PROVIDER_NAME_PATTERN.test(source.name)) {
      return {
        status: "invalid",
        reason: `${at}: "name" must match ${PROVIDER_NAME_PATTERN.source} (lowercase letters, digits and dashes, max 32 chars)`,
      };
    }
    const name = source.name;
    if (providers.has(name)) {
      return { status: "invalid", reason: `${at}: duplicate provider name "${name}"` };
    }

    if (typeof source.kind !== "string" || !KIND_SET.has(source.kind)) {
      return {
        status: "invalid",
        reason: `provider "${name}": "kind" must be one of ${LLM_PROVIDER_KINDS.join(", ")}`,
      };
    }

    const urlProblem = baseUrlError(name, source.baseUrl);
    if (urlProblem) return { status: "invalid", reason: urlProblem };

    providers.set(name, {
      name,
      kind: source.kind as LlmProviderKind,
      // Trailing slashes are stripped by the provider classes when they build a
      // path; store what the operator wrote.
      baseUrl: source.baseUrl as string,
    });
  }

  return { status: "ok", providers };
}

/**
 * The parse memoized for the isolate's lifetime, keyed on the raw value so a
 * test (or a rebind) that changes it is not served a stale catalog.
 */
let cached: { raw: string | undefined; parse: LlmProvidersParse } | null = null;

/** Drop the memoized parse. Exists for tests; production rebinds per isolate. */
export function resetLlmProviderCache(): void {
  cached = null;
}

function parseCached(raw: string | undefined): LlmProvidersParse {
  if (cached === null || cached.raw !== raw) cached = { raw, parse: parseLlmProviders(raw) };
  return cached.parse;
}

/**
 * The catalog for this environment, or an empty one when the config is unusable.
 *
 * Empty-on-invalid is the fail-closed direction, not a silent disable: an empty
 * catalog means every policy naming a provider is rejected by
 * `sanitizeLlmConfig` and blocks merges with a reason naming the provider, while
 * projects on Workers AI — which is every project that never opted into BYOK —
 * are untouched by an operator's typo. The typo itself is reported by
 * `llmProvidersConfigError` and logged here on the isolate's first parse.
 */
export function llmProviderCatalog(
  env: Pick<Env, "LLM_PROVIDERS">,
  logger?: Logger,
): LlmProviderCatalog {
  const hadCache = cached !== null && cached.raw === env.LLM_PROVIDERS;
  const parse = parseCached(env.LLM_PROVIDERS);
  if (parse.status === "invalid") {
    if (!hadCache) {
      logger?.error("LLM_PROVIDERS is invalid; BYOK providers are unavailable", undefined, {
        reason: parse.reason,
      });
    }
    return EMPTY_CATALOG;
  }
  return parse.providers;
}
