import git, { Errors as GitErrors } from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MergeConflictError,
  artifactsRepoNameFromRemote,
  buildUnifiedDiff,
  extractTokenSecret,
  freshRepoToken,
  mergeWorkspaceIntoProject,
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
