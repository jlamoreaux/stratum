import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructRepo, restoreProjectRepo } from "../src/backup/repo-restore";
import { type RepoManifest, buildSnapshot, walkRepoObjects } from "../src/backup/repo-snapshot";
import type { NodeFS } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Only `push` (the sole Artifacts-coupled git call in the restore path) is
// mocked; every other git function runs for real against MemoryFS so the
// round-trip below proves genuine object stores, not stubs.
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: { ...actual.default, push: (args: unknown) => mockPush(args) },
  };
});

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const SRC = "/src";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };
const tagger = { name: "tagger", email: "tag@x.com", timestamp: 1_700_000_100, timezoneOffset: 0 };
const MISSING_OID = "f".repeat(40);

const project: ProjectEntry = {
  id: "p1",
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "u1",
  ownerType: "user",
  remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function buildRepo(
  commits: Record<string, string>[],
): Promise<{ fs: NodeFS; shas: string[] }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  await git.init({ fs, dir: SRC, defaultBranch: "main" });
  const shas: string[] = [];
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      await (fs as any).promises.writeFile(`${SRC}/${path}`, content);
      await git.add({ fs, dir: SRC, filepath: path });
    }
    shas.push(await git.commit({ fs, dir: SRC, message: "c", author }));
  }
  return { fs, shas };
}

/** A repo whose second commit is reachable ONLY via refs/tags/keep (an
 * annotated tag): main is reset back to the first commit. */
async function buildTaggedRepo(): Promise<{
  fs: NodeFS;
  c1: string;
  c2: string;
  keepOid: string;
}> {
  const { fs, shas } = await buildRepo([{ "a.txt": "one" }, { "side.txt": "tag-only" }]);
  const [c1, c2] = shas as [string, string];
  await git.annotatedTag({
    fs,
    dir: SRC,
    ref: "keep",
    object: c2,
    message: "kept release\n",
    tagger,
  });
  await git.tag({ fs, dir: SRC, ref: "lw", object: c1 });
  // Rewind main so c2 is only reachable through the tag.
  await git.writeRef({ fs, dir: SRC, ref: "refs/heads/main", value: c1, force: true });
  const keepOid = await git.resolveRef({ fs, dir: SRC, ref: "refs/tags/keep" });
  return { fs, c1, c2, keepOid };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backup walk with tags", () => {
  it("captures tag refs, annotated tag objects, and commits reachable only from tags", async () => {
    const { fs, c1, c2, keepOid } = await buildTaggedRepo();

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");

    // HEAD tip is still main's tip.
    expect(walk.data.tipSha).toBe(c1);
    // Both refs recorded (sorted), pointing at the tag object / target.
    expect(walk.data.tags).toEqual([
      { name: "keep", oid: keepOid },
      { name: "lw", oid: c1 },
    ]);
    // The pack closes over the tag: the annotated tag object AND the tag-only
    // commit (plus its tree/blob) are included.
    const oids = walk.data.objects.map((o) => o.oid);
    expect(oids).toContain(keepOid);
    expect(oids).toContain(c2);
    expect(oids).toContain(c1);
    expect(new Set(oids).size).toBe(oids.length); // still deduped

    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    expect(snap.manifest.tags).toEqual(walk.data.tags);
  });

  it("captures tags pointing at trees and blobs, not just commits", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const c1 = shas[0] as string;
    const commit = await git.readCommit({ fs, dir: SRC, oid: c1 });
    const treeOid = commit.commit.tree;
    const tree = await git.readTree({ fs, dir: SRC, oid: treeOid });
    const blobOid = tree.tree[0]?.oid as string;
    await git.tag({ fs, dir: SRC, ref: "tree-tag", object: treeOid });
    await git.tag({ fs, dir: SRC, ref: "blob-tag", object: blobOid });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags.map((t) => t.name)).toEqual(["blob-tag", "tree-tag"]);
  });

  it("skips (with a warning) a tag whose object is missing, keeping the pack closed", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/ghost", value: MISSING_OID, force: true });
    await git.tag({ fs, dir: SRC, ref: "good", object: shas[0] });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    // The dangling ref is NOT recorded — restoring it would fail the readObject
    // guard — but the healthy tag still is.
    expect(walk.data.tags.map((t) => t.name)).toEqual(["good"]);
    expect(walk.data.objects.map((o) => o.oid)).not.toContain(MISSING_OID);
    expect(logger.warn).toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.objectContaining({ name: "ghost" }),
    );
  });

  it("aborts with tooLarge when the tag walk pushes the byte total over the cap", async () => {
    // Measure the HEAD-only byte count first…
    const headOnly = await buildRepo([{ "a.txt": "one" }]);
    const headWalk = await walkRepoObjects(headOnly.fs, SRC, 10_000_000, logger);
    if (!headWalk.success || !("objects" in headWalk.data)) throw new Error("walk failed");
    const headBytes = headWalk.data.objects.reduce((n, o) => n + o.bytes.byteLength, 0);

    // …then add a big tag-only commit and cap just above the HEAD walk.
    const { fs } = await buildTaggedRepoWithBigTag();
    const walk = await walkRepoObjects(fs, SRC, headBytes + 32, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("tooLarge" in walk.data).toBe(true);
  });

  async function buildTaggedRepoWithBigTag(): Promise<{ fs: NodeFS }> {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }, { "big.txt": "x".repeat(5000) }]);
    const [c1, c2] = shas as [string, string];
    await git.tag({ fs, dir: SRC, ref: "big", object: c2 });
    await git.writeRef({ fs, dir: SRC, ref: "refs/heads/main", value: c1, force: true });
    return { fs };
  }

  it("aborts with tooLarge when a blob-only tag overflows the cap", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    // A big blob referenced by NO commit — only the tag reaches it.
    const blobOid = await git.writeBlob({
      fs,
      dir: SRC,
      blob: new TextEncoder().encode("y".repeat(5000)),
    });
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/fat-blob", value: blobOid, force: true });

    const headWalk = await walkRepoObjects(
      (await buildRepo([{ "a.txt": "one" }])).fs,
      SRC,
      10_000_000,
      logger,
    );
    if (!headWalk.success || !("objects" in headWalk.data)) throw new Error("walk failed");
    const headBytes = headWalk.data.objects.reduce((n, o) => n + o.bytes.byteLength, 0);

    const walk = await walkRepoObjects(fs, SRC, headBytes + 32, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("tooLarge" in walk.data).toBe(true);
  });
});

describe("restore round-trip with tags", () => {
  it("reconstructs tag refs alongside main and preserves annotated metadata", async () => {
    const { fs, c1, c2, keepOid } = await buildTaggedRepo();
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    const { fs: rfs, dir } = rebuilt.data;

    expect(await git.resolveRef({ fs: rfs, dir, ref: "main" })).toBe(c1);
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/tags/keep" })).toBe(keepOid);
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/tags/lw" })).toBe(c1);

    // The annotated tag object survived with its message and still peels to the
    // tag-only commit, whose content is intact.
    const tag = await git.readTag({ fs: rfs, dir, oid: keepOid });
    expect(tag.tag.message.trim()).toBe("kept release");
    expect(tag.tag.object).toBe(c2);
    const files = await git.listFiles({ fs: rfs, dir, ref: c2 });
    expect(files.sort()).toEqual(["a.txt", "side.txt"]);
  });

  it("still restores an OLD-format manifest without a tags field", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    // Simulate a manifest written before tag support (JSON round-trip drops the key).
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.tags;

    const rebuilt = await reconstructRepo(snap.pack, legacy, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    expect(await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "main" })).toBe(
      shas[0],
    );
  });

  it("fails reconstruction when a manifest tag's object is missing from the pack", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    snap.manifest.tags = [...(snap.manifest.tags ?? []), { name: "bogus", oid: MISSING_OID }];
    void shas;

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(false);
  });
});

describe("restoreProjectRepo tag push", () => {
  function makeEnv(deleteFn = vi.fn(async () => true)): { env: Env; deleteFn: typeof deleteFn } {
    const env = {
      ARTIFACTS: {
        get: vi.fn(async () => null),
        create: vi.fn(async () => ({
          name: "repo",
          remote: project.remote,
          token: "tok",
        })),
        delete: deleteFn,
      } as unknown as Env["ARTIFACTS"],
    } as Env;
    return { env, deleteFn };
  }

  async function makeSnapshot() {
    const { fs, keepOid } = await buildTaggedRepo();
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    return { snap: buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z"), keepOid };
  }

  it("pushes main first, then every tag ref", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await makeSnapshot();

    const result = await restoreProjectRepo(env, snap, {}, logger);
    expect(result.success).toBe(true);
    const refs = mockPush.mock.calls.map((c) => (c[0] as { ref: string }).ref);
    expect(refs).toEqual(["main", "refs/tags/keep", "refs/tags/lw"]);
  });

  it("pushes only main for an old-format manifest without tags", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await makeSnapshot();
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.tags;

    const result = await restoreProjectRepo(env, { pack: snap.pack, manifest: legacy }, {}, logger);
    expect(result.success).toBe(true);
    expect(mockPush.mock.calls.map((c) => (c[0] as { ref: string }).ref)).toEqual(["main"]);
  });

  it("rolls back a freshly created repo when a tag push fails", async () => {
    // main push succeeds, the first tag push fails.
    mockPush.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("tag rejected"));
    const { env, deleteFn } = makeEnv();
    const { snap } = await makeSnapshot();

    const result = await restoreProjectRepo(env, snap, {}, logger);
    expect(result.success).toBe(false);
    expect(deleteFn).toHaveBeenCalledWith("repo");
  });
});
