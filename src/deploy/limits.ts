/**
 * Bounds on a single post-merge deployment.
 *
 * They live in their own module for the same reason `src/evaluation/limits.ts`
 * does: the provider targets, the runner, and (eventually) the queue's
 * `visibility_timeout_ms` all need the same numbers, and none of them should
 * have to import a provider implementation to get them.
 *
 * Every one of these is enforced **before the first provider request is
 * issued**. A deployment that uploads half a tree and then fails leaves the
 * site in a state no one asked for; a clean up-front rejection with a named
 * reason does not.
 */

/**
 * Most files one deployment may publish.
 *
 * The Worker holds the whole tree in memory while it uploads, so this is a
 * memory bound as much as a fairness one.
 */
export const MAX_FILES = 2_000;

/** Most bytes one deployment may publish, summed across every file. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Largest single file one deployment may publish.
 *
 * Below `MAX_TOTAL_BYTES` on purpose: one file must not be able to consume the
 * entire budget and starve the rest of the tree.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Most provider HTTP requests one deployment may issue.
 *
 * Cloudflare's own ceiling is the real limit — 10,000 per invocation on paid
 * plans since 2026-02-11, and only 50 external subrequests on the free plan.
 * This budget sits far below the paid ceiling because a deployment shares its
 * invocation with D1 reads, the git tree read, and the queue's own traffic,
 * and because `wrangler.toml` sets no `[limits]` block to raise it.
 *
 * It is deliberately just above `MAX_FILES + 2`: the Cloudflare static-asset
 * flow's worst case is one upload request per file plus a manifest
 * registration and a script deploy, so a tree that passes `MAX_FILES` can
 * never be rejected here for a reason the author cannot act on.
 *
 * A self-hoster on the Workers free plan will hit the platform's 50-subrequest
 * ceiling long before this one. That is a platform failure, not a limit this
 * module can enforce away.
 */
export const MAX_SUBREQUESTS = 2_048;

/**
 * Longest provider output persisted on a deployment row (`deployments.log_tail`).
 *
 * Redaction always runs on the full text *before* truncation to this length —
 * see `src/deploy/redact.ts`. Truncating first would let a secret survive by
 * straddling the cut.
 */
export const MAX_LOG_TAIL = 16_384;
