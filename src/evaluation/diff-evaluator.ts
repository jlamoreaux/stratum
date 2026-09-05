import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { ok } from "../utils/result";
import {
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_LINES,
  DEFAULT_MIN_SCORE,
  DIFF_VIOLATION_PENALTY,
} from "./defaults";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

function matchesGlob(pattern: string, path: string): boolean {
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(path) || new RegExp(escaped).test(path);
  }
  return path.includes(pattern);
}

/**
 * The path a `--- `/`+++ ` file header names, stripped of its prefix, or null
 * when the header names no file.
 *
 * `/dev/null` is the side a creation or deletion does not have; returning it
 * would make every deleted file look like a change to a file called
 * `/dev/null`. Git quotes a path containing control or non-ASCII bytes, and the
 * unified format allows a tab-separated timestamp after the path, so both are
 * removed before the prefix — a path that kept its quote would match no
 * pattern.
 */
function headerPath(value: string, prefix: "a/" | "b/"): string | null {
  let path = value.split("\t")[0]?.trim() ?? "";
  if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (!path || path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** `diff --git a/x b/x` for a path that is the same on both sides. */
const SAME_PATH_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export interface DiffStats {
  /**
   * Every path the diff touches, deduplicated, in the order git names them —
   * both sides of a rename, the pre-image of a deletion, and the post-image of
   * everything else.
   */
  paths: string[];
  /** Added plus removed content lines. */
  changedLines: number;
  /** Files in the change, counted by `diff --git` header. */
  fileCount: number;
}

/**
 * Walk a unified diff, recognising file headers by POSITION rather than by
 * prefix — the rule `SecretScanEvaluator` already follows, for the same reason.
 *
 * A diff marks every added line with `+`, so a source line beginning `++`
 * arrives here as `+++…`, which no prefix test can tell from a file header.
 * Read by prefix, that let a change write `++ b/tests/covered.ts` into any file
 * it liked and have `tests/covered.ts` counted among its paths — enough to
 * satisfy a `requiredPatterns` gate without adding the file, and enough to keep
 * a line out of the `maxLines` count. Here a header is only a header inside the
 * header block that opens a file, which begins at `diff --git` and ends at the
 * `+++ ` line or the first `@@`. Content lines always carry a marker, so none
 * can reach that block.
 */
export function parseDiff(diff: string): DiffStats {
  const paths: string[] = [];
  const seen = new Set<string>();
  let changedLines = 0;
  let fileCount = 0;
  let inFileHeader = false;
  let sawOldFileHeader = false;

  const record = (path: string | null) => {
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      fileCount++;
      inFileHeader = true;
      sawOldFileHeader = false;
      // A mode-only change carries no `---`/`+++` pair, so this header is the
      // sole mention of its path. Only read it when both sides are spelled the
      // same, since ` b/` is a legal substring of a path and splitting on it is
      // guesswork the `---`/`+++` lines do not need.
      const match = SAME_PATH_HEADER.exec(line);
      if (match && match[1] === match[2]) record(match[1] ?? null);
      continue;
    }

    if (inFileHeader) {
      if (line.startsWith("@@")) {
        inFileHeader = false;
        continue;
      }
      // A pure rename carries no `---`/`+++` pair at all — at 100% similarity
      // git emits only these two lines — so without them a policy forbidding a
      // path would not see a file leave it.
      if (line.startsWith("rename from ")) {
        record(headerPath(line.slice("rename from ".length), "a/"));
        continue;
      }
      if (line.startsWith("rename to ")) {
        record(headerPath(line.slice("rename to ".length), "b/"));
        continue;
      }
      if (line.startsWith("--- ")) {
        record(headerPath(line.slice(4), "a/"));
        sawOldFileHeader = true;
        continue;
      }
      if (sawOldFileHeader && line.startsWith("+++ ")) {
        record(headerPath(line.slice(4), "b/"));
        inFileHeader = false;
        continue;
      }
      // `index …`, `new file mode …`, `Binary files … differ`: not content, and
      // not a line any count should include.
      continue;
    }

    if (line.startsWith("+") || line.startsWith("-")) changedLines++;
  }

  return { paths, changedLines, fileCount };
}

export class DiffEvaluator implements Evaluator {
  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting diff evaluation");

    const config = policy.evaluators.find((e) => e.type === "diff");
    if (!config || config.type !== "diff") {
      logger.info("No diff config found, passing by default");
      return ok({ score: 1.0, passed: true, reason: "No diff config found, passing by default." });
    }

    const maxLines = config.maxLines ?? DEFAULT_MAX_LINES;
    const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
    const forbiddenPatterns = config.forbiddenPatterns ?? DEFAULT_FORBIDDEN_PATTERNS;
    const requiredPatterns = config.requiredPatterns ?? [];
    const minScore = policy.minScore ?? DEFAULT_MIN_SCORE;

    const violations: string[] = [];
    const { paths, changedLines, fileCount } = parseDiff(diff);

    logger.debug("Diff stats", { changedLines, fileCount, paths: paths.length });

    if (changedLines > maxLines) {
      violations.push(`Changed lines (${changedLines}) exceeds maxLines (${maxLines})`);
    }

    if (fileCount > maxFiles) {
      violations.push(`File count (${fileCount}) exceeds maxFiles (${maxFiles})`);
    }

    for (const pattern of forbiddenPatterns) {
      for (const path of paths) {
        if (matchesGlob(pattern, path)) {
          violations.push(`File "${path}" matches forbidden pattern "${pattern}"`);
          break;
        }
      }
    }

    for (const pattern of requiredPatterns) {
      const matches = paths.some((path) => matchesGlob(pattern, path));
      if (!matches) {
        violations.push(`No changed file matches required pattern "${pattern}"`);
      }
    }

    const score = Math.max(0.0, 1.0 - violations.length * DIFF_VIOLATION_PENALTY);
    const passed = score >= minScore;
    const reason =
      violations.length === 0 ? "Diff passed all checks." : `Diff failed: ${violations.join("; ")}`;

    if (violations.length > 0) {
      logger.info("Diff evaluation found violations", { violationCount: violations.length, score });
      return ok({ score, passed, reason, issues: violations });
    }

    logger.info("Diff evaluation complete", { score, passed });
    return ok({ score, passed, reason });
  }
}
