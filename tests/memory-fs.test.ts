import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import { MemoryFS } from "../src/storage/memory-fs";
import { type FsLike, placeLooseObject } from "../src/storage/object-loader";

describe("MemoryFS", () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  describe("normalize", () => {
    it("returns / for empty path", () => expect(fs.normalize("/")).toBe("/"));
    it("collapses double slashes", () => expect(fs.normalize("//a//b")).toBe("/a/b"));
    it("resolves dot segments", () => expect(fs.normalize("/a/./b")).toBe("/a/b"));
    it("resolves dotdot segments", () => expect(fs.normalize("/a/b/../c")).toBe("/a/c"));
    it("does not escape root", () => expect(fs.normalize("/../../a")).toBe("/a"));
    it("adds leading slash", () => expect(fs.normalize("a/b")).toBe("/a/b"));
  });

  describe("mkdir", () => {
    it("creates a directory", async () => {
      const result = await fs.mkdir("/foo");
      expect(result.success).toBe(true);
      const stat = await fs.stat("/foo");
      expect(stat.success).toBe(true);
      if (stat.success) {
        expect(stat.data.isDirectory()).toBe(true);
      }
    });

    it("creates nested dirs with recursive", async () => {
      const result = await fs.mkdir("/a/b/c", { recursive: true });
      expect(result.success).toBe(true);
      const stat = await fs.stat("/a/b/c");
      expect(stat.success).toBe(true);
      if (stat.success) {
        expect(stat.data.isDirectory()).toBe(true);
      }
    });

    it("returns error for missing parent without recursive", async () => {
      const result = await fs.mkdir("/a/b");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("ENOENT");
      }
    });

    it("is idempotent with recursive", async () => {
      await fs.mkdir("/foo", { recursive: true });
      const result = await fs.mkdir("/foo", { recursive: true });
      expect(result.success).toBe(true);
    });

    it("fails recursively under a file ancestor", async () => {
      await fs.writeFile("/f.txt", "x");
      const result = await fs.mkdir("/f.txt/a/b", { recursive: true });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("ENOTDIR");
    });
  });

  // A failed operation must not leave anything behind. Because the parent's
  // child set is only updated on success, a stranded entry is invisible to
  // readdir while still being readable by path -- the worst shape for a bug,
  // since nothing enumerating the tree would ever surface it.
  describe("failed writes leave no observable entry", () => {
    it("writeFile below a file parent fails and strands nothing", async () => {
      await fs.writeFile("/f.txt", "iam a file");
      const write = await fs.writeFile("/f.txt/child", "x");
      expect(write.success).toBe(false);
      if (!write.success) expect(write.error.code).toBe("ENOTDIR");

      const read = await fs.readFile("/f.txt/child", "utf8");
      expect(read.success).toBe(false);
      const stat = await fs.stat("/f.txt/child");
      expect(stat.success).toBe(false);
    });

    it("recursive mkdir below a file parent fails and strands nothing", async () => {
      await fs.writeFile("/f.txt", "iam a file");
      const made = await fs.mkdir("/f.txt/sub", { recursive: true });
      expect(made.success).toBe(false);
      if (!made.success) expect(made.error.code).toBe("ENOTDIR");

      const stat = await fs.stat("/f.txt/sub");
      expect(stat.success).toBe(false);
    });

    it("mkdir over an existing file reports ENOTDIR rather than succeeding", async () => {
      await fs.writeFile("/f.txt", "iam a file");
      const made = await fs.mkdir("/f.txt", { recursive: true });
      expect(made.success).toBe(false);
      if (!made.success) expect(made.error.code).toBe("ENOTDIR");
      // The file is untouched.
      const read = await fs.readFile("/f.txt", "utf8");
      expect(read.success && read.data === "iam a file").toBe(true);
    });

    // mkdir does not follow links, so a symlink parent is a non-directory.
    it("writeFile below a symlink parent fails and strands nothing", async () => {
      await fs.mkdir("/real");
      await fs.symlink("real", "/link");
      const write = await fs.writeFile("/link/nested/file.ts", "x");
      expect(write.success).toBe(false);

      const stat = await fs.stat("/link/nested/file.ts");
      expect(stat.success).toBe(false);
      // Nothing leaked into the link's target either.
      const leaked = await fs.readFile("/real/nested/file.ts", "utf8");
      expect(leaked.success).toBe(false);
    });

    it("mkdir over an existing directory stays a no-op", async () => {
      await fs.mkdir("/d");
      await fs.writeFile("/d/keep.txt", "kept");
      const again = await fs.mkdir("/d", { recursive: true });
      expect(again.success).toBe(true);
      const read = await fs.readFile("/d/keep.txt", "utf8");
      expect(read.success && read.data === "kept").toBe(true);
    });
  });

  describe("writeFile / readFile", () => {
    it("writes and reads a string", async () => {
      const writeResult = await fs.writeFile("/hello.txt", "hello");
      expect(writeResult.success).toBe(true);
      const result = await fs.readFile("/hello.txt", { encoding: "utf8" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("hello");
      }
    });

    it("writes and reads binary", async () => {
      const data = new Uint8Array([1, 2, 3]);
      const writeResult = await fs.writeFile("/bin.dat", data);
      expect(writeResult.success).toBe(true);
      const result = await fs.readFile("/bin.dat");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(data);
      }
    });

    it("writes an ArrayBuffer", async () => {
      const data = new Uint8Array([4, 5, 6]);
      const writeResult = await fs.writeFile("/buf.dat", data.buffer);
      expect(writeResult.success).toBe(true);
      const result = await fs.readFile("/buf.dat");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(data);
      }
    });

    it("creates parent directories automatically", async () => {
      const writeResult = await fs.writeFile("/deep/nested/file.txt", "content");
      expect(writeResult.success).toBe(true);
      const stat = await fs.stat("/deep/nested");
      expect(stat.success).toBe(true);
      if (stat.success) {
        expect(stat.data.isDirectory()).toBe(true);
      }
    });

    it("overwrites existing file", async () => {
      await fs.writeFile("/f.txt", "v1");
      await fs.writeFile("/f.txt", "v2");
      const result = await fs.readFile("/f.txt", "utf8");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("v2");
      }
    });

    it("returns error for missing file", async () => {
      const result = await fs.readFile("/missing.txt");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("ENOENT");
      }
    });

    it("returns error when reading a directory", async () => {
      await fs.mkdir("/dir");
      const result = await fs.readFile("/dir");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("EISDIR");
      }
    });

    it("returns error when writing to the root directory", async () => {
      const result = await fs.writeFile("/", "x");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("EISDIR");
      }
    });
  });

  describe("readdir", () => {
    it("lists directory contents sorted", async () => {
      await fs.writeFile("/b.txt", "");
      await fs.writeFile("/a.txt", "");
      const entries = await fs.readdir("/");
      expect(entries.success).toBe(true);
      if (entries.success) {
        expect(entries.data).toContain("a.txt");
        expect(entries.data).toContain("b.txt");
      }
    });

    it("returns error for missing directory", async () => {
      const result = await fs.readdir("/nope");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("ENOENT");
      }
    });
  });

  describe("unlink", () => {
    it("removes a file", async () => {
      await fs.writeFile("/f.txt", "");
      const unlinkResult = await fs.unlink("/f.txt");
      expect(unlinkResult.success).toBe(true);
      const stat = await fs.stat("/f.txt");
      expect(stat.success).toBe(false);
    });

    it("removes file from parent readdir", async () => {
      await fs.writeFile("/f.txt", "");
      await fs.unlink("/f.txt");
      const entries = await fs.readdir("/");
      expect(entries.success).toBe(true);
      if (entries.success) {
        expect(entries.data).not.toContain("f.txt");
      }
    });

    it("returns error for directory", async () => {
      await fs.mkdir("/dir");
      const result = await fs.unlink("/dir");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("EISDIR");
      }
    });
  });

  describe("rmdir", () => {
    it("removes empty directory", async () => {
      await fs.mkdir("/empty");
      const rmdirResult = await fs.rmdir("/empty");
      expect(rmdirResult.success).toBe(true);
      const stat = await fs.stat("/empty");
      expect(stat.success).toBe(false);
    });

    it("returns error for non-empty directory", async () => {
      await fs.writeFile("/dir/file.txt", "");
      const result = await fs.rmdir("/dir");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("ENOTEMPTY");
      }
    });
  });

  describe("stat / lstat", () => {
    it("reports file stats correctly", async () => {
      await fs.writeFile("/f.txt", "hi");
      const s = await fs.stat("/f.txt");
      expect(s.success).toBe(true);
      if (s.success) {
        expect(s.data.isFile()).toBe(true);
        expect(s.data.isDirectory()).toBe(false);
        expect(s.data.isSymbolicLink()).toBe(false);
        expect(s.data.size).toBe(2);
        expect(s.data.mode).toBe(0o100644);
      }
    });

    it("reports directory stats correctly", async () => {
      await fs.mkdir("/dir");
      const s = await fs.stat("/dir");
      expect(s.success).toBe(true);
      if (s.success) {
        expect(s.data.isFile()).toBe(false);
        expect(s.data.isDirectory()).toBe(true);
        expect(s.data.size).toBe(0);
        expect(s.data.mode).toBe(0o040000);
      }
    });

    it("stat and lstat return same result for files", async () => {
      await fs.writeFile("/f.txt", "x");
      const stat = await fs.stat("/f.txt");
      const lstat = await fs.lstat("/f.txt");
      expect(stat.success).toBe(true);
      expect(lstat.success).toBe(true);
      if (stat.success && lstat.success) {
        expect(stat.data.isFile()).toBe(lstat.data.isFile());
        expect(stat.data.size).toBe(lstat.data.size);
      }
    });

    it("honors an assigned mode override on the stats instance", async () => {
      await fs.writeFile("/f.txt", "x");
      const s = await fs.stat("/f.txt");
      expect(s.success).toBe(true);
      if (s.success) {
        s.data.mode = 0o755;
        expect(s.data.mode).toBe(0o755);
      }
    });

    it("warns when a gitlink mode is assigned (submodules unsupported)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await fs.mkdir("/sub");
        const s = await fs.lstat("/sub");
        expect(s.success).toBe(true);
        if (s.success) {
          s.data.mode = 0o160000;
          expect(s.data.mode).toBe(0o160000);
        }
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain("gitlink");
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("file modes", () => {
    it("defaults new files to 100644", async () => {
      await fs.writeFile("/f.txt", "x");
      const s = await fs.lstat("/f.txt");
      expect(s.success).toBe(true);
      if (s.success) expect(s.data.mode).toBe(0o100644);
    });

    it("stores 100755 when written with an executable mode", async () => {
      await fs.writeFile("/run.sh", "#!/bin/sh\n", { mode: 0o777 });
      const s = await fs.lstat("/run.sh");
      expect(s.success).toBe(true);
      if (s.success) expect(s.data.mode).toBe(0o100755);
    });

    it("normalizes any exec bit to 100755 and none to 100644", async () => {
      await fs.writeFile("/a.sh", "a", { mode: 0o100 });
      await fs.writeFile("/b.txt", "b", { mode: 0o644 });
      const a = await fs.lstat("/a.sh");
      const b = await fs.lstat("/b.txt");
      expect(a.success && a.data.mode === 0o100755).toBe(true);
      expect(b.success && b.data.mode === 0o100644).toBe(true);
    });

    it("preserves the existing mode on overwrite without an explicit mode", async () => {
      await fs.writeFile("/run.sh", "v1", { mode: 0o755 });
      await fs.writeFile("/run.sh", "v2");
      const s = await fs.lstat("/run.sh");
      expect(s.success).toBe(true);
      if (s.success) expect(s.data.mode).toBe(0o100755);
    });

    it("changes the mode on overwrite with an explicit mode", async () => {
      await fs.writeFile("/run.sh", "v1", { mode: 0o755 });
      await fs.writeFile("/run.sh", "v2", { mode: 0o644 });
      const s = await fs.lstat("/run.sh");
      expect(s.success).toBe(true);
      if (s.success) expect(s.data.mode).toBe(0o100644);
    });

    it("returns error when writing under a file parent", async () => {
      await fs.writeFile("/f.txt", "x");
      const result = await fs.writeFile("/f.txt/child", "y");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("ENOTDIR");
      const deep = await fs.writeFile("/f.txt/sub/child", "y");
      expect(deep.success).toBe(false);
      if (!deep.success) expect(deep.error.code).toBe("ENOTDIR");
    });
  });

  describe("symlinks", () => {
    it("round-trips symlink → readlink", async () => {
      await fs.writeFile("/target.txt", "hello");
      const linkResult = await fs.symlink("target.txt", "/link");
      expect(linkResult.success).toBe(true);
      const target = await fs.readlink("/link");
      expect(target.success).toBe(true);
      if (target.success) expect(target.data).toBe("target.txt");
    });

    it("lstat reports isSymbolicLink and mode 120000", async () => {
      await fs.symlink("target.txt", "/link");
      const s = await fs.lstat("/link");
      expect(s.success).toBe(true);
      if (s.success) {
        expect(s.data.isSymbolicLink()).toBe(true);
        expect(s.data.isFile()).toBe(false);
        expect(s.data.isDirectory()).toBe(false);
        expect(s.data.mode).toBe(0o120000);
        expect(s.data.size).toBe("target.txt".length);
        expect(s.data.mtimeMs).toBeGreaterThan(0);
        expect(s.data.ctimeMs).toBe(s.data.mtimeMs);
      }
    });

    it("stat follows the link to the target", async () => {
      await fs.writeFile("/target.txt", "hello");
      await fs.symlink("target.txt", "/link");
      const s = await fs.stat("/link");
      expect(s.success).toBe(true);
      if (s.success) {
        expect(s.data.isSymbolicLink()).toBe(false);
        expect(s.data.isFile()).toBe(true);
        expect(s.data.size).toBe(5);
      }
    });

    it("readFile follows relative links (within a subdirectory)", async () => {
      await fs.writeFile("/dir/target.txt", "content");
      await fs.symlink("target.txt", "/dir/link");
      const result = await fs.readFile("/dir/link", "utf8");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe("content");
    });

    it("readFile follows absolute links", async () => {
      await fs.writeFile("/target.txt", "abs");
      await fs.symlink("/target.txt", "/dir/link");
      const result = await fs.readFile("/dir/link", "utf8");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe("abs");
    });

    it("follows chained links", async () => {
      await fs.writeFile("/target.txt", "end");
      await fs.symlink("target.txt", "/a");
      await fs.symlink("a", "/b");
      const result = await fs.readFile("/b", "utf8");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe("end");
    });

    it("stat on a dangling link returns ENOENT", async () => {
      await fs.symlink("missing.txt", "/link");
      const s = await fs.stat("/link");
      expect(s.success).toBe(false);
      if (!s.success) expect(s.error.code).toBe("ENOENT");
    });

    it("returns ELOOP for a symlink cycle", async () => {
      await fs.symlink("b", "/a");
      await fs.symlink("a", "/b");
      const read = await fs.readFile("/a");
      expect(read.success).toBe(false);
      if (!read.success) expect(read.error.code).toBe("ELOOP");
      const stat = await fs.stat("/a");
      expect(stat.success).toBe(false);
      if (!stat.success) expect(stat.error.code).toBe("ELOOP");
      const write = await fs.writeFile("/a", "x");
      expect(write.success).toBe(false);
      if (!write.success) expect(write.error.code).toBe("ELOOP");
    });

    it("readlink on a regular file returns EINVAL", async () => {
      await fs.writeFile("/f.txt", "x");
      const result = await fs.readlink("/f.txt");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("EINVAL");
    });

    it("readlink on a missing path returns ENOENT", async () => {
      const result = await fs.readlink("/nope");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("ENOENT");
    });

    it("symlink over a directory returns EEXIST", async () => {
      await fs.mkdir("/dir");
      const result = await fs.symlink("target", "/dir");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("EEXIST");
    });

    it("symlink under a file parent returns ENOTDIR", async () => {
      await fs.writeFile("/f.txt", "x");
      const result = await fs.symlink("target", "/f.txt/link");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("ENOTDIR");
    });

    it("replaces an existing symlink in place (checkout update semantics)", async () => {
      await fs.symlink("old.txt", "/link");
      const result = await fs.symlink("new.txt", "/link");
      expect(result.success).toBe(true);
      const target = await fs.readlink("/link");
      expect(target.success).toBe(true);
      if (target.success) expect(target.data).toBe("new.txt");
    });

    it("writeFile through a link writes the target file", async () => {
      await fs.writeFile("/target.txt", "old");
      await fs.symlink("target.txt", "/link");
      const writeResult = await fs.writeFile("/link", "new");
      expect(writeResult.success).toBe(true);
      const targetContent = await fs.readFile("/target.txt", "utf8");
      expect(targetContent.success).toBe(true);
      if (targetContent.success) expect(targetContent.data).toBe("new");
      const s = await fs.lstat("/link");
      expect(s.success && s.data.isSymbolicLink()).toBe(true);
    });

    it("writeFile through a dangling link creates the target", async () => {
      await fs.symlink("missing.txt", "/link");
      await fs.writeFile("/link", "created");
      const result = await fs.readFile("/missing.txt", "utf8");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe("created");
    });

    it("unlink removes the link, not the target", async () => {
      await fs.writeFile("/target.txt", "keep");
      await fs.symlink("target.txt", "/link");
      const unlinkResult = await fs.unlink("/link");
      expect(unlinkResult.success).toBe(true);
      expect((await fs.lstat("/link")).success).toBe(false);
      expect((await fs.readFile("/target.txt", "utf8")).success).toBe(true);
      const entries = await fs.readdir("/");
      expect(entries.success).toBe(true);
      if (entries.success) expect(entries.data).not.toContain("link");
    });

    it("readdir lists symlinks", async () => {
      await fs.symlink("t", "/link");
      const entries = await fs.readdir("/");
      expect(entries.success).toBe(true);
      if (entries.success) expect(entries.data).toContain("link");
    });

    it("symlink deep under a file parent returns ENOTDIR", async () => {
      await fs.writeFile("/f.txt", "x");
      const result = await fs.symlink("target", "/f.txt/sub/link");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("ENOTDIR");
    });
  });

  describe("toNodeFS", () => {
    it("rmdir and writeFile throw on failure", async () => {
      const nodeFS = fs.toNodeFS();
      await expect(nodeFS.promises.rmdir("/missing")).rejects.toMatchObject({ code: "ENOENT" });
      await fs.mkdir("/dir");
      await expect(nodeFS.promises.writeFile("/dir", "x")).rejects.toMatchObject({
        code: "EISDIR",
      });
    });

    it("symlink and readlink throw on failure", async () => {
      const nodeFS = fs.toNodeFS();
      await nodeFS.promises.writeFile("/f.txt", "x");
      await expect(nodeFS.promises.readlink("/f.txt")).rejects.toMatchObject({ code: "EINVAL" });
      await fs.mkdir("/dir");
      await expect(nodeFS.promises.symlink("t", "/dir")).rejects.toMatchObject({ code: "EEXIST" });
      await nodeFS.promises.symlink("f.txt", "/link");
      await expect(nodeFS.promises.readlink("/link")).resolves.toBe("f.txt");
    });
  });
});

describe("MemoryFS + isomorphic-git round trips", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const author = { name: "Stratum", email: "system@usestratum.dev" };
  const dir = "/";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves 100755 and symlinks in a commit created from MemoryFS", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as Parameters<typeof git.init>[0]["fs"];
    await git.init({ fs, dir, defaultBranch: "main" });

    await raw.promises.writeFile("/README.md", "docs\n");
    await raw.promises.writeFile("/run.sh", "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await raw.promises.symlink("README.md", "/link.md");

    for (const filepath of ["README.md", "run.sh", "link.md"]) {
      await git.add({ fs, dir, filepath });
    }
    const sha = await git.commit({ fs, dir, message: "modes", author });

    const commit = await git.readCommit({ fs, dir, oid: sha });
    const tree = await git.readTree({ fs, dir, oid: commit.commit.tree });
    const byPath = new Map(tree.tree.map((e) => [e.path, e]));
    expect(byPath.get("README.md")?.mode).toBe("100644");
    expect(byPath.get("run.sh")?.mode).toBe("100755");
    expect(byPath.get("link.md")?.mode).toBe("120000");

    // The symlink blob is its target path.
    const linkOid = byPath.get("link.md")?.oid;
    expect(linkOid).toBeDefined();
    if (linkOid) {
      const blob = await git.readBlob({ fs, dir, oid: linkOid });
      expect(new TextDecoder().decode(blob.blob)).toBe("README.md");
    }
  });

  it("checkout of a tree with symlink + exec file survives a full round trip", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as Parameters<typeof git.init>[0]["fs"];
    const gitdir = "/.git";
    await git.init({ fs, dir, defaultBranch: "main" });

    const fileBlob = await blobObject(enc("plain\n"));
    const execBlob = await blobObject(enc("#!/bin/sh\nexit 0\n"));
    const linkBlob = await blobObject(enc("file.txt"));
    const tree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "100755", name: "run.sh", oid: execBlob.oid },
      { mode: "120000", name: "link", oid: linkBlob.oid },
    ]);
    const base = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    for (const o of [fileBlob, execBlob, linkBlob, tree, base]) {
      await placeLooseObject(fs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs, dir, ref: "main" });

    // Checkout materialized the symlink and kept the exec bit.
    const linkStat = await raw.promises.lstat("/link");
    expect(linkStat.success && linkStat.data.isSymbolicLink()).toBe(true);
    const target = await raw.promises.readlink("/link");
    expect(target.success && target.data === "file.txt").toBe(true);
    const followed = await raw.promises.readFile("/link", "utf8");
    expect(followed.success && followed.data === "plain\n").toBe(true);
    const execStat = await raw.promises.lstat("/run.sh");
    expect(execStat.success && execStat.data.mode === 0o100755).toBe(true);

    // Round trip: re-stage the checked-out workdir and commit; modes must survive.
    for (const filepath of ["file.txt", "run.sh", "link"]) {
      await git.add({ fs, dir, filepath });
    }
    const sha = await git.commit({ fs, dir, message: "round trip", author });
    const commit = await git.readCommit({ fs, dir, oid: sha });
    // Identical content and modes must produce the identical tree.
    expect(commit.commit.tree).toBe(tree.oid);
  });
});
