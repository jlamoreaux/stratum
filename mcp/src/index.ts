#!/usr/bin/env node
/**
 * stratum-mcp — MCP server exposing Stratum's eval-gated change flow over
 * stdio, so any MCP-capable agent or editor (Claude Code, Cursor, Zed,
 * Copilot, …) can work against a Stratum instance.
 *
 * Configuration (env):
 *   STRATUM_API_KEY  required — user or agent API token
 *   STRATUM_HOST     optional — defaults to https://app.usestratum.dev
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StratumClient } from "./client.js";
import { buildTools } from "./tools.js";

// Read the version from the manifest so the initialize handshake can't drift
// from package.json on a version bump. Works from both dist/ and src/ — the
// manifest sits one directory up from either.
const VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
const DEFAULT_HOST = "https://app.usestratum.dev";

// The API key travels in an Authorization header on every request, so a
// non-HTTPS host would leak it in cleartext. Plaintext is allowed only for
// loopback development hosts.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateHost(host: string): string {
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    console.error(`stratum-mcp: STRATUM_HOST is not a valid URL: ${host}`);
    process.exit(1);
  }
  if (parsed.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    console.error(
      `stratum-mcp: STRATUM_HOST must use https (got ${parsed.protocol}//) — the API key would travel in cleartext.`,
    );
    process.exit(1);
  }
  return host;
}

async function main(): Promise<void> {
  const apiKey = process.env.STRATUM_API_KEY;
  if (!apiKey) {
    console.error(
      "stratum-mcp: STRATUM_API_KEY is not set. Create a token in Stratum → Settings → API tokens and export it.",
    );
    process.exit(1);
  }
  const host = validateHost(process.env.STRATUM_HOST ?? DEFAULT_HOST);

  const client = new StratumClient(host, apiKey);
  const server = new McpServer({ name: "stratum", version: VERSION });

  for (const t of buildTools(client)) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.schema },
      (args: Record<string, unknown>) => t.handler(args),
    );
  }

  await server.connect(new StdioServerTransport());
  console.error(`stratum-mcp ${VERSION} connected (host: ${host})`);
}

main().catch((error: unknown) => {
  console.error("stratum-mcp fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
