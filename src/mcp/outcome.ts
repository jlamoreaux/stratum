/**
 * What to log about one MCP exchange (#355).
 *
 * The endpoint used to log a single debug line per message, which the default
 * info level suppressed, so a connector that connected and then failed every
 * tool call left no trace beyond auth-middleware warnings. This turns each
 * (message, reply) pair into a log entry at the level it deserves: the
 * handshake at info, because "Claude connected, speaking protocol X" is the
 * first thing an operator wants to see; a tool that ran and failed at warn,
 * with the tool name and the error the model was shown; everything routine at
 * debug.
 *
 * Kept as a pure function, separate from the transport-agnostic protocol
 * layer, so it is testable by handing it plain objects.
 */
import { type JsonRpcResponse, isJsonRpcRequest } from "./protocol";

export interface McpOutcome {
  level: "debug" | "info" | "warn";
  message: string;
  meta: Record<string, unknown>;
}

/** A non-empty string, or nothing; the client's self-description is untyped. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The first text block of a tool result, truncated. Tool failures put the
 * API's error message there, which is what an operator needs to see. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text.slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Classify one exchange for logging. `reply` is what `handleMessage` returned:
 * a response, or `null` for a notification.
 */
export function describeMcpOutcome(message: unknown, reply: JsonRpcResponse | null): McpOutcome {
  if (!isJsonRpcRequest(message)) {
    return { level: "warn", message: "MCP message rejected", meta: { reason: "not JSON-RPC" } };
  }
  const method = message.method;

  // A notification gets no reply and, for the request-style methods below,
  // runs nothing: `handleMessage` returns null for a `tools/call` with no id
  // without invoking the tool. Classifying by method first would log a tool
  // that never ran as a success, so notifications are settled before any
  // method-specific branch.
  if (reply === null) {
    return { level: "debug", message: "MCP notification handled", meta: { method } };
  }

  if (method === "initialize") {
    const params = (message.params ?? {}) as {
      protocolVersion?: unknown;
      clientInfo?: { name?: unknown; version?: unknown };
    };
    const result = reply.result as { protocolVersion?: unknown } | undefined;
    return {
      level: "info",
      message: "MCP client initialized",
      meta: {
        clientName: asString(params.clientInfo?.name),
        clientVersion: asString(params.clientInfo?.version),
        requestedProtocolVersion: asString(params.protocolVersion),
        protocolVersion: asString(result?.protocolVersion),
      },
    };
  }

  if (method === "tools/call") {
    const tool = asString((message.params as { name?: unknown } | undefined)?.name);
    if (reply.error !== undefined) {
      return {
        level: "warn",
        message: "MCP tool call rejected",
        meta: { tool, code: reply.error.code, error: reply.error.message },
      };
    }
    const result = reply.result as { isError?: unknown; content?: unknown } | undefined;
    if (result?.isError === true) {
      return {
        level: "warn",
        message: "MCP tool call failed",
        meta: { tool, detail: firstText(result.content) },
      };
    }
    return { level: "debug", message: "MCP tool call succeeded", meta: { tool } };
  }

  if (reply.error !== undefined) {
    return {
      level: "warn",
      message: "MCP request rejected",
      meta: { method, code: reply.error.code, error: reply.error.message },
    };
  }
  return { level: "debug", message: "MCP message handled", meta: { method } };
}
