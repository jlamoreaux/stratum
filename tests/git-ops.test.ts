import git, { Errors as GitErrors } from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MergeConflictError,
  type NodeFS,
  artifactsRepoNameFromRemote,
  buildUnifiedDiff,
  extractTokenSecret,
  freshRepoToken,
  getDiffBetweenRepos,
  mergeWorkspaceIntoProject,
  readRepoFiles,
  readTreeAtCommit,
  scanForSubmoduleContent,
  submoduleUnsupportedError,
  walkDir,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { ArtifactsNamespace } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Mock only the git functions the merge path drives over the network; keep the
// real Errors classes so classification is exercised against the genuine shapes.
vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      clone: vi.fn(),
      addRemote: vi.fn(),
      fetch: vi.fn(),
      resolveRef: vi.fn(),
      merge: vi.fn(),
      push: vi.fn(),
    },
  };
});

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger;

describe("extractTokenSecret", () => {
  it("returns full token when no expiry suffix", () => {
    expect(extractTokenSecret("art_v1_abc123")).toBe("art_v1_abc123");
  });

  it("strips ?expires= suffix", () => {
    expect(extractTokenSecret("art_v1_abc123?expires=1234567890")).toBe("art_v1_abc123");
  });

  it("handles empty string", () => {
    expect(extractTokenSecret("")).toBe("");
  });

  it("returns base when multiple ?expires= present (only first split)", () => {
    expect(extractTokenSecret("base?expires=111?expires=222")).toBe("base");
  });
});

describe("artifactsRepoNameFromRemote", () => {
  it("extracts the repo name from a standard Artifacts remote", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/octocat__hello-world.git",
      ),
    ).toBe("octocat__hello-world");
  });

  it("handles a remote without the .git suffix", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/octocat__hello-world",
      ),
    ).toBe("octocat__hello-world");
  });

  it("returns null for a non-Artifacts remote", () => {
    expect(artifactsRepoNameFromRemote("https://github.com/owner/repo.git")).toBeNull();
  });

  it("returns null for a non-Artifacts host even with an Artifacts-shaped path", () => {
    // Guards against minting a real Artifacts token for a remote we don't control.
    expect(
      artifactsRepoNameFromRemote("https://evil.example.com/git/stratum-prod/owner__repo.git"),
    ).toBeNull();
  });

  it("returns null for a non-HTTPS Artifacts remote", () => {
    expect(
      artifactsRepoNameFromRemote("http://acct.artifacts.cloudflare.net/git/ns/owner__repo.git"),
    ).toBeNull();
  });

  it("rejects a host that merely contains the Artifacts domain as a prefix", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net.evil.com/git/ns/owner__repo.git",
      ),
    ).toBeNull();
  });
});

describe("freshRepoToken", () => {
  const remote = "https://acct.artifacts.cloudflare.net/git/stratum-prod/owner__repo.git";

  it("mints a fresh token scoped to the operation", async () => {
    const createToken = vi.fn().mockResolvedValue({ plaintext: "fresh_token", expiresAt: 999 });
    const get = vi.fn().mockResolvedValue({ createToken });
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(artifacts, remote, "read", noopLogger);

    expect(result.success && result.data).toBe("fresh_token");
    expect(get).toHaveBeenCalledWith("owner__repo");
    expect(createToken).toHaveBeenCalledWith("read", 3600);
  });

  it("requests a write-scoped token when asked", async () => {
    const createToken = vi.fn().mockResolvedValue({ plaintext: "w", expiresAt: 1 });
    const artifacts = {
      get: vi.fn().mockResolvedValue({ createToken }),
    } as unknown as ArtifactsNamespace;

    await freshRepoToken(artifacts, remote, "write", noopLogger);

    expect(createToken).toHaveBeenCalledWith("write", 3600);
  });

  it("returns an error when minting fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(artifacts, remote, "read", noopLogger);

    expect(result.success).toBe(false);
  });

  it("returns an error when the remote is unrecognised", async () => {
    const get = vi.fn();
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(
      artifacts,
      "https://github.com/owner/repo.git",
      "read",
      noopLogger,
    );

    expect(result.success).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("MemoryFS walkDir (via manual test)", () => {
  it("lists files recursively excluding .git", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/.git/HEAD", "ref: refs/heads/main");
    await fs.promises.writeFile("/src/index.ts", "export {}");
    await fs.promises.writeFile("/src/utils/helpers.ts", "export {}");
    await fs.promises.writeFile("/README.md", "# Hello");

    const result = await walkDir(fs.toNodeFS(), "/", "", noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toContain("src/index.ts");
    expect(result.data).toContain("src/utils/helpers.ts");
    expect(result.data).toContain("README.md");
    expect(result.data.some((f) => f.startsWith(".git"))).toBe(false);
  });

  it("lists symlinks as leaf entries without recursing or failing on dangling links", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/src/index.ts", "export {}");
    await fs.promises.symlink("index.ts", "/src/alias.ts");
    await fs.promises.symlink("missing.ts", "/src/dangling.ts");
    await fs.promises.symlink("/src", "/srclink");

    const result = await walkDir(fs.toNodeFS(), "/", "", noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toContain("src/index.ts");
    expect(result.data).toContain("src/alias.ts");
    expect(result.data).toContain("src/dangling.ts");
    // A symlink to a directory is a leaf, never recursed into.
    expect(result.data).toContain("srclink");
    expect(result.data.some((f) => f.startsWith("srclink/"))).toBe(false);
  });
});

describe("commitAndPush path construction", () => {
  it("writeFile path is correct when dir has trailing slash", async () => {
    const fs = new MemoryFS();
    const base = "/";
    const path = "src/index.ts";
    const fullPath = `${base.endsWith("/") ? base : `${base}/`}${path}`;
    const writeResult = await fs.writeFile(fullPath, "content");
    expect(writeResult.success).toBe(true);
    const result = await fs.readFile("/src/index.ts", { encoding: "utf8" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("content");
    }
  });

  it("writeFile path is correct when dir has no trailing slash", async () => {
    const fs = new MemoryFS();
    const base = "/repo";
    const path = "src/index.ts";
    const fullPath = `${base.endsWith("/") ? base : `${base}/`}${path}`;
    const writeResult = await fs.writeFile(fullPath, "content");
    expect(writeResult.success).toBe(true);
    const result = await fs.readFile("/repo/src/index.ts", { encoding: "utf8" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("content");
    }
  });
});

describe("buildUnifiedDiff", () => {
  it("emits a real hunk for a one-line edit in a large file", () => {
    const base = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
    const changed = [...base];
    changed[59] = "line 60 changed";

    const diff = buildUnifiedDiff(
      new Map([["src/large.ts", `${base.join("\n")}\n`]]),
      new Map([["src/large.ts", `${changed.join("\n")}\n`]]),
    );

    expect(diff).toContain("diff --git a/src/large.ts b/src/large.ts");
    expect(diff).toContain("@@");
    expect(diff).toContain("-line 60");
    expect(diff).toContain("+line 60 changed");
    expect(diff).not.toContain("-line 1\n-line 2\n-line 3");
  });

  it("preserves new-file and deleted-file diffs", () => {
    const diff = buildUnifiedDiff(
      new Map([["src/old.ts", "export const old = true;\n"]]),
      new Map([["src/new.ts", "export const fresh = true;\n"]]),
    );

    expect(diff).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("+export const fresh = true;");
    expect(diff).toContain("diff --git a/src/old.ts b/src/old.ts");
    expect(diff).toContain("deleted file mode 100644");
    expect(diff).toContain("-export const old = true;");
  });

  it("does not rewrite a deleted `-- ` comment line into a file header", () => {
    // The header fix-up used to run over the whole patch body by prefix. A
    // deleted "-- note" line reaches it as "--- note" and came back out as
    // "--- a/<path>", so the reviewer saw the path where the SQL comment was.
    const base = "CREATE TABLE t (id TEXT);\n-- legacy note\nSELECT 1;\n";
    const changed = "CREATE TABLE t (id TEXT);\nSELECT 1;\n";

    const diff = buildUnifiedDiff(
      new Map([["migrations/001.sql", base]]),
      new Map([["migrations/001.sql", changed]]),
    );

    expect(diff).toContain("--- legacy note");
    // Exactly one header pair survives: the one the fix-up writes by position.
    expect(diff.split("\n").filter((line) => line.startsWith("--- "))).toEqual([
      "--- a/migrations/001.sql",
      "--- legacy note",
    ]);
  });

  it("does not rewrite an added `++ ` line into a file header", () => {
    const diff = buildUnifiedDiff(
      new Map([["notes.md", "intro\noutro\n"]]),
      new Map([["notes.md", "intro\n++ bonus point\noutro\n"]]),
    );

    expect(diff).toContain("+++ bonus point");
    expect(diff.split("\n").filter((line) => line.startsWith("+++ "))).toEqual([
      "+++ b/notes.md",
      "+++ bonus point",
    ]);
  });
});

describe("readTreeAtCommit", () => {
  async function makeRepo() {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    const author = { name: "Test", email: "test@example.com" };
    await fs.promises.writeFile("/package.json", '{"name":"app"}');
    await fs.promises.mkdir("/src");
    await fs.promises.writeFile("/src/math.ts", "export const add = 1;");
    await git.add({ fs, dir, filepath: ["package.json", "src/math.ts"] });
    const first = await git.commit({ fs, dir, message: "first", author });

    await fs.promises.writeFile("/src/math.ts", "export const add = 2;");
    await fs.promises.writeFile("/src/new.ts", "export const fresh = true;");
    await git.add({ fs, dir, filepath: ["src/math.ts", "src/new.ts"] });
    const second = await git.commit({ fs, dir, message: "second", author });

    return { fs, first, second };
  }

  it("reads the full file set of the pinned commit, not the current HEAD", async () => {
    const { fs, first } = await makeRepo();
    const result = await readTreeAtCommit(fs, "/", first, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.keys()].sort()).toEqual(["package.json", "src/math.ts"]);
    expect(new TextDecoder().decode(result.data.get("src/math.ts"))).toBe("export const add = 1;");
  });

  it("reads the later commit's tree including files it added", async () => {
    const { fs, second } = await makeRepo();
    const result = await readTreeAtCommit(fs, "/", second, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.keys()].sort()).toEqual(["package.json", "src/math.ts", "src/new.ts"]);
    expect(new TextDecoder().decode(result.data.get("src/math.ts"))).toBe("export const add = 2;");
  });

  it("carries a binary blob's bytes through byte-for-byte, not UTF-8 decoded", async () => {
    // 00 80 C0 AF FF is not valid UTF-8 (0x80 is a stray continuation byte,
    // 0xC0 0xAF is an overlong encoding, 0xFF is never valid) — a TextDecoder
    // would replace it with U+FFFD and the original bytes would be lost.
    const { fs } = await makeRepo();
    const dir = "/";
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    const blobOid = await git.writeBlob({ fs, dir, blob: binaryBytes });
    const treeOid = await git.writeTree({
      fs,
      dir,
      tree: [{ mode: "100644", path: "binary.dat", oid: blobOid, type: "blob" }],
    });
    const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs,
      dir,
      commit: { tree: treeOid, parent: [], author, committer: author, message: "binary file" },
    });

    const result = await readTreeAtCommit(fs, dir, commit, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.get("binary.dat")).toEqual(binaryBytes);
  });

  it("fails closed when a blob in the pinned tree cannot be read", async () => {
    const { fs } = await makeRepo();
    const dir = "/";
    const goodBlob = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode("still readable"),
    });
    const treeOid = await git.writeTree({
      fs,
      dir,
      tree: [
        { mode: "100644", path: "good.txt", oid: goodBlob, type: "blob" },
        // A dangling oid: listed in the tree but the object does not exist.
        {
          mode: "100644",
          path: "missing.txt",
          oid: "0123456789abcdef0123456789abcdef01234567",
          type: "blob",
        },
      ],
    });
    const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs,
      dir,
      commit: { tree: treeOid, parent: [], author, committer: author, message: "broken tree" },
    });

    const result = await readTreeAtCommit(fs, dir, commit, noopLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${commit}`);
    expect(result.error.message).toContain("missing.txt");
  });

  it("errors when the pinned commit is not present in the clone", async () => {
    const { fs } = await makeRepo();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const result = await readTreeAtCommit(fs, "/", missing, noopLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${missing}`);
  });
});

describe("readRepoFiles clone depth", () => {
  beforeEach(() => {
    vi.mocked(git.clone).mockReset().mockResolvedValue(undefined);
  });

  it("clones with full history when pinning a commit sha", async () => {
    await readRepoFiles("https://example.com/repo.git", "token", noopLogger, "some-sha");

    const cloneOpts = vi.mocked(git.clone).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(cloneOpts.depth).toBeUndefined();
  });

  it("clones shallow (depth 50) when reading the live HEAD", async () => {
    await readRepoFiles("https://example.com/repo.git", "token", noopLogger);

    const cloneOpts = vi.mocked(git.clone).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(cloneOpts.depth).toBe(50);
  });
});

describe("mergeWorkspaceIntoProject merge-failure classification (#185)", () => {
  const projectRemote = "https://acct.artifacts.cloudflare.net/git/ns/owner__project.git";
  const workspaceRemote = "https://acct.artifacts.cloudflare.net/git/ns/owner__ws.git";

  const doMerge = () =>
    mergeWorkspaceIntoProject(projectRemote, "pt", workspaceRemote, "wt", noopLogger);

  beforeEach(() => {
    vi.mocked(git.clone).mockReset().mockResolvedValue(undefined);
    vi.mocked(git.addRemote).mockReset().mockResolvedValue(undefined);
    vi.mocked(git.fetch)
      .mockReset()
      .mockResolvedValue({} as Awaited<ReturnType<typeof git.fetch>>);
    vi.mocked(git.resolveRef).mockReset().mockResolvedValue("ws-sha");
    vi.mocked(git.merge).mockReset();
    vi.mocked(git.push)
      .mockReset()
      .mockResolvedValue({ ok: true } as unknown as Awaited<ReturnType<typeof git.push>>);
  });

  it("propagates the exact conflicting file list on a real merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(
      new GitErrors.MergeConflictError(
        ["src/a.ts", "docs/readme.md"],
        ["src/a.ts", "docs/readme.md"],
        [],
        [],
      ),
    );

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("MERGE_CONFLICT");
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([
        "src/a.ts",
        "docs/readme.md",
      ]);
    }
    expect(git.push).not.toHaveBeenCalled();
  });

  it("merges with abortOnConflict: false so real conflicts carry their file list", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);

    await doMerge();

    expect(git.merge).toHaveBeenCalledWith(expect.objectContaining({ abortOnConflict: false }));
  });

  it("classifies a conflict by code when instanceof fails (duplicate module instance)", async () => {
    const foreign = Object.assign(new Error("Automatic merge failed: README.md"), {
      code: "MergeConflictError",
      data: { filepaths: ["README.md"], bothModified: ["README.md"] },
    });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual(["README.md"]);
    }
  });

  it("falls back to an empty file list when a code-matched conflict carries no data", async () => {
    const foreign = Object.assign(new Error("merge conflict"), { code: "MergeConflictError" });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("maps MergeNotSupportedError to a conflict with no file list", async () => {
    vi.mocked(git.merge).mockRejectedValue(new GitErrors.MergeNotSupportedError());

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("classifies MergeNotSupportedError by code when instanceof fails (duplicate module instance)", async () => {
    const foreign = Object.assign(new Error("merge not supported"), {
      code: "MergeNotSupportedError",
    });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("MERGE_CONFLICT");
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("does NOT report an operational failure (network) as a merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(new Error("connect ETIMEDOUT 203.0.113.9:443"));

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.statusCode).toBe(502);
      expect(result.error.message).toContain("ETIMEDOUT");
    }
  });

  it("does NOT report an HTTP-layer git error as a merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(
      new GitErrors.HttpError(502, "Bad Gateway", "upstream unavailable"),
    );

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.statusCode).toBe(502);
    }
  });

  it("surfaces a push failure after a clean merge as an external service error", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);
    vi.mocked(git.push).mockRejectedValue(new Error("503 Service Unavailable"));

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
    }
  });

  it("errors when the merge succeeds without producing a commit oid", async () => {
    vi.mocked(git.merge).mockResolvedValue({} as Awaited<ReturnType<typeof git.merge>>);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });

  it("returns the merge commit oid and pushes when the merge succeeds", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);

    const result = await doMerge();

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("merged-sha");
    expect(git.push).toHaveBeenCalled();
  });
});

/** Builds a one-commit local repo (real git objects, no network) on `main` —
 * or on `opts.branch`, and ONLY on it, so a test can prove a caller reads the
 * branch it was handed rather than a hard-coded `main` — optionally with a
 * nested gitlink entry and/or a root `.gitmodules` file. A
 * gitlink lives inside a real `vendor` subtree because a tree entry name
 * cannot contain a slash — a flat "vendor/lib" entry is a tree git cannot
 * produce, so the walker in `scanForSubmoduleContent` would not be exercised
 * the way it is in practice. */
async function seedSubmoduleRepo(
  fs: NodeFS,
  dir: string,
  opts: { gitlink?: boolean; gitmodules?: boolean; branch?: string } = {},
): Promise<string> {
  const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
  await git.init({ fs: gitfs, dir, defaultBranch: "main" });

  const rootEntries: {
    mode: string;
    path: string;
    oid: string;
    type: "blob" | "tree" | "commit";
  }[] = [];
  const readmeOid = await git.writeBlob({
    fs: gitfs,
    dir,
    blob: new TextEncoder().encode("hi\n"),
  });
  rootEntries.push({ mode: "100644", path: "README.md", oid: readmeOid, type: "blob" });

  if (opts.gitlink) {
    // The gitlink's oid is the submodule's commit -- never read as a blob, so
    // it doesn't need to exist as an object (mirrors squash-merge-modes.test.ts).
    const vendorTreeOid = await git.writeTree({
      fs: gitfs,
      dir,
      tree: [{ mode: "160000", path: "lib", oid: "a".repeat(40), type: "commit" }],
    });
    rootEntries.push({ mode: "040000", path: "vendor", oid: vendorTreeOid, type: "tree" });
  }
  if (opts.gitmodules) {
    const gitmodulesOid = await git.writeBlob({
      fs: gitfs,
      dir,
      blob: new TextEncoder().encode(
        '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.test/lib.git\n',
      ),
    });
    rootEntries.push({ mode: "100644", path: ".gitmodules", oid: gitmodulesOid, type: "blob" });
  }

  const treeOid = await git.writeTree({ fs: gitfs, dir, tree: rootEntries });
  const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
  const commit = await git.writeCommit({
    fs: gitfs,
    dir,
    commit: { tree: treeOid, parent: [], author, committer: author, message: "seed" },
  });
  await git.writeRef({
    fs: gitfs,
    dir,
    ref: `refs/heads/${opts.branch ?? "main"}`,
    value: commit,
    force: true,
  });
  return commit;
}

describe("scanForSubmoduleContent (#258)", () => {
  it("reports nothing unsupported for an ordinary tree", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", {});

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ gitlinkPaths: [], hasGitmodules: false });
  });

  it("detects a gitlink entry nested in a subtree", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", { gitlink: true });

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gitlinkPaths).toEqual(["vendor/lib"]);
      expect(result.data.hasGitmodules).toBe(false);
    }
  });

  it("detects a root .gitmodules file even without a gitlink entry", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", { gitmodules: true });

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gitlinkPaths).toEqual([]);
      expect(result.data.hasGitmodules).toBe(true);
    }
  });
});

describe("submoduleUnsupportedError (#258)", () => {
  it("names the gitlink path(s) with a 422 SUBMODULES_UNSUPPORTED error", () => {
    const error = submoduleUnsupportedError({ gitlinkPaths: ["vendor/lib"], hasGitmodules: false });

    expect(error.code).toBe("SUBMODULES_UNSUPPORTED");
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain("vendor/lib");
  });

  it("names .gitmodules when only the config file is present", () => {
    const error = submoduleUnsupportedError({ gitlinkPaths: [], hasGitmodules: true });

    expect(error.code).toBe("SUBMODULES_UNSUPPORTED");
    expect(error.message).toContain(".gitmodules");
  });
});

describe("getDiffBetweenRepos rejects submodule content (#258)", () => {
  const workspaceUrl = "https://artifacts.example.test/git/ns/ws.git";
  const baseUrl = "https://artifacts.example.test/git/ns/project.git";

  beforeEach(() => {
    vi.mocked(git.clone).mockReset();
    vi.mocked(git.resolveRef).mockReset();
  });

  /** Wires `git.clone` (mocked at the module level) to build a tiny local
   * repo directly into the fs/dir it's handed, keyed by which url is being
   * "cloned" -- exactly what a real clone of that remote would leave behind,
   * without any network layer. */
  function stubClones(build: (url: string, fs: NodeFS, dir: string) => Promise<void> | void): void {
    vi.mocked(git.clone).mockImplementation(async (opts: unknown) => {
      const { fs, dir, url } = opts as { fs: NodeFS; dir: string; url: string };
      await build(url, fs, dir);
    });
  }

  it("rejects when the workspace tree contains a gitlink entry", async () => {
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, url === workspaceUrl ? { gitlink: true } : {});
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain("vendor/lib");
    }
    // Rejected before ever resolving the workspace tip -- no partial change
    // record's worth of extra work happens past the scan.
    expect(git.resolveRef).not.toHaveBeenCalled();
  });

  it("rejects when the workspace tree contains only .gitmodules", async () => {
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, url === workspaceUrl ? { gitmodules: true } : {});
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain(".gitmodules");
    }
  });

  it("scans the branch it was asked for, not a hard-coded main (#258)", async () => {
    // A project imported from a repo whose default branch is `trunk` has no
    // `main` anywhere: base repo, workspace fork and both clones are on
    // `trunk`. Scanning `main` regardless would fail to resolve the ref and
    // surface an opaque git error, so a submodule push would get past the
    // guard on exactly the projects it was not hard-coded for.
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, {
        branch: "trunk",
        ...(url === workspaceUrl ? { gitlink: true } : {}),
      });
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
      "trunk",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // The structured rejection specifically — not a generic git failure
      // from scanning a ref this project does not have.
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain("vendor/lib");
    }
  });

  it("does not reject an ordinary workspace diff", async () => {
    let workspaceCommit = "";
    stubClones(async (url, fs, dir) => {
      const commit = await seedSubmoduleRepo(fs, dir, {});
      if (url === workspaceUrl) workspaceCommit = commit;
    });
    vi.mocked(git.resolveRef).mockImplementation(async () => workspaceCommit);

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(true);
  });
});
