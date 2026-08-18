import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import { type NodeFS, squashMerge } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { placeLooseObject } from "../src/storage/object-loader";
import type { Logger } from "../src/utils/logger";

const enc = (s: string) => new TextEncoder().encode(s);
const author = { name: "Stratum", email: "system@usestratum.dev" };

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Logger;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Encode one git pkt-line (4-hex-digit length prefix covering itself). */
function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? enc(payload) : payload;
  const len = (bytes.length + 4).toString(16).padStart(4, "0");
  return concat(enc(len), bytes);
}

const FLUSH = enc("0000");

/**
 * Minimal git smart-HTTP receive-pack server: advertises `main` at `mainOid`
 * and accepts any push with report-status over side-band-64k. Just enough for
 * isomorphic-git's `git.push` to complete against a stubbed `fetch`.
 */
function stubReceivePackServer(mainOid: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/info/refs?service=git-receive-pack")) {
      const body = concat(
        pkt("# service=git-receive-pack\n"),
        FLUSH,
        pkt(`${mainOid} refs/heads/main\0report-status side-band-64k\n`),
        FLUSH,
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-advertisement" },
      });
    }
    if (url.endsWith("/git-receive-pack")) {
      const report = concat(pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), FLUSH);
      const channel1 = new Uint8Array(1 + report.length);
      channel1[0] = 1; // side-band channel 1: pack/report data
      channel1.set(report, 1);
      const body = concat(pkt(channel1), FLUSH);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("squashMerge preserves file modes and symlinks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries exec bits, symlink changes, and additions into the squash commit", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base tree: plain file, non-exec script, symlink -> file.txt, and a file
    // the workspace deletes.
    const fileBlob = await blobObject(enc("base\n"));
    const scriptBlob = await blobObject(enc("#!/bin/sh\nexit 0\n"));
    const linkToFile = await blobObject(enc("file.txt"));
    const goneBlob = await blobObject(enc("bye\n"));
    const baseTree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "100644", name: "script.sh", oid: scriptBlob.oid },
      { mode: "120000", name: "link", oid: linkToFile.oid },
      { mode: "100644", name: "gone.txt", oid: goneBlob.oid },
    ]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // Workspace tree: script.sh becomes executable (same blob — a mode-only
    // change), the symlink is retargeted, a new symlink appears, gone.txt is
    // deleted, file.txt is untouched.
    const linkToScript = await blobObject(enc("script.sh"));
    const wsTree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "100755", name: "script.sh", oid: scriptBlob.oid },
      { mode: "120000", name: "link", oid: linkToScript.oid },
      { mode: "120000", name: "newlink", oid: linkToFile.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [fileBlob, scriptBlob, linkToFile, goneBlob, baseTree, base]) {
      await placeLooseObject(fs as never, gitdir, o.oid, o.bytes);
    }
    for (const o of [linkToScript, wsTree, ws]) {
      await placeLooseObject(fs as never, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);

    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.parent).toEqual([base.oid]);
    const tree = await git.readTree({ fs: gitfs, dir, oid: commit.commit.tree });
    const byPath = new Map(tree.tree.map((e) => [e.path, e]));

    // Exec bit carried over even though the blob is unchanged.
    expect(byPath.get("script.sh")?.mode).toBe("100755");
    expect(byPath.get("script.sh")?.oid).toBe(scriptBlob.oid);
    // Retargeted symlink stays a symlink with the new target.
    expect(byPath.get("link")?.mode).toBe("120000");
    expect(byPath.get("link")?.oid).toBe(linkToScript.oid);
    // New symlink created as a symlink.
    expect(byPath.get("newlink")?.mode).toBe("120000");
    expect(byPath.get("newlink")?.oid).toBe(linkToFile.oid);
    // Untouched + deleted files behave as before.
    expect(byPath.get("file.txt")?.mode).toBe("100644");
    expect(byPath.get("gone.txt")).toBeUndefined();
    // The squash tree equals the workspace tree exactly — full fidelity.
    expect(commit.commit.tree).toBe(wsTree.oid);

    // The workdir mirrors the commit.
    const linkTarget = await raw.promises.readlink("/link");
    expect(linkTarget.success && linkTarget.data === "script.sh").toBe(true);
    const scriptStat = await raw.promises.lstat("/script.sh");
    expect(scriptStat.success && scriptStat.data.mode === 0o100755).toBe(true);
  });

  it("returns the current head untouched when nothing changed", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    const fileBlob = await blobObject(enc("same\n"));
    const tree = await treeObject([{ mode: "100644", name: "file.txt", oid: fileBlob.oid }]);
    const base = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    const ws = await commitObject({
      tree: tree.oid,
      parents: [base.oid],
      message: "no-op",
      timestamp: 1700000001,
    });
    for (const o of [fileBlob, tree, base, ws]) {
      await placeLooseObject(fs as never, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    const fetchSpy = stubReceivePackServer(base.oid);

    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(base.oid);
    // No changes -> no push.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
