import type { FC } from "hono/jsx";

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: Array<{ kind: "add" | "del" | "context" | "hunk" | "meta"; text: string }>;
}

/**
 * Parse a unified diff into per-file sections for rendering.
 * Tolerant of partial input: unrecognized lines render as context.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      const path = rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
      current = { path, additions: 0, deletions: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith("Index:") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("===")) {
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — metadata about the adjacent line, not
      // file content; kept distinct so the split view doesn't pair it.
      current.lines.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "del", text: line });
    } else {
      current.lines.push({ kind: "context", text: line });
    }
  }

  return files;
}

const lineClass: Record<DiffFile["lines"][number]["kind"], string> = {
  add: "diff-line diff-add",
  del: "diff-line diff-del",
  context: "diff-line",
  hunk: "diff-line diff-hunk",
  meta: "diff-line diff-meta",
};

export type SplitRow =
  | { kind: "hunk"; text: string }
  | {
      kind: "pair";
      left: string | null;
      right: string | null;
      leftKind: "del" | "context";
      rightKind: "add" | "context";
    };

/** Drop the unified-diff marker (+ / - / leading space) for side-by-side cells. */
function stripMarker(text: string): string {
  return text.startsWith("+") || text.startsWith("-") || text.startsWith(" ")
    ? text.slice(1)
    : text;
}

/**
 * Pair a file's unified-diff lines into side-by-side rows. Unified diffs list a
 * segment's deletions before its additions, so buffered del/add runs are zipped
 * together at each context/hunk boundary; the longer run leaves empty cells on
 * the other side.
 */
export function buildSplitRows(lines: DiffFile["lines"]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i++) {
      rows.push({
        kind: "pair",
        left: dels[i] ?? null,
        right: adds[i] ?? null,
        leftKind: "del",
        rightKind: "add",
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    switch (line.kind) {
      case "del":
        dels.push(stripMarker(line.text));
        break;
      case "add":
        adds.push(stripMarker(line.text));
        break;
      case "hunk":
        flush();
        rows.push({ kind: "hunk", text: line.text });
        break;
      case "meta":
        // Skip without flushing: the marker sits inside a del/add segment and
        // must not break the pairing (or render as content in both columns).
        break;
      case "context": {
        flush();
        const text = stripMarker(line.text);
        rows.push({
          kind: "pair",
          left: text,
          right: text,
          leftKind: "context",
          rightKind: "context",
        });
        break;
      }
    }
  }
  flush();
  return rows;
}

const SplitTable: FC<{ file: DiffFile }> = ({ file }) => (
  <table class="diff-split">
    <caption class="visually-hidden">Side-by-side diff of {file.path}</caption>
    <thead class="visually-hidden">
      <tr>
        <th scope="col">Original</th>
        <th scope="col">Modified</th>
      </tr>
    </thead>
    <tbody>
      {buildSplitRows(file.lines).map((row, index) =>
        row.kind === "hunk" ? (
          <tr key={index}>
            <td class="diff-cell diff-hunk" colspan={2}>
              {row.text}
            </td>
          </tr>
        ) : (
          <tr key={index}>
            <td class={row.leftKind === "del" ? "diff-cell diff-del" : "diff-cell"}>
              {row.left ?? ""}
            </td>
            <td class={row.rightKind === "add" ? "diff-cell diff-add" : "diff-cell"}>
              {row.right ?? ""}
            </td>
          </tr>
        ),
      )}
    </tbody>
  </table>
);

/**
 * The unified/split toggle is a hidden checkbox + CSS sibling selectors — the
 * switch is instant and needs no client-side JavaScript, keeping the UI's
 * server-rendered-only invariant. Both views are rendered; CSS shows one.
 */
export const DiffView: FC<{ files: DiffFile[] }> = ({ files }) => {
  if (files.length === 0) {
    return <p class="diff-empty">No changes between the workspace and the project.</p>;
  }
  return (
    <div class="diff-view">
      <input type="checkbox" id="diff-split-toggle" class="diff-split-toggle" />
      <label for="diff-split-toggle" class="diff-split-label">
        <span class="diff-label-unified">Switch to split view</span>
        <span class="diff-label-split">Switch to unified view</span>
      </label>
      {files.map((file) => (
        <details class="diff-file" key={file.path} open={files.length <= 5}>
          <summary class="diff-file-header">
            <span class="diff-file-path">{file.path}</span>
            <span class="diff-file-stats">
              <span class="diff-stat-add">+{file.additions}</span>{" "}
              <span class="diff-stat-del">−{file.deletions}</span>
            </span>
          </summary>
          <pre class="diff-file-body">
            {file.lines.map((line, index) => (
              <span class={lineClass[line.kind]} key={index}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
          <SplitTable file={file} />
        </details>
      ))}
    </div>
  );
};
