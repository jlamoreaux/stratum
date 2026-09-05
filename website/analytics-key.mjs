/**
 * The single validator for `POSTHOG_PUBLIC_KEY` on the documentation site.
 *
 * Shared deliberately. The build bakes the key into the HTML and the Worker
 * gates the proxy on it, and when those two disagreed — `startsWith("phc_")`
 * against `^phc_[A-Za-z0-9]+$` — a value like `phc_bad-key` produced a site
 * that loaded the SDK and then had every one of its requests refused by its own
 * proxy. A deployment that looks enabled and silently sends nothing is the
 * failure this whole feature is built to avoid, so there is one function and
 * both paths call it.
 */
export function isPostHogProjectKey(value) {
  return /^phc_[A-Za-z0-9]+$/.test((value ?? "").trim());
}
