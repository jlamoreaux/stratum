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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StratumClient } from "./client.js";
import { buildTools } from "./tools.js";

const VERSION = "0.1.0";
const DEFAULT_HOST = "https://app.usestratum.dev";

async function main(): Promise<void> {
  const apiKey = process.env.STRATUM_API_KEY;
  if (!apiKey) {
    console.error(
      "stratum-mcp: STRATUM_API_KEY is not set. Create a token in Stratum → Settings → API tokens and export it.",
    );
    process.exit(1);
  }
  const host = process.env.STRATUM_HOST ?? DEFAULT_HOST;

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
