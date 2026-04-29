const SLUG_RE = /^[\w-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value);
}

export function isValidGitHubUrl(value: unknown): value is string {
  return typeof value === "string" && GITHUB_URL_RE.test(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
