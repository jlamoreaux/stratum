/**
 * The remote MCP endpoint (#349).
 *
 * Streamable HTTP, stateless. A client POSTs a JSON-RPC message and gets one
 * back; there is no session to establish, resume or expire, and no
 * `Mcp-Session-Id` to track. That is a real design choice rather than a
 * shortcut: the tools are all request/response calls into the REST API, none of
 * them streams or reports progress, and nothing a client does in one call
 * changes what the next one sees. Statelessness is what lets any Worker isolate
 * answer any request, which in turn is what makes this endpoint free to run at
 * every edge location instead of pinned to a Durable Object.
 *
 * If a future tool needs server-initiated messages — long-running evaluations
 * pushing progress, say — this is where an SSE stream and a session id would
 * be added, and the `GET` handler below is where the spec expects them.
 */
import { Hono } from "hono";
import { StratumClient } from "../mcp/client";
import { dispatchApiRequest } from "../mcp/dispatch";
import {
  JSON_RPC,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  rpcError,
} from "../mcp/protocol";
import { buildTools } from "../mcp/tools";
import type { Env } from "../types";
import { getExecutionCtx } from "../utils/execution-ctx";
import { createLogger } from "../utils/logger";
import { buildAuthenticateChallenge } from "../utils/oauth-challenge";
import { payloadTooLarge } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

/** Reported in the `initialize` handshake. Tracks the Worker's own version so
 * a client's server-version log line means something. */
const SERVER_VERSION = "0.2.0";

/**
 * Cap on a single JSON-RPC body.
 *
 * Generous, because `stratum_commit` legitimately carries file contents and the
 * API behind it accepts up to 25 MB. Read as text rather than through
 * `readJsonWithLimit` because a JSON-RPC parse failure has to come back as a
 * JSON-RPC error object (-32700), not as this codebase's `{error, code}` shape,
 * which an MCP client cannot interpret.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Answer an unauthenticated request with the challenge that starts the OAuth
 * flow. This 401 is the entire bootstrap: a client that has never seen this
 * instance discovers the authorization server from the header and registers
 * itself, with nothing configured in advance. */
function unauthenticated(url: string, description: string): Response {
  return Response.json(
    // Shaped as a JSON-RPC error as well as an HTTP 401, so a client that
    // routes the body to its RPC layer before checking the status still gets
    // something it can report rather than a parse failure.
    rpcError(null, JSON_RPC.INVALID_REQUEST, description),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": buildAuthenticateChallenge(url, "invalid_token", description),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Reject a protocol version we do not speak.
 *
 * The header is optional — clients that negotiated during `initialize` may omit
 * it — so only an explicitly WRONG value is refused. Treating an absent header
 * as a violation would break every client that follows the older revision,
 * where the header does not exist at all.
 */
function unsupportedProtocol(header: string | undefined): Response | null {
  if (header === undefined) return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === header)) return null;
  return Response.json(
    rpcError(
      null,
      JSON_RPC.INVALID_REQUEST,
      `Unsupported MCP protocol version '${header}'. This server speaks: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    ),
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

app.post("/mcp", async (c) => {
  const logger = createLogger({
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
    oauthClientId: c.get("oauthClientId"),
  });

  // `authMiddleware` has already resolved (or rejected) the credential. What is
  // left is the authorization question: MCP has no anonymous mode, so a request
  // that arrived with no credential at all is answered with the challenge that
  // bootstraps OAuth rather than with a bare 401.
  const authorization = c.req.header("Authorization");
  if (authorization === undefined) {
    return unauthenticated(c.req.url, "Authentication required to use the Stratum MCP server");
  }
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  if (userId === undefined && agentId === undefined) {
    return unauthenticated(c.req.url, "The presented credential is not valid");
  }

  const versionProblem = unsupportedProtocol(c.req.header("Mcp-Protocol-Version"));
  if (versionProblem !== null) return versionProblem;

  const declaredLength = c.req.header("content-length");
  if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) {
    return payloadTooLarge(`request body too large (max ${MAX_BODY_BYTES} bytes)`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await c.req.text());
  } catch {
    return Response.json(rpcError(null, JSON_RPC.PARSE_ERROR, "Request body is not valid JSON"), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The credential is replayed verbatim rather than re-minted, so every tool
  // call is authorized as the caller by the real middleware. See dispatch.ts.
  const client = new StratumClient(new URL(c.req.url).origin, authorization, (request) =>
    dispatchApiRequest(request, c.env, getExecutionCtx(c)),
  );
  const ctx = { tools: buildTools(client), serverVersion: SERVER_VERSION };

  // A batch is a JSON array. Dropped from the 2025-06-18 revision but still
  // sent by clients on the two older ones we accept, so it is handled rather
  // than refused. Notifications contribute no reply, and a batch of only
  // notifications correctly produces an empty 202 instead of `[]`.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return Response.json(rpcError(null, JSON_RPC.INVALID_REQUEST, "Empty batch"), {
        status: 400,
      });
    }
    // Sequential, not `Promise.all`: these calls hit D1 and the git layer, and
    // a model that batches twenty commits should not get twenty concurrent
    // writers racing inside one isolate.
    const replies = [];
    for (const message of parsed) {
      const reply = await handleMessage(message, ctx);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(replies, { headers: { "Cache-Control": "no-store" } });
  }

  const reply = await handleMessage(parsed, ctx);
  // A notification gets no body. 202 Accepted is what the spec prescribes, and
  // it is distinguishable from a 200 with an empty body, which some clients
  // treat as a truncated response.
  if (reply === null) return new Response(null, { status: 202 });

  logger.debug("MCP message handled", {
    method:
      typeof parsed === "object" && parsed !== null
        ? (parsed as { method?: unknown }).method
        : undefined,
  });

  return Response.json(reply, {
    headers: {
      "Cache-Control": "no-store",
      "Mcp-Protocol-Version": c.req.header("Mcp-Protocol-Version") ?? LATEST_PROTOCOL_VERSION,
    },
  });
});

/**
 * The spec's server-to-client stream. This server never initiates a message, so
 * there is nothing to stream; 405 is the prescribed answer and clients treat it
 * as "no server-initiated messages here" rather than as a failure.
 *
 * Answered before the auth check on purpose: the response is identical for
 * every caller, so requiring a credential to learn it would only make clients
 * run the OAuth flow to be told the same thing.
 */
app.get("/mcp", () =>
  Response.json(
    rpcError(
      null,
      JSON_RPC.METHOD_NOT_FOUND,
      "This server does not offer a server-initiated stream",
    ),
    { status: 405, headers: { Allow: "POST, DELETE" } },
  ),
);

/** Session teardown. There is no session to tear down, so this succeeds
 * unconditionally — a client that tidies up on exit should not see an error for
 * doing the right thing. */
app.delete("/mcp", () => new Response(null, { status: 204 }));

export { app as mcpRouter };
