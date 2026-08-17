import { AppError } from "./errors";
import type { Result } from "./result";
import { err, ok } from "./result";

/**
 * Minimal git pack-protocol encoding for the smart-HTTP proxy (ADR 005).
 *
 * Covers exactly what the receive-pack surface needs: pkt-line framing, parsing
 * a client's ref-update command list, and synthesizing a report-status reply —
 * optionally wrapped in side-band-64k — so `git push` outcomes render legibly
 * in the client ("remote: …" messages and per-ref ok/ng status) instead of an
 * opaque HTTP error. This is the foundation the gated default-branch push
 * (slice 2b, #115) plugs into.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A single ref update requested by the client. */
export interface ReceivePackCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceivePackRequest {
  commands: ReceivePackCommand[];
  capabilities: string[];
}

export const FLUSH_PKT = encoder.encode("0000");

/** Frame one pkt-line: 4-hex length (self-inclusive) + payload. */
export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const data = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = data.byteLength + 4;
  if (length > 0xffff) {
    throw new RangeError(`pkt-line payload too large: ${data.byteLength} bytes`);
  }
  const header = encoder.encode(length.toString(16).padStart(4, "0"));
  const out = new Uint8Array(length);
  out.set(header, 0);
  out.set(data, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const OID_RE = /^[0-9a-f]{40}$/;

/**
 * Parse the command section of a git-receive-pack request body: pkt-lines of
 * `old-oid new-oid refname` (the first carrying `\0capability…`), terminated by
 * a flush-pkt; the packfile that follows is not consumed. Returns an error for
 * malformed framing rather than guessing — the caller fails the push closed.
 */
export function parseReceivePackRequest(body: Uint8Array): Result<ReceivePackRequest, AppError> {
  const commands: ReceivePackCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;

  while (true) {
    if (offset + 4 > body.byteLength) {
      return err(new AppError("receive-pack request ended before flush-pkt", "GIT_PROTOCOL", 400));
    }
    const lengthHex = decoder.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(lengthHex)) {
      return err(new AppError("malformed pkt-line length", "GIT_PROTOCOL", 400));
    }
    const length = Number.parseInt(lengthHex, 16);
    if (length === 0) break; // flush-pkt: end of command section
    if (length < 4 || offset + length > body.byteLength) {
      return err(new AppError("pkt-line length out of range", "GIT_PROTOCOL", 400));
    }

    let line = decoder.decode(body.subarray(offset + 4, offset + length));
    offset += length;
    if (line.endsWith("\n")) line = line.slice(0, -1);

    const nul = line.indexOf("\0");
    if (nul >= 0) {
      capabilities = line
        .slice(nul + 1)
        .split(" ")
        .filter((c) => c.length > 0);
      line = line.slice(0, nul);
    }

    const [oldOid, newOid, ...refParts] = line.split(" ");
    const ref = refParts.join(" ");
    if (!oldOid || !newOid || !ref || !OID_RE.test(oldOid) || !OID_RE.test(newOid)) {
      return err(new AppError("malformed receive-pack command", "GIT_PROTOCOL", 400));
    }
    commands.push({ oldOid, newOid, ref });
  }

  if (commands.length === 0) {
    return err(new AppError("receive-pack request contains no commands", "GIT_PROTOCOL", 400));
  }
  return ok({ commands, capabilities });
}

// side-band-64k caps a packet's payload at 65519 bytes; one byte carries the band.
const SIDEBAND_MAX_DATA = 65515;

/** Wrap raw bytes in side-band packets on the given band (1=data, 2=progress, 3=error). */
export function encodeSideband(band: 1 | 2 | 3, data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.byteLength; i += SIDEBAND_MAX_DATA) {
    const chunk = data.subarray(i, Math.min(i + SIDEBAND_MAX_DATA, data.byteLength));
    const framed = new Uint8Array(chunk.byteLength + 1);
    framed[0] = band;
    framed.set(chunk, 1);
    parts.push(encodePktLine(framed));
  }
  return concat(parts);
}

export interface ReportStatus {
  /** "ok" or an unpack error description. */
  unpack: string;
  results: Array<{ ref: string; ok: boolean; reason?: string }>;
  /** Human guidance streamed to the client as `remote: …` lines. */
  messages?: string[];
  /** Whether the client negotiated side-band-64k (wrap report + messages). */
  sideband: boolean;
}

// Reasons and messages can carry arbitrary upstream/evaluator text. pkt-line
// framing is line-oriented with a 16-bit length, so an embedded newline would
// smuggle extra protocol lines and an oversized payload would make
// encodePktLine throw mid-response. Flatten and bound at the encoding boundary.
const MAX_STATUS_TEXT_CHARS = 512;

/** Collapse newlines and cap length so text is safe inside one pkt-line. */
export function sanitizeStatusText(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length > MAX_STATUS_TEXT_CHARS ? `${flat.slice(0, MAX_STATUS_TEXT_CHARS)}…` : flat;
}

/**
 * Build a git-receive-pack result body carrying report-status (and optional
 * progress messages when side-band-64k was negotiated — without side-band there
 * is no channel for messages, so only the status section is sent).
 */
export function buildReportStatus(report: ReportStatus): Uint8Array {
  const statusLines: Uint8Array[] = [encodePktLine(`unpack ${report.unpack}\n`)];
  for (const result of report.results) {
    statusLines.push(
      encodePktLine(
        result.ok
          ? `ok ${result.ref}\n`
          : `ng ${result.ref} ${sanitizeStatusText(result.reason ?? "rejected")}\n`,
      ),
    );
  }
  statusLines.push(FLUSH_PKT);
  const status = concat(statusLines);

  if (!report.sideband) return status;

  const parts: Uint8Array[] = [];
  for (const message of report.messages ?? []) {
    parts.push(encodeSideband(2, encoder.encode(`${sanitizeStatusText(message)}\n`)));
  }
  parts.push(encodeSideband(1, status));
  parts.push(FLUSH_PKT);
  return concat(parts);
}

export function wantsSideband(capabilities: string[]): boolean {
  return capabilities.includes("side-band-64k");
}

/** Split a buffer into pkt-line payloads, tolerating interleaved flush-pkts. */
function readPktLines(body: Uint8Array): Result<Uint8Array[], AppError> {
  const lines: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (offset + 4 > body.byteLength) {
      return err(new AppError("truncated pkt-line header", "GIT_PROTOCOL", 502));
    }
    const lengthHex = decoder.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(lengthHex)) {
      return err(new AppError("malformed pkt-line length", "GIT_PROTOCOL", 502));
    }
    const length = Number.parseInt(lengthHex, 16);
    if (length === 0) {
      offset += 4; // flush-pkt: section boundary, keep reading
      continue;
    }
    if (length < 4 || offset + length > body.byteLength) {
      return err(new AppError("pkt-line length out of range", "GIT_PROTOCOL", 502));
    }
    lines.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  return ok(lines);
}

export interface ParsedReportStatus {
  /** "ok" or the unpack error description. */
  unpack: string;
  results: Array<{ ref: string; ok: boolean; reason?: string }>;
}

/**
 * Parse a git-receive-pack result body into its report-status, handling both
 * plain and side-band-64k framing. Only band 1 carries the status stream;
 * bands 2/3 are free-form progress/error text and are deliberately ignored —
 * substring-scanning the whole body would misread progress like
 * "Counting objects" (or any text containing "ng ") as a ref verdict.
 */
export function parseReportStatus(body: Uint8Array): Result<ParsedReportStatus, AppError> {
  const framesResult = readPktLines(body);
  if (!framesResult.success) return framesResult;
  const frames = framesResult.data;
  if (frames.length === 0) {
    return err(new AppError("empty receive-pack result", "GIT_PROTOCOL", 502));
  }

  // Sideband framing iff every frame leads with a band byte (1-3); a plain
  // status stream leads with ASCII text ("unpack …"), which can't collide.
  const isSideband = frames.every((f) => {
    const band = f[0];
    return band !== undefined && band >= 1 && band <= 3;
  });
  let statusFrames: Uint8Array[];
  if (isSideband) {
    const band1 = concat(frames.filter((f) => f[0] === 1).map((f) => f.subarray(1)));
    const inner = readPktLines(band1);
    if (!inner.success) return inner;
    statusFrames = inner.data;
  } else {
    statusFrames = frames;
  }

  const lines = statusFrames.map((f) => {
    const text = decoder.decode(f);
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  });

  const first = lines[0];
  if (first === undefined || !first.startsWith("unpack ")) {
    return err(new AppError("receive-pack result missing unpack status", "GIT_PROTOCOL", 502));
  }
  const unpack = first.slice("unpack ".length);

  const results: ParsedReportStatus["results"] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("ok ")) {
      results.push({ ref: line.slice("ok ".length), ok: true });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice("ng ".length);
      const space = rest.indexOf(" ");
      results.push(
        space >= 0
          ? { ref: rest.slice(0, space), ok: false, reason: rest.slice(space + 1) }
          : { ref: rest, ok: false },
      );
    } else {
      return err(
        new AppError(
          `unexpected receive-pack status line: ${line.slice(0, 80)}`,
          "GIT_PROTOCOL",
          502,
        ),
      );
    }
  }
  return ok({ unpack, results });
}
