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

/** Rewind `branch` to `sha` (simulates the local repo not yet having later
 * commits). Takes the branch name so the non-main-default cases can reuse it. */
async function rewindBranch(gfs: GitFS, sha: string, branch = "main") {
  await git.writeRef({ fs: gfs, dir: DIR, ref: `refs/heads/${branch}`, value: sha, force: true });
  await git.checkout({ fs: gfs, dir: DIR, ref: branch, force: true });
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

/**
 * Builds the one history shape that genuinely hides a merge base from
 * isomorphic-git, and places only the in-window objects on disk.
 *
 * Exists because that shape is fiddly enough to be worth stating once: the
 * merge-base search can name an ancestor's oid from a PRESENT commit's own
 * recorded parent hash without needing that ancestor's object, so the shared
 * root has to sit at least two hops past the last commit each side really has
 * — tip -> mid (present, the shallow boundary) -> boundary (ABSENT) ->
 * sharedRoot (ABSENT, only named inside `boundary`'s own object). The absent
 * objects are returned so the caller's deepen callbacks can place them, which
 * is how a deepening fetch is simulated.
 */
async function buildHiddenMergeBaseHistory(gfs: GitFS, gitdir: string) {
  const rootBlob = await blobObject(new TextEncoder().encode("root\n"));
  const rootTree = await treeObject([{ mode: "100644", name: "root.txt", oid: rootBlob.oid }]);
  const sharedRoot = await commitObject({
    tree: rootTree.oid,
    parents: [],
    message: "shared root",
    timestamp: 1_700_000_000,
  });

  /**
   * Builds one side's four-commit line off the shared root. Factored out
   * because both sides must be shaped IDENTICALLY for the fixture to prove
   * anything: if one line were shorter, the merge base could be found from the
   * objects already on disk and the test would pass without any deepening.
   * `tipTimestamp` is the caller's, so the two tips can be ordered relative to
   * each other — commit age decides the order isomorphic-git walks history in.
   */
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
    const tipTree = await treeObject([{ mode: "100644", name: `${label}.txt`, oid: tipBlob.oid }]);
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

  // Place everything from `mid` down to the tip on both sides — the shallow
  // window — but neither `boundary` nor `sharedRoot`.
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

  return { rootBlob, rootTree, sharedRoot, native, source };
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
    await rewindBranch(gfs, base);

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
    await rewindBranch(gfs, base);
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
    await rewindBranch(gfs, base);
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

    const { rootBlob, rootTree, sharedRoot, native, source } = await buildHiddenMergeBaseHistory(
      gfs,
      gitdir,
    );
    await rewindBranch(gfs, native.tip.oid);
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
    await rewindBranch(gfs, nativeRoot.oid);
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

  // The window only ever advances by doubling, so a `startDepth` of 0 leaves
  // `nextWindow` equal to `window` and `increment` at 0: every round deepens by
  // nothing, the refs stay shallow so the both-sides-complete `break` never
  // fires, and `window < maxDepth` holds forever. Unreachable from
  // `syncFromGitHub`'s default, but this function is exported and takes the
  // depth from its caller. A short timeout so a regression fails fast instead
  // of hanging the suite.
  it(
    "terminates when the caller supplies a non-positive start depth",
    { timeout: 2000 },
    async () => {
      const { fs, gfs } = await initRepo();
      const gitdir = `${DIR}/.git`;

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
      await rewindBranch(gfs, nativeRoot.oid);
      await git.writeRef({
        fs: gfs,
        dir: DIR,
        ref: "refs/remotes/source/main",
        value: sourceRoot.oid,
        force: true,
      });
      // Both sides stay shallow for the whole run, so nothing but the window
      // bound can end the loop -- which is the property under test.
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
        0,
        8,
        deepen,
        logger,
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("SYNC_DIVERGED");
      // Floored to 1, the window doubles 1 -> 2 -> 4 -> 8 (cap): three rounds,
      // two deepen calls each. Unfloored it would never leave 0.
      expect(deepenCalls).toBe(6);
    },
  );
  // #240: the deepening retry is gated on `missingMergeBase === true`, which
  // `applySourceUpdate` derives by resolving the project's branch. Resolving a
  // hardcoded "main" instead of the branch actually in play fails on a project
  // whose default is trunk/master, and `isMissingMergeBase` reports `false` on
  // a failed resolve — so the whole feature silently switched itself off for
  // those projects and sync fell straight back to SYNC_DIVERGED. "trunk" is
  // used deliberately: this repo has no `main` ref at all, so a stray default
  // cannot make this pass by accident.
  it("deepens and retries for a project whose default branch is not main", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const gfs = fs as GitFS;
    await git.init({ fs: gfs, dir: DIR, defaultBranch: "trunk" });
    const gitdir = `${DIR}/.git`;

    const { rootBlob, rootTree, sharedRoot, native, source } = await buildHiddenMergeBaseHistory(
      gfs,
      gitdir,
    );

    await rewindBranch(gfs, native.tip.oid, "trunk");
    await git.writeRef({
      fs: gfs,
      dir: DIR,
      ref: "refs/remotes/source/trunk",
      value: source.tip.oid,
      force: true,
    });
    await writeShallowFile(fs, [native.mid.oid, source.mid.oid]);
    // Nothing anywhere in this repo answers to "main".
    await expect(git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).rejects.toThrow();

    let projectDeepened = false;
    let sourceDeepened = false;
    const deepen: { project: DeepenFetch; source: DeepenFetch } = {
      project: async () => {
        projectDeepened = true;
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
        await clearShallowFile(fs);
        return ok(undefined);
      },
    };

    const result = await applySourceUpdateWithDeepening(
      fs,
      DIR,
      source.tip.oid,
      "refs/remotes/source/trunk",
      2,
      8,
      deepen,
      logger,
      "trunk",
    );

    // The retry loop ran at all — the assertion that fails if the missing-base
    // probe goes back to looking up a hardcoded "main".
    expect(projectDeepened).toBe(true);
    expect(sourceDeepened).toBe(true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("merged");
    const files = await git.listFiles({ fs: gfs, dir: DIR, ref: "trunk" });
    expect(files.sort()).toEqual(["native.txt", "source.txt"]);
  });

  // Regression: `isRefShallow` used to judge a ref by its OLDEST reachable
  // commit alone. A merge commit can reach two lines at once — one truncated at
  // a `.git/shallow` boundary, one complete back to an older root — and then the
  // globally oldest commit is that complete root, not the boundary. The ref was
  // therefore reported non-shallow, the deepening loop broke out immediately,
  // and sync failed with SYNC_DIVERGED while the merge base was still one fetch
  // away. Shaped so ONLY the project side is truncated: if the check regresses,
  // no side looks shallow and nothing is deepened at all.
  it("deepens a branch whose merge commit reaches both a shallow boundary and an older complete root", async () => {
    const { fs, gfs } = await initRepo();
    const gitdir = `${DIR}/.git`;

    const { rootBlob, rootTree, sharedRoot, native, source } = await buildHiddenMergeBaseHistory(
      gfs,
      gitdir,
    );
    // The source side is COMPLETE here — its own boundary commit and the shared
    // root are already on disk, so nothing about it is shallow.
    for (const o of [source.boundary, rootBlob, rootTree, sharedRoot]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }

    // An unrelated, fully-present root that is OLDER than anything in the
    // shallow window — this is what makes the oldest reachable commit the wrong
    // commit to judge shallowness by.
    const legacyBlob = await blobObject(new TextEncoder().encode("legacy\n"));
    const legacyTree = await treeObject([
      { mode: "100644", name: "legacy.txt", oid: legacyBlob.oid },
    ]);
    const legacyRoot = await commitObject({
      tree: legacyTree.oid,
      parents: [],
      message: "legacy root",
      timestamp: 1_699_000_000,
    });
    // The merge commit itself: one parent walks into the truncated native line,
    // the other into the complete legacy root. Reuses the native tip's tree so
    // the eventual three-way merge is the same clean one the other cases make.
    const mergeTip = await commitObject({
      tree: native.tipTree.oid,
      parents: [native.tip.oid, legacyRoot.oid],
      message: "merge legacy history",
      timestamp: 1_700_000_120,
    });
    for (const o of [legacyBlob, legacyTree, legacyRoot, mergeTip]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }

    await rewindBranch(gfs, mergeTip.oid);
    await git.writeRef({
      fs: gfs,
      dir: DIR,
      ref: "refs/remotes/source/main",
      value: source.tip.oid,
      force: true,
    });
    // Only the native line is truncated.
    await writeShallowFile(fs, [native.mid.oid]);

    // Precondition guard: the fixture only exercises the bug while the oldest
    // reachable commit is the complete root rather than the shallow boundary.
    const walk = await git.log({ fs: gfs, dir: DIR, ref: "main" });
    expect(walk.at(-1)?.oid).toBe(legacyRoot.oid);
    expect(walk.map((c) => c.oid)).toContain(native.mid.oid);

    let projectDeepened = false;
    let sourceDeepened = false;
    const deepen: { project: DeepenFetch; source: DeepenFetch } = {
      project: async () => {
        projectDeepened = true;
        await placeLooseObject(
          gfs as unknown as FsLike,
          gitdir,
          native.boundary.oid,
          native.boundary.bytes,
        );
        // The native line now reaches the shared root too — nothing left to hide.
        await clearShallowFile(fs);
        return ok(undefined);
      },
      source: async () => {
        sourceDeepened = true;
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

    // The assertion that fails if shallowness is judged by the oldest commit.
    expect(projectDeepened).toBe(true);
    // The source has its full history already; re-fetching it would be wasted work.
    expect(sourceDeepened).toBe(false);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("merged");
    const mergedFiles = await git.listFiles({ fs: gfs, dir: DIR, ref: "main" });
    expect(mergedFiles.sort()).toEqual(["native.txt", "source.txt"]);
  });
});
