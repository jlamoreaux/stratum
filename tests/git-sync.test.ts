import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import {
  type DeepenFetch,
  type NodeFS,
  applySourceUpdate,
  applySourceUpdateWithDeepening,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { type FsLike, placeLooseObject } from "../src/storage/object-loader";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const DIR = "/repo";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

// isomorphic-git accepts its own fs shape, which is structurally wider than
// NodeFS; derive it from the library so the tests stay type-checked.
type GitFS = Parameters<typeof git.init>[0]["fs"];

async function initRepo(): Promise<{ fs: NodeFS; gfs: GitFS }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  const gfs = fs as GitFS;
  await git.init({ fs: gfs, dir: DIR, defaultBranch: "main" });
  return { fs, gfs };
}

async function commitFiles(gfs: GitFS, files: Record<string, string>, message = "c") {
  for (const [path, content] of Object.entries(files)) {
    await (gfs as unknown as NodeFS).promises.writeFile(`${DIR}/${path}`, content);
    await git.add({ fs: gfs, dir: DIR, filepath: path });
  }
  return git.commit({ fs: gfs, dir: DIR, message, author });
}

/** Rewind main to `sha` (simulates the local repo not yet having later commits). */
async function rewindMain(gfs: GitFS, sha: string) {
  await git.writeRef({ fs: gfs, dir: DIR, ref: "refs/heads/main", value: sha, force: true });
  await git.checkout({ fs: gfs, dir: DIR, ref: "main", force: true });
}

/** Mark `oids` as the local repo's shallow boundary — what a real shallow
 * clone/fetch leaves in `.git/shallow`: the fetched commits still record
 * their true parent hash, but that parent object isn't present locally. */
async function writeShallowFile(fs: NodeFS, oids: string[]) {
  await fs.promises.writeFile(`${DIR}/.git/shallow`, `${oids.join("\n")}\n`);
}

/** Simulates a fetch that reached the true root on both sides: nothing left
 * to hide, so the shallow boundary file goes away entirely. */
async function clearShallowFile(fs: NodeFS) {
  await fs.promises.unlink(`${DIR}/.git/shallow`);
}

describe("applySourceUpdate (real git, in-memory)", () => {
  // #181: an imported repo's branch may be master/trunk. Driven with REAL
  // isomorphic-git, so a wrong `ours` fails to resolve rather than silently
  // merging the wrong side.
  it("merges onto a non-main branch when one is given", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const gfs = fs as GitFS;
    await git.init({ fs: gfs, dir: DIR, defaultBranch: "master" });
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "file.txt": "v2\n" }, "source c2");
    await git.writeRef({ fs: gfs, dir: DIR, ref: "refs/heads/master", value: base, force: true });
    await git.checkout({ fs: gfs, dir: DIR, ref: "master", force: true });

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger, undefined, "master");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("fast-forwarded");
    expect(result.data.commit).toBe(sourceTip);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "master" })).toBe(sourceTip);
  });

  it("fast-forwards main to the source tip when the source is strictly ahead", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const mid = await commitFiles(gfs, { "file.txt": "v2\n" }, "source c2");
    const sourceTip = await commitFiles(gfs, { "extra.txt": "new\n" }, "source c3");
    await rewindMain(gfs, base);

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("fast-forwarded");
    expect(result.data.commit).toBe(sourceTip);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(sourceTip);
    const log = await git.log({ fs: gfs, dir: DIR, depth: -1 });
    expect(log.map((c) => c.oid)).toEqual([sourceTip, mid, base]);
  });

  it("is a no-op when the source tip equals main", async () => {
    const { fs, gfs } = await initRepo();
    const tip = await commitFiles(gfs, { "file.txt": "base\n" }, "base");

    const result = await applySourceUpdate(fs, DIR, tip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("up-to-date");
    expect(result.data.commit).toBe(tip);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(tip);
  });

  it("is a no-op when main is ahead of the source tip (native commits preserved)", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const nativeTip = await commitFiles(gfs, { "native.txt": "stratum\n" }, "native merge");

    const result = await applySourceUpdate(fs, DIR, base, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("up-to-date");
    expect(result.data.commit).toBe(nativeTip);
    // The Stratum-native commit is still the tip — nothing was rewound.
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
  });

  it("merges cleanly-diverged histories, keeping native and source commits", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "source.txt": "from github\n" }, "source");
    await rewindMain(gfs, base);
    const nativeTip = await commitFiles(gfs, { "native.txt": "stratum\n" }, "native");

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("merged");
    const head = await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" });
    expect(result.data.commit).toBe(head);
    const merge = await git.readCommit({ fs: gfs, dir: DIR, oid: head });
    expect(merge.commit.parent.sort()).toEqual([nativeTip, sourceTip].sort());
    const files = await git.listFiles({ fs: gfs, dir: DIR, ref: "main" });
    expect(files.sort()).toEqual(["file.txt", "native.txt", "source.txt"]);
  });

  it("fails with SYNC_DIVERGED on conflicting edits and leaves main untouched", async () => {
    const { fs, gfs } = await initRepo();
    await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "file.txt": "github edit\n" }, "source");
    const base = (await git.log({ fs: gfs, dir: DIR, depth: -1 })).at(-1)?.oid ?? "";
    await rewindMain(gfs, base);
    const nativeTip = await commitFiles(gfs, { "file.txt": "native edit\n" }, "native");

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(result.error.statusCode).toBe(409);
    expect(result.error.message).toContain("left untouched");
    // Nothing was rewound or deleted.
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
  });

  it("reports an operational merge failure as ExternalServiceError, not SYNC_DIVERGED", async () => {
    // A merge can fail for reasons that have nothing to do with divergence —
    // corrupt objects, IO. Those must not be dressed up as "your history
    // diverged", which sends the operator to reconcile history that is fine.
    const { fs, gfs } = await initRepo();
    await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "file.txt": "source\n" }, "source");

    const merge = vi.spyOn(git, "merge").mockRejectedValueOnce(new Error("EIO: disk exploded"));
    try {
      const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).not.toBe("SYNC_DIVERGED");
      expect(result.error.statusCode).not.toBe(409);
      expect(result.error.message).toContain("disk exploded");
    } finally {
      merge.mockRestore();
    }
  });

  it("fails with SYNC_DIVERGED for unrelated history (force-push rewrite) without touching main", async () => {
    const { fs, gfs } = await initRepo();
    const nativeTip = await commitFiles(gfs, { "file.txt": "base\n" }, "base");

    // Synthesize an orphan commit with no common ancestor — what the source
    // looks like after a history rewrite / grafted shallow fetch.
    const gitdir = `${DIR}/.git`;
    const blob = await blobObject(new TextEncoder().encode("rewritten\n"));
    const tree = await treeObject([{ mode: "100644", name: "other.txt", oid: blob.oid }]);
    const orphan = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "rewritten root",
      timestamp: 1_700_000_100,
    });
    for (const o of [blob, tree, orphan]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }

    const result = await applySourceUpdate(fs, DIR, orphan.oid, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
    // Genuinely no common ancestor exists at all — a real missing-merge-base
    // case, distinct from a hard content conflict. syncFromGitHub uses this
    // flag to decide whether deepening is even worth attempting.
    expect(result.error.context?.missingMergeBase).toBe(true);
  });
});

describe("applySourceUpdateWithDeepening (real git, in-memory)", () => {
  it("merges successfully after deepening when the common ancestor sits beyond the initial shallow window", async () => {
    const { fs, gfs } = await initRepo();
    const gitdir = `${DIR}/.git`;

    // isomorphic-git's merge-base search can name an ancestor's oid from a
    // PRESENT commit's own recorded parent hash without needing that
    // ancestor's object — so a genuinely hidden merge base requires it to
    // sit at least two hops past the last commit each side actually has:
    // tip -> mid (present, the shallow boundary) -> boundary (ABSENT) ->
    // sharedRoot (ABSENT, only named inside `boundary`'s own object).
    const rootBlob = await blobObject(new TextEncoder().encode("root\n"));
    const rootTree = await treeObject([{ mode: "100644", name: "root.txt", oid: rootBlob.oid }]);
    const sharedRoot = await commitObject({
      tree: rootTree.oid,
      parents: [],
      message: "shared root",
      timestamp: 1_700_000_000,
    });

    async function buildLine(label: string, tipTimestamp: number) {
      // `boundary`'s tree is never dereferenced (only commit headers are read
      // while searching for a merge base), so it's fine to reuse `rootTree`.
      const boundary = await commitObject({
        tree: rootTree.oid,
        parents: [sharedRoot.oid],
        message: `${label} boundary`,
        timestamp: 1_700_000_050,
      });
      const midBlob = await blobObject(new TextEncoder().encode(`${label}-mid\n`));
      const midTree = await treeObject([
        { mode: "100644", name: `${label}-mid.txt`, oid: midBlob.oid },
      ]);
      const mid = await commitObject({
        tree: midTree.oid,
        parents: [boundary.oid],
        message: `${label} shallow boundary`,
        timestamp: 1_700_000_080,
      });
      const tipBlob = await blobObject(new TextEncoder().encode(`${label}-tip\n`));
      const tipTree = await treeObject([
        { mode: "100644", name: `${label}.txt`, oid: tipBlob.oid },
      ]);
      const tip = await commitObject({
        tree: tipTree.oid,
        parents: [mid.oid],
        message: `${label} change`,
        timestamp: tipTimestamp,
      });
      return { boundary, midBlob, midTree, mid, tipBlob, tipTree, tip };
    }

    const native = await buildLine("native", 1_700_000_100);
    const source = await buildLine("source", 1_700_000_110);

    // Place everything from `mid` down to the tip on both sides — the
    // shallow window — but neither `boundary` nor `sharedRoot`.
    for (const o of [
      native.midBlob,
      native.midTree,
      native.mid,
      native.tipBlob,
      native.tipTree,
      native.tip,
      source.midBlob,
      source.midTree,
      source.mid,
      source.tipBlob,
      source.tipTree,
      source.tip,
    ]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }
    await rewindMain(gfs, native.tip.oid);
    await git.writeRef({
      fs: gfs,
      dir: DIR,
      ref: "refs/remotes/source/main",
      value: source.tip.oid,
      force: true,
    });
    // `mid` is the last commit either side actually has — the real shallow
    // boundary, exactly as a real shallow clone/fetch would leave it.
    await writeShallowFile(fs, [native.mid.oid, source.mid.oid]);

    let projectDeepened = false;
    let sourceDeepened = false;
    const deepen: { project: DeepenFetch; source: DeepenFetch } = {
      project: async () => {
        projectDeepened = true;
        // A real `git fetch --deepen` on the project's own history walks
        // back through `boundary` and inevitably reaches the shared root too.
        for (const o of [native.boundary, rootBlob, rootTree, sharedRoot]) {
          await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
        }
        return ok(undefined);
      },
      source: async () => {
        sourceDeepened = true;
        await placeLooseObject(
          gfs as unknown as FsLike,
          gitdir,
          source.boundary.oid,
          source.boundary.bytes,
        );
        // Both sides now reach the shared root — nothing left to hide.
        await clearShallowFile(fs);
        return ok(undefined);
      },
    };

    const result = await applySourceUpdateWithDeepening(
      fs,
      DIR,
      source.tip.oid,
      "refs/remotes/source/main",
      2,
      8,
      deepen,
      logger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("merged");
    // Both sides reported shallow, so both were offered a chance to deepen.
    expect(projectDeepened).toBe(true);
    expect(sourceDeepened).toBe(true);
    // Each synthetic tree is a fresh snapshot rather than an accumulation, so
    // only the tip commits' own files (not the intermediate `mid` commits')
    // survive into the merge result — what matters here is that the merge
    // succeeded at all, finding the ancestor two hops past the shallow window.
    const files = await git.listFiles({ fs: gfs, dir: DIR, ref: "main" });
    expect(files.sort()).toEqual(["native.txt", "source.txt"]);
  });

  it("still fails with SYNC_DIVERGED for genuinely unrelated roots once the cap is reached", async () => {
    const { fs, gfs } = await initRepo();
    const gitdir = `${DIR}/.git`;

    // Two independent root commits — no shared ancestor exists at any depth.
    const nativeBlob = await blobObject(new TextEncoder().encode("native\n"));
    const nativeTree = await treeObject([
      { mode: "100644", name: "native.txt", oid: nativeBlob.oid },
    ]);
    const nativeRoot = await commitObject({
      tree: nativeTree.oid,
      parents: [],
      message: "native root",
      timestamp: 1_700_000_000,
    });
    const sourceBlob = await blobObject(new TextEncoder().encode("source\n"));
    const sourceTree = await treeObject([
      { mode: "100644", name: "source.txt", oid: sourceBlob.oid },
    ]);
    const sourceRoot = await commitObject({
      tree: sourceTree.oid,
      parents: [],
      message: "source root",
      timestamp: 1_700_000_000,
    });
    for (const o of [nativeBlob, nativeTree, nativeRoot, sourceBlob, sourceTree, sourceRoot]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }
    await rewindMain(gfs, nativeRoot.oid);
    await git.writeRef({
      fs: gfs,
      dir: DIR,
      ref: "refs/remotes/source/main",
      value: sourceRoot.oid,
      force: true,
    });
    // Both roots are (artificially) marked shallow throughout: there is
    // nothing more to reveal, but the point of this test is the algorithm's
    // OWN bound — it must give up at the cap rather than loop forever
    // whenever local bookkeeping keeps saying "maybe more history exists".
    await writeShallowFile(fs, [nativeRoot.oid, sourceRoot.oid]);

    let deepenCalls = 0;
    const deepen: { project: DeepenFetch; source: DeepenFetch } = {
      project: async () => {
        deepenCalls++;
        return ok(undefined);
      },
      source: async () => {
        deepenCalls++;
        return ok(undefined);
      },
    };

    const result = await applySourceUpdateWithDeepening(
      fs,
      DIR,
      sourceRoot.oid,
      "refs/remotes/source/main",
      2,
      8,
      deepen,
      logger,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(result.error.context?.missingMergeBase).toBe(true);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeRoot.oid);
    // Window doubles 2 -> 4 -> 8 (cap), so exactly two deepen rounds run on
    // each side before the loop refuses to grow the window any further.
    expect(deepenCalls).toBe(4);
  });
});
