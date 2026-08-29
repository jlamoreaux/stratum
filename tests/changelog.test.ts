/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// The repository's own changelog, so the release automation is exercised against
// the real file rather than only fixtures. Imported raw (not via node:fs) to keep
// this suite type-checking under the Workers tsconfig.
import REAL_CHANGELOG from "../CHANGELOG.md?raw";
import {
  compareVersions,
  cutRelease,
  groupsIn,
  inferBump,
  isSemver,
  latestRelease,
  nextVersion,
  parseChangelog,
  releaseNotes,
  resolveBump,
  validateChangelog,
} from "../scripts/changelog";

const REPO = "https://github.com/stratum-eng/stratum";

const FIXTURE = `# Changelog

Preamble text.

## [Unreleased]

### Added
- A new thing.

### Fixed
- An old thing.

## [0.1.0] - 2026-06-11

### Added
- Initial release.

[Unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`;

describe("parseChangelog", () => {
  it("splits preamble, sections, and link definitions", () => {
    const parsed = parseChangelog(FIXTURE);

    expect(parsed.preamble).toBe("# Changelog\n\nPreamble text.");
    expect(parsed.sections.map((section) => section.version)).toEqual(["Unreleased", "0.1.0"]);
    expect(parsed.sections[1]?.date).toBe("2026-06-11");
    expect([...parsed.links.keys()]).toEqual(["Unreleased", "0.1.0"]);
  });

  it("keeps link definitions out of section bodies", () => {
    const parsed = parseChangelog(FIXTURE);
    expect(parsed.sections[1]?.body).toBe("### Added\n- Initial release.");
  });

  it("preserves interior blank lines but trims the edges", () => {
    const parsed = parseChangelog(FIXTURE);
    expect(parsed.sections[0]?.body).toBe(
      "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
    );
  });

  it("leaves Unreleased undated", () => {
    expect(parseChangelog(FIXTURE).sections[0]?.date).toBeUndefined();
  });
});

describe("groupsIn / inferBump", () => {
  it("lists the group headings in a section", () => {
    expect(groupsIn("### Added\n- x\n\n### Fixed\n- y")).toEqual(["added", "fixed"]);
  });

  it("does not mistake a bullet for a heading", () => {
    expect(groupsIn("- ### Added is not a heading")).toEqual([]);
  });

  it("treats Breaking and Removed as major", () => {
    expect(inferBump("### Breaking\n- x")).toBe("major");
    expect(inferBump("### Removed\n- x")).toBe("major");
  });

  it("treats Added as minor", () => {
    expect(inferBump("### Added\n- x\n\n### Fixed\n- y")).toBe("minor");
  });

  it("treats everything else as patch", () => {
    expect(inferBump("### Fixed\n- x\n\n### Security\n- y")).toBe("patch");
  });
});

describe("resolveBump", () => {
  it("clamps an inferred major to a minor while the major version is 0", () => {
    const resolved = resolveBump("0.1.0", "auto", "### Breaking\n- x");
    expect(resolved).toEqual({ success: true, data: "minor" });
  });

  it("honours an explicit major on a 0.x version", () => {
    expect(resolveBump("0.1.0", "major", "### Fixed\n- x")).toEqual({
      success: true,
      data: "major",
    });
  });

  it("does not clamp once the major version is 1 or above", () => {
    expect(resolveBump("1.4.2", "auto", "### Breaking\n- x")).toEqual({
      success: true,
      data: "major",
    });
  });

  it("rejects a non-semver current version", () => {
    expect(resolveBump("v1", "auto", "").success).toBe(false);
  });
});

describe("nextVersion", () => {
  it.each([
    ["0.1.0", "patch", "0.1.1"],
    ["0.1.9", "minor", "0.2.0"],
    ["0.2.3", "major", "1.0.0"],
    ["1.0.0-beta.1", "patch", "1.0.1"],
  ] as const)("%s + %s = %s", (current, bump, expected) => {
    expect(nextVersion(current, bump)).toEqual({ success: true, data: expected });
  });

  it("rejects a non-semver current version", () => {
    expect(nextVersion("nightly", "patch").success).toBe(false);
  });
});

describe("isSemver / compareVersions / latestRelease", () => {
  it("accepts semver and rejects tag-shaped input", () => {
    expect(isSemver("0.2.0")).toBe(true);
    expect(isSemver("1.0.0-rc.1")).toBe(true);
    expect(isSemver("v0.2.0")).toBe(false);
    expect(isSemver("0.2")).toBe(false);
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("reports the newest released version, skipping Unreleased", () => {
    expect(latestRelease(FIXTURE)).toBe("0.1.0");
  });

  it("returns null when nothing has shipped", () => {
    expect(latestRelease("# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n")).toBeNull();
  });
});

describe("releaseNotes", () => {
  it("returns just that release's entries", () => {
    expect(releaseNotes(FIXTURE, "0.1.0")).toEqual({
      success: true,
      data: "### Added\n- Initial release.",
    });
  });

  it("fails on a version with no section", () => {
    const result = releaseNotes(FIXTURE, "9.9.9");
    expect(result.success).toBe(false);
  });

  it("fails on an empty section rather than publishing empty notes", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-06-11\n\n[0.1.0]: x\n";
    expect(releaseNotes(empty, "0.1.0").success).toBe(false);
  });
});

describe("cutRelease", () => {
  const cut = cutRelease(FIXTURE, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO });
  const text = cut.success ? cut.data : "";

  it("succeeds", () => {
    expect(cut.success).toBe(true);
  });

  it("moves the Unreleased entries into the dated section", () => {
    expect(releaseNotes(text, "0.2.0")).toEqual({
      success: true,
      data: "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
    });
  });

  it("leaves a fresh, empty Unreleased section behind", () => {
    const parsed = parseChangelog(text);
    expect(parsed.sections[0]).toEqual({ version: "Unreleased", body: "" });
  });

  it("points Unreleased at the new tag and the new release at its predecessor", () => {
    const links = parseChangelog(text).links;
    expect(links.get("Unreleased")).toBe(`${REPO}/compare/v0.2.0...HEAD`);
    expect(links.get("0.2.0")).toBe(`${REPO}/compare/v0.1.0...v0.2.0`);
    expect(links.get("0.1.0")).toBe(`${REPO}/releases/tag/v0.1.0`);
  });

  it("keeps older releases intact", () => {
    expect(releaseNotes(text, "0.1.0")).toEqual({
      success: true,
      data: "### Added\n- Initial release.",
    });
    expect(parseChangelog(text).sections[2]?.date).toBe("2026-06-11");
  });

  it("produces a file that still validates", () => {
    expect(validateChangelog(text)).toEqual([]);
  });

  it("links the very first release to its tag page, having nothing to compare against", () => {
    const first = `# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n[Unreleased]: ${REPO}/commits/main\n`;
    const result = cutRelease(first, { version: "0.1.0", date: "2026-06-11", repoUrl: REPO });
    expect(result.success && parseChangelog(result.data).links.get("0.1.0")).toBe(
      `${REPO}/releases/tag/v0.1.0`,
    );
  });

  it("refuses to cut an empty Unreleased section", () => {
    const empty = FIXTURE.replace("### Added\n- A new thing.\n\n### Fixed\n- An old thing.\n", "");
    expect(cutRelease(empty, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO }).success).toBe(
      false,
    );
  });

  it("refuses to overwrite a version that already exists", () => {
    expect(
      cutRelease(FIXTURE, { version: "0.1.0", date: "2026-08-29", repoUrl: REPO }).success,
    ).toBe(false);
  });

  it("rejects a malformed version or date", () => {
    expect(
      cutRelease(FIXTURE, { version: "v0.2.0", date: "2026-08-29", repoUrl: REPO }).success,
    ).toBe(false);
    expect(
      cutRelease(FIXTURE, { version: "0.2.0", date: "29 Aug 2026", repoUrl: REPO }).success,
    ).toBe(false);
  });

  it("refuses a second cut until new entries land under Unreleased", () => {
    expect(cutRelease(text, { version: "0.3.0", date: "2026-09-01", repoUrl: REPO }).success).toBe(
      false,
    );
  });

  it("chains compare links across successive releases", () => {
    const refilled = text.replace(
      "## [Unreleased]",
      "## [Unreleased]\n\n### Fixed\n- A later fix.",
    );
    const second = cutRelease(refilled, { version: "0.2.1", date: "2026-09-01", repoUrl: REPO });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const parsed = parseChangelog(second.data);
    expect(parsed.sections.map((section) => section.version)).toEqual([
      "Unreleased",
      "0.2.1",
      "0.2.0",
      "0.1.0",
    ]);
    expect(parsed.links.get("0.2.1")).toBe(`${REPO}/compare/v0.2.0...v0.2.1`);
    expect(parsed.links.get("Unreleased")).toBe(`${REPO}/compare/v0.2.1...HEAD`);
    expect(validateChangelog(second.data)).toEqual([]);
  });
});

describe("validateChangelog", () => {
  it("passes a well-formed file", () => {
    expect(validateChangelog(FIXTURE)).toEqual([]);
  });

  it("flags a missing Unreleased section", () => {
    const text = FIXTURE.replace("## [Unreleased]", "## [0.0.9] - 2026-01-01");
    expect(validateChangelog(text).join("\n")).toContain("Unreleased");
  });

  it("flags a release with no link definition — the dead-link failure mode", () => {
    const text = FIXTURE.replace(`[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`, "");
    expect(validateChangelog(text)).toContain("No link definition for `0.1.0`");
  });

  it("flags a link definition with no matching section", () => {
    const text = FIXTURE.replace("[0.1.0]:", "[0.9.0]:");
    expect(validateChangelog(text)).toContain("Link definition `0.9.0` has no matching section");
  });

  it("flags an undated release", () => {
    const text = FIXTURE.replace("## [0.1.0] - 2026-06-11", "## [0.1.0]");
    expect(validateChangelog(text)).toContain("`0.1.0` has no release date");
  });

  it("flags releases listed out of order", () => {
    const text = FIXTURE.replace(
      "## [0.1.0] - 2026-06-11",
      "## [0.1.0] - 2026-06-11\n\n### Added\n- x\n\n## [0.2.0] - 2026-07-01",
    ).replace(`[0.1.0]: ${REPO}`, `[0.2.0]: ${REPO}/x\n[0.1.0]: ${REPO}`);
    expect(validateChangelog(text).join("\n")).toContain("out of order");
  });
});

describe("the repository's own CHANGELOG.md", () => {
  it("is structurally sound, so a release can always be cut from it", () => {
    expect(validateChangelog(REAL_CHANGELOG)).toEqual([]);
  });

  it("has release notes for every shipped version", () => {
    const released = parseChangelog(REAL_CHANGELOG).sections.filter(
      (section) => section.version !== "Unreleased",
    );
    expect(released.length).toBeGreaterThan(0);
    for (const section of released) {
      expect(releaseNotes(REAL_CHANGELOG, section.version).success).toBe(true);
    }
  });
});
