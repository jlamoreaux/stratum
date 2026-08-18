import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import {
  type DiffFile,
  DiffView,
  buildSplitRows,
  parseUnifiedDiff,
} from "../src/ui/components/diff-view";

type Lines = DiffFile["lines"];

describe("buildSplitRows", () => {
  it("pairs a deletion run with an addition run", () => {
    const lines: Lines = [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "del", text: "-const a = 1;" },
      { kind: "del", text: "-const b = 2;" },
      { kind: "add", text: "+const a = 10;" },
      { kind: "add", text: "+const b = 20;" },
    ];
    const rows = buildSplitRows(lines);
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      {
        kind: "pair",
        left: "const a = 1;",
        right: "const a = 10;",
        leftKind: "del",
        rightKind: "add",
      },
      {
        kind: "pair",
        left: "const b = 2;",
        right: "const b = 20;",
        leftKind: "del",
        rightKind: "add",
      },
    ]);
  });

  it("leaves empty cells when runs have unequal length", () => {
    const lines: Lines = [
      { kind: "del", text: "-only removed" },
      { kind: "add", text: "+replacement" },
      { kind: "add", text: "+brand new line" },
    ];
    const rows = buildSplitRows(lines);
    expect(rows).toEqual([
      {
        kind: "pair",
        left: "only removed",
        right: "replacement",
        leftKind: "del",
        rightKind: "add",
      },
      { kind: "pair", left: null, right: "brand new line", leftKind: "del", rightKind: "add" },
    ]);
  });

  it("context lines appear on both sides and flush pending runs", () => {
    const lines: Lines = [
      { kind: "del", text: "-old" },
      { kind: "context", text: " shared" },
      { kind: "add", text: "+new" },
    ];
    const rows = buildSplitRows(lines);
    expect(rows).toEqual([
      { kind: "pair", left: "old", right: null, leftKind: "del", rightKind: "add" },
      { kind: "pair", left: "shared", right: "shared", leftKind: "context", rightKind: "context" },
      { kind: "pair", left: null, right: "new", leftKind: "del", rightKind: "add" },
    ]);
  });

  it("handles a pure addition (new file) with no deletions", () => {
    const lines: Lines = [
      { kind: "add", text: "+line one" },
      { kind: "add", text: "+line two" },
    ];
    const rows = buildSplitRows(lines);
    expect(rows).toEqual([
      { kind: "pair", left: null, right: "line one", leftKind: "del", rightKind: "add" },
      { kind: "pair", left: null, right: "line two", leftKind: "del", rightKind: "add" },
    ]);
  });

  it("round-trips through parseUnifiedDiff for a realistic hunk", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,3 +1,3 @@",
      " const keep = true;",
      "-const version = 1;",
      "+const version = 2;",
      " export {};",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    if (!file) throw new Error("diff did not parse");
    const rows = buildSplitRows(file.lines);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({
      kind: "pair",
      left: "const keep = true;",
      right: "const keep = true;",
      leftKind: "context",
      rightKind: "context",
    });
    expect(rows[2]).toEqual({
      kind: "pair",
      left: "const version = 1;",
      right: "const version = 2;",
      leftKind: "del",
      rightKind: "add",
    });
  });

  it("no-newline markers are metadata: never paired, never breaking alignment", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1 +1 @@",
      "-old final line",
      "\\ No newline at end of file",
      "+new final line",
      "\\ No newline at end of file",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    if (!file) throw new Error("diff did not parse");
    expect(file.lines.filter((l) => l.kind === "meta")).toHaveLength(2);
    // The marker between del and add must not flush the pairing: the changed
    // final line still renders as one aligned row, with no metadata rows.
    const rows = buildSplitRows(file.lines);
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      {
        kind: "pair",
        left: "old final line",
        right: "new final line",
        leftKind: "del",
        rightKind: "add",
      },
    ]);
  });
});

describe("DiffView split toggle", () => {
  const files: DiffFile[] = [
    {
      path: "src/x.ts",
      additions: 1,
      deletions: 1,
      lines: [
        { kind: "hunk", text: "@@ -1 +1 @@" },
        { kind: "del", text: "-old line" },
        { kind: "add", text: "+new line" },
      ],
    },
  ];

  it("renders both unified and split views with a CSS-only toggle", () => {
    const html = renderToString(<DiffView files={files} />);
    expect(html).toContain('class="diff-split-toggle"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('class="diff-file-body"');
    expect(html).toContain('class="diff-split"');
    expect(html).toContain("Switch to split view");
    expect(html).toContain("Switch to unified view");
    // No client-side JavaScript may sneak in with the toggle.
    expect(html).not.toContain("<script");
  });

  it("split cells carry the marker-stripped text", () => {
    const html = renderToString(<DiffView files={files} />);
    expect(html).toContain(">old line</td>");
    expect(html).toContain(">new line</td>");
  });

  it("renders no toggle for an empty diff", () => {
    const html = renderToString(<DiffView files={[]} />);
    expect(html).toContain("No changes");
    expect(html).not.toContain("diff-split-toggle");
  });

  it("split table carries accessible caption and column headers", () => {
    const html = renderToString(<DiffView files={files} />);
    expect(html).toContain("Side-by-side diff of src/x.ts");
    expect(html).toContain('<th scope="col">Original</th>');
    expect(html).toContain('<th scope="col">Modified</th>');
  });
});
