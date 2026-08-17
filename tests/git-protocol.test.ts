import { describe, expect, it } from "vitest";
import {
  FLUSH_PKT,
  buildReportStatus,
  encodePktLine,
  encodeSideband,
  parseReceivePackRequest,
  wantsSideband,
} from "../src/utils/git-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function pktLine(payload: string): Uint8Array {
  const data = encoder.encode(payload);
  const header = encoder.encode((data.byteLength + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(data.byteLength + 4);
  out.set(header, 0);
  out.set(data, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("encodePktLine", () => {
  it("frames a payload with a self-inclusive hex length", () => {
    const line = encodePktLine("unpack ok\n");
    // "unpack ok\n" is 10 bytes; 10 + 4 = 14 = 0x000e.
    expect(decoder.decode(line)).toBe("000eunpack ok\n");
  });

  it("rejects payloads beyond the pkt-line maximum", () => {
    expect(() => encodePktLine("x".repeat(0x10000))).toThrow(RangeError);
  });
});

describe("parseReceivePackRequest", () => {
  it("parses a single command with capabilities after NUL", () => {
    const body = concat(
      pktLine(`${OID_A} ${OID_B} refs/heads/main\0report-status side-band-64k agent=git/2.44`),
      FLUSH_PKT,
      encoder.encode("PACKdata-not-parsed"),
    );
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toEqual([
        { oldOid: OID_A, newOid: OID_B, ref: "refs/heads/main" },
      ]);
      expect(result.data.capabilities).toContain("side-band-64k");
      expect(result.data.capabilities).toContain("report-status");
      expect(wantsSideband(result.data.capabilities)).toBe(true);
    }
  });

  it("parses multiple commands; only the first line carries capabilities", () => {
    const body = concat(
      pktLine(`${OID_A} ${OID_B} refs/heads/main\0report-status`),
      pktLine(`${OID_A} ${OID_B} refs/heads/dev\n`),
      FLUSH_PKT,
    );
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toHaveLength(2);
      expect(result.data.commands[1]?.ref).toBe("refs/heads/dev");
      expect(wantsSideband(result.data.capabilities)).toBe(false);
    }
  });

  it("rejects a body with no flush-pkt", () => {
    const result = parseReceivePackRequest(pktLine(`${OID_A} ${OID_B} refs/heads/main`));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("flush-pkt");
  });

  it("rejects malformed oids", () => {
    const body = concat(pktLine(`not-an-oid ${OID_B} refs/heads/main`), FLUSH_PKT);
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(false);
  });

  it("rejects an empty command section", () => {
    const result = parseReceivePackRequest(FLUSH_PKT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("no commands");
  });

  it("rejects garbage framing", () => {
    const result = parseReceivePackRequest(encoder.encode("zzzz not a pkt line"));
    expect(result.success).toBe(false);
  });
});

describe("encodeSideband", () => {
  it("prefixes the band byte inside the pkt-line", () => {
    const packet = encodeSideband(2, encoder.encode("hello"));
    // length = 4 (header) + 1 (band) + 5 (payload) = 10 = 0x000a
    expect(decoder.decode(packet.subarray(0, 4))).toBe("000a");
    expect(packet[4]).toBe(2);
    expect(decoder.decode(packet.subarray(5))).toBe("hello");
  });

  it("chunks payloads larger than the sideband maximum", () => {
    const packet = encodeSideband(1, new Uint8Array(70_000));
    // Two packets: 65515 bytes + remainder, each with 4-byte header + band byte.
    expect(packet.byteLength).toBe(70_000 + 2 * 5);
  });
});

describe("buildReportStatus", () => {
  it("without sideband: plain pkt-line status section", () => {
    const body = buildReportStatus({
      unpack: "ok",
      results: [{ ref: "refs/heads/main", ok: false, reason: "gated" }],
      messages: ["ignored without sideband"],
      sideband: false,
    });
    const text = decoder.decode(body);
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/heads/main gated\n");
    expect(text.endsWith("0000")).toBe(true);
    expect(text).not.toContain("ignored");
  });

  it("with sideband: wraps status in band 1 and messages in band 2", () => {
    const body = buildReportStatus({
      unpack: "ok",
      results: [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/heads/dev", ok: false, reason: "no" },
      ],
      messages: ["use a workspace remote"],
      sideband: true,
    });
    // Band bytes appear right after each 4-byte pkt header.
    expect(body[4]).toBe(2); // first packet: progress message
    const text = decoder.decode(body);
    expect(text).toContain("use a workspace remote");
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ok refs/heads/main\n");
    expect(text).toContain("ng refs/heads/dev no\n");
    expect(text.endsWith("0000")).toBe(true);
  });
});
