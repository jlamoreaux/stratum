/**
 * The running server version.
 *
 * Duplicated from `package.json` rather than imported: pulling JSON into the
 * Worker bundle would need `resolveJsonModule` and would ship the whole
 * manifest to the edge for one string. `tests/mcp-endpoint.test.ts` asserts the
 * two match, which is how this repo pins its other cross-file constants, so a
 * release bump that forgets this line fails CI rather than shipping a stale
 * version to every MCP client's log and every analytics event.
 */
export const STRATUM_VERSION = "0.2.0";
