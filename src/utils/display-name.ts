/**
 * The display name: a free-form label shown in the header in place of the
 * username. Never an identifier, so nothing is keyed under it and it can
 * change at any time.
 */

/** Longest display name accepted; room for a full name, short enough for the header. */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * Collapse whitespace runs and drop control characters, then trim. The value
 * is rendered on every page, where a newline or a tab is only noise. An empty
 * result means "no display name" — the caller stores NULL for it.
 */
export function normalizeDisplayName(raw: string): string {
  return raw.replace(/[\p{Cc}\s]+/gu, " ").trim();
}
