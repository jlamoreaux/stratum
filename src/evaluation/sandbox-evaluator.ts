import { readRepoFiles } from "../storage/git-ops";
import type { SandboxBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

const DEFAULT_COMMAND = "npm test";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_IN_REASON = 500;

/**
 * Read access to the workspace repo whose tree is being evaluated. Threaded in
 * by `buildEvaluators` so the sandbox runs against the FULL workspace tree
 * (the evaluated commit), not a reconstruction from diff hunks.
 */
export interface SandboxRepoAccess {
  /** The workspace repo remote. */
  remote: string;
  /** A read-scoped token for that remote. */
  token: string;
  /** The evaluated commit sha (pinned as evaluated_sha). HEAD when absent. */
  ref?: string;
}

/** Reads a repo tree into path → raw bytes; injectable for tests. */
export type RepoFilesReader = (
  remote: string,
  token: string,
  logger: Logger,
  ref?: string,
) => Promise<Result<Map<string, Uint8Array>, AppError>>;

/**
 * Derives a pass ratio from a test runner's own summary line.
 *
 * Scored from the summary rather than the exit code because the exit code is
 * binary: a suite where 99 of 100 tests pass is indistinguishable from one
 * where none do. Both patterns are tried because runners disagree on whether
 * a clean run prints a "failed" count at all — vitest and jest omit it, so
 * "N passed" alone has to be accepted, with `failed` re-matched separately
 * rather than assumed zero from the first pattern.
 *
 * Returns `null`, never 0, when nothing parses: an unrecognised format means
 * the score is *unknown*, and reporting that as a zero would fail a change on
 * the runner's output format instead of on its tests.
 */
function parseTestOutput(stdout: string, stderr: string): number | null {
  const combined = `${stdout}\n${stderr}`;

  const match =
    combined.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i) ?? combined.match(/(\d+)\s+passed/i);

  if (match) {
    const passed = Number.parseInt(match[1] ?? "0", 10);
    const failedMatch = combined.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0;
    const total = passed + failed;
    if (total === 0) return null;
    return passed / total;
  }

  return null;
}

/** The lockfile names `npm ci` accepts. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

/**
 * A lockfile means the dependency tree is already pinned, so `npm ci` installs
 * it verbatim — an evaluation score only means something if every run resolves
 * the same versions. Without one, `npm install` is the best available
 * (unpinned) approximation; without a package.json there is nothing to install,
 * because the repo is not an npm project. `--no-audit --no-fund` skip registry
 * round trips the evaluation has no use for.
 *
 * Only checks which manifest paths are *present* in the tree — it never reads
 * their contents, so no text decode is needed here. `files` carries raw bytes
 * end to end like the rest of the read path; a manifest's actual contents
 * would be decoded at the point that genuinely needs text, not here.
 */
export function installCommandFor(files: ReadonlyMap<string, Uint8Array>): string | null {
  if (!files.has("package.json")) return null;
  const base = NPM_LOCKFILES.some((lockfile) => files.has(lockfile)) ? "npm ci" : "npm install";
  return `${base} --no-audit --no-fund`;
}

/**
 * Encodes bytes as base64 without spreading the whole array onto the call
 * stack at once (a naive `String.fromCharCode(...bytes)` blows the stack on
 * large binary files) — chunked through `String.fromCharCode` instead.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Per-file content the sandbox write boundary sends, plus whether it took the
 * binary (base64) path.
 */
interface SandboxWriteContent {
  content: string;
  binary: boolean;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Prepares one file's bytes for `SandboxInstance.writeFile`, whose transport
 * boundary only carries strings (the default Cloudflare Sandbox HTTP
 * transport has no binary form for `writeFile`; see `decodeBinaryFilesScript`
 * below for the matching in-sandbox decode step). Bytes that are valid UTF-8
 * are decoded directly — lossless, since re-encoding well-formed UTF-8
 * reproduces the original bytes exactly. Anything else (the common case for a
 * binary file) is base64-encoded and flagged so the caller can queue it for
 * in-sandbox decoding.
 */
export function encodeForSandboxWrite(bytes: Uint8Array): SandboxWriteContent {
  try {
    return { content: strictUtf8Decoder.decode(bytes), binary: false };
  } catch {
    return { content: bytesToBase64(bytes), binary: true };
  }
}

/**
 * Where the base64→binary decode manifest and script are staged in the
 * sandbox tree. Exported so `runPostMergeCheck` (post-merge.ts), which writes
 * the same tree read path into a sandbox, can decode binaries the same way.
 */
export const BINARY_MANIFEST_PATH = ".stratum-binary-manifest.txt";
export const BINARY_DECODE_SCRIPT_PATH = ".stratum-binary-decode.cjs";
/** Command that runs the decode script — `.cjs` forces CommonJS regardless of the evaluated repo's own package.json `"type"`. */
export const BINARY_DECODE_COMMAND = `node ${BINARY_DECODE_SCRIPT_PATH}`;

/**
 * Reads the newline-delimited manifest this evaluator wrote, base64-decodes
 * each listed path in place, then removes the manifest and itself. Node is
 * guaranteed present in the sandbox (the evaluator's own default/most common
 * commands are `npm ci`/`npm install`/`npm test`).
 */
export const decodeBinaryFilesScript = `const fs = require("fs");
const manifest = fs.readFileSync(${JSON.stringify(BINARY_MANIFEST_PATH)}, "utf8").split("\\n").filter(Boolean);
for (const p of manifest) {
  const encoded = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, Buffer.from(encoded, "base64"));
}
fs.unlinkSync(${JSON.stringify(BINARY_MANIFEST_PATH)});
fs.unlinkSync(__filename);
`;

export class SandboxEvaluator implements Evaluator {
  constructor(
    private sandbox: SandboxBinding,
    private repo: SandboxRepoAccess,
    private readFiles: RepoFilesReader = readRepoFiles,
  ) {}

  /**
   * Runs the configured command against the full evaluated tree in a sandbox.
   *
   * The `_diff` argument is ignored on purpose. The evaluator that this
   * replaced reconstructed a pseudo-tree from the diff's `+` lines, which
   * could not run any real suite — no base tree, no untouched sources, no
   * `package.json` unless it happened to change. The tree is read from the
   * pinned commit instead, so the sandbox holds exactly what the merge would
   * land. The parameter stays because it is part of the `Evaluator` contract
   * shared with the diff-based evaluators.
   *
   * Two kinds of failure, deliberately distinguished:
   *
   * - The suite ran and did not pass, or a dependency install failed: score 0
   *   with `passed: false`. An evaluation that could not run must never read
   *   as one that passed, so these are verdicts, not errors.
   * - The evaluated tree could not be reached or read, or the sandbox itself
   *   threw: `err(ExternalServiceError)`. There is no verdict to give here —
   *   the caller decides whether to retry or surface the failure, and scoring
   *   0 would fabricate a judgement about code we never saw.
   *
   * A missing SANDBOX binding or missing repo access never reaches this method
   * at all: `buildEvaluators` substitutes an `UnavailableEvaluator` at
   * construction, which is what fails those closed.
   */
  async evaluate(
    _diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting sandbox evaluation");

    const config = policy.evaluators.find((e) => e.type === "sandbox") as
      | { type: "sandbox"; command?: string; timeoutMs?: number; installTimeoutMs?: number }
      | undefined;

    if (!config) {
      logger.info("No sandbox evaluator configured");
      return ok({ score: 1.0, passed: true, reason: "No sandbox evaluator configured" });
    }

    const command = config.command ?? DEFAULT_COMMAND;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const installTimeoutMs = config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const minScore = policy.minScore ?? 0.7;

    logger.debug("Sandbox config", { command, timeoutMs, installTimeoutMs });

    let sb: Awaited<ReturnType<SandboxBinding["create"]>> | null = null;

    try {
      // Materialize the full workspace tree at the evaluated commit — the same
      // tree the merge would land — so the command runs against real sources,
      // not just the added lines of the diff.
      const filesResult = await this.readFiles(
        this.repo.remote,
        this.repo.token,
        logger,
        this.repo.ref,
      );
      if (!filesResult.success) {
        logger.error("Could not read workspace tree for sandbox", filesResult.error);
        return err(
          new ExternalServiceError(
            "Sandbox",
            `Could not read workspace tree: ${filesResult.error.message}`,
          ) as AppError,
        );
      }
      const files = filesResult.data;

      sb = await this.sandbox.create();
      const instance = sb;
      logger.debug("Sandbox created");

      let sandboxMs = 0;

      // The full tree can hold thousands of files; one round trip per file
      // dominates evaluation latency, so write in bounded concurrent batches.
      // The sandbox's default HTTP transport only carries strings through
      // `writeFile` — text bytes decode directly (lossless: re-encoding
      // well-formed UTF-8 reproduces the original bytes), anything else goes
      // through base64 and is queued for the in-sandbox decode step below.
      const WRITE_CONCURRENCY = 16;
      const entries = [...files];
      const binaryPaths: string[] = [];
      for (let i = 0; i < entries.length; i += WRITE_CONCURRENCY) {
        // allSettled, not all: `all` rejects on the first failure while its
        // siblings are still in flight, and the `finally` below would then
        // destroy the sandbox out from under them. Wait for the whole batch to
        // settle, then surface the first failure.
        const settled = await Promise.allSettled(
          entries.slice(i, i + WRITE_CONCURRENCY).map(([path, bytes]) => {
            const { content, binary } = encodeForSandboxWrite(bytes);
            if (binary) binaryPaths.push(path);
            return instance.writeFile(path, content);
          }),
        );
        const failed = settled.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      logger.debug("Files written to sandbox", {
        fileCount: files.size,
        binaryFileCount: binaryPaths.length,
      });

      // Binary files landed base64-encoded (writeFile has no binary form on
      // this transport) — decode them back to their real bytes in place
      // before install/test see the tree, so a corrupted copy never runs.
      if (binaryPaths.length > 0) {
        await instance.writeFile(BINARY_MANIFEST_PATH, binaryPaths.join("\n"));
        await instance.writeFile(BINARY_DECODE_SCRIPT_PATH, decodeBinaryFilesScript);
        const decodeStartedAt = Date.now();
        const decodeResult = await sb.run(BINARY_DECODE_COMMAND, { timeout: installTimeoutMs });
        sandboxMs += Date.now() - decodeStartedAt;
        if (decodeResult.exitCode !== 0) {
          const output = (decodeResult.stdout + decodeResult.stderr)
            .slice(0, MAX_OUTPUT_IN_REASON)
            .trim();
          throw new Error(
            `Failed to decode ${binaryPaths.length} binary file(s) in sandbox: ${output}`,
          );
        }
        logger.debug("Binary files decoded in sandbox", { binaryFileCount: binaryPaths.length });
      }

      const installCommand = installCommandFor(files);
      if (installCommand !== null) {
        const installStartedAt = Date.now();
        const install = await sb.run(installCommand, { timeout: installTimeoutMs });
        sandboxMs += Date.now() - installStartedAt;
        logger.debug("Sandbox install completed", {
          installCommand,
          exitCode: install.exitCode,
        });
        if (install.exitCode !== 0) {
          const output = (install.stdout + install.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();
          logger.info("Sandbox evaluation failed at dependency install", { installCommand });
          return ok({
            score: 0,
            passed: false,
            reason: `Dependency install (${installCommand}) failed: ${output}`,
            costs: [{ kind: "sandbox_ms", quantity: sandboxMs }],
          });
        }
      }

      const runStartedAt = Date.now();
      const result = await sb.run(command, { timeout: timeoutMs });
      sandboxMs += Date.now() - runStartedAt;
      logger.debug("Sandbox command completed", { exitCode: result.exitCode, sandboxMs });

      let score: number;
      if (result.exitCode === 0) {
        score = 1.0;
      } else {
        const parsed = parseTestOutput(result.stdout, result.stderr);
        score = parsed ?? 0.0;
      }

      const passed = score >= minScore;
      const reason = (result.stdout + result.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();

      logger.info("Sandbox evaluation complete", { score, passed });
      return ok({ score, passed, reason, costs: [{ kind: "sandbox_ms", quantity: sandboxMs }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Sandbox evaluation failed",
        error instanceof Error ? error : new Error(message),
      );
      return err(
        new ExternalServiceError(
          "Sandbox",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      if (sb !== null) {
        await sb.destroy();
        logger.debug("Sandbox destroyed");
      }
    }
  }
}
