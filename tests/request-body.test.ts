import { describe, expect, it } from "vitest";
import { readJsonWithLimit } from "../src/utils/request-body";

function ctxFor(request: Request) {
  return {
    req: {
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
  };
}

/** A stream that yields the given chunks one at a time via `pull`. */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function requestWithStream(chunks: Uint8Array[], opts: { contentLength?: number } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  }
  return new Request("http://localhost/test", {
    method: "POST",
    headers,
    body: streamFromChunks(chunks),
    // Node's fetch requires this for a streaming request body.
    duplex: "half",
  } as RequestInit);
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("readJsonWithLimit", () => {
  it("rejects a declared Content-Length over the cap with 413, without ever reading the stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc('{"a":1}'));
        controller.close();
      },
    });
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const result = await readJsonWithLimit(ctxFor(req), 100);

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(413);
    // getReader() locks the stream — the fast Content-Length path must never
    // acquire a reader at all, so the underlying stream stays unlocked.
    expect(req.body?.locked).toBe(false);
  });

  it("caps a body with NO Content-Length while streaming, and never parses it", async () => {
    // Well over the 10-byte cap, and not valid JSON — if the parse ran anyway
    // it would throw a SyntaxError instead of resolving to a 413 Response.
    const chunks = [enc("x".repeat(30)), enc("NOT VALID JSON")];
    const req = requestWithStream(chunks);
    expect(req.headers.get("content-length")).toBeNull();

    const result = await readJsonWithLimit(ctxFor(req), 10);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("does not trust an understated Content-Length — the streaming cap still catches an actually-oversized body", async () => {
    const chunks = [enc("x".repeat(1000))];
    const req = requestWithStream(chunks, { contentLength: 5 }); // lies small
    const result = await readJsonWithLimit(ctxFor(req), 10);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("the 413 response uses the repo's standard error shape and a PAYLOAD_TOO_LARGE code", async () => {
    const chunks = [enc("x".repeat(50))];
    const req = requestWithStream(chunks, { contentLength: 50 });
    const result = await readJsonWithLimit(ctxFor(req), 10);

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual({ error: expect.any(String), code: "PAYLOAD_TOO_LARGE" });
  });

  it("parses a body right at the cap", async () => {
    const payload = JSON.stringify({ ok: true, pad: "y".repeat(50) });
    const bytes = enc(payload);
    const req = requestWithStream([bytes], { contentLength: bytes.byteLength });

    const result = await readJsonWithLimit<{ ok: boolean }>(ctxFor(req), bytes.byteLength);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a body one byte over a tight cap", async () => {
    const bytes = enc(JSON.stringify({ ok: true }));
    const req = requestWithStream([bytes], { contentLength: bytes.byteLength });

    const result = await readJsonWithLimit(ctxFor(req), bytes.byteLength - 1);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("still throws on malformed JSON within the cap, matching plain c.req.json() — callers that .catch() it keep that fallback", async () => {
    const bytes = enc("{not valid json");
    const req = requestWithStream([bytes], { contentLength: bytes.byteLength });

    await expect(readJsonWithLimit(ctxFor(req), 1024)).rejects.toThrow();
  });

  it("parses normally when there is no body-size concern at all", async () => {
    const bytes = enc(JSON.stringify({ hello: "world" }));
    const req = requestWithStream([bytes], { contentLength: bytes.byteLength });

    const result = await readJsonWithLimit<{ hello: string }>(ctxFor(req), 1024 * 1024);

    expect(result).toEqual({ hello: "world" });
  });
});
