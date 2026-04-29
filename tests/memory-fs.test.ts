import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFS } from "../src/storage/memory-fs";

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
      await fs.promises.mkdir("/foo");
      const stat = await fs.promises.stat("/foo");
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates nested dirs with recursive", async () => {
      await fs.promises.mkdir("/a/b/c", { recursive: true });
      expect((await fs.promises.stat("/a/b/c")).isDirectory()).toBe(true);
    });

    it("throws ENOENT for missing parent without recursive", async () => {
      await expect(fs.promises.mkdir("/a/b")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("is idempotent with recursive", async () => {
      await fs.promises.mkdir("/foo", { recursive: true });
      await expect(fs.promises.mkdir("/foo", { recursive: true })).resolves.toBeUndefined();
    });
  });

  describe("writeFile / readFile", () => {
    it("writes and reads a string", async () => {
      await fs.promises.writeFile("/hello.txt", "hello");
      const result = await fs.promises.readFile("/hello.txt", { encoding: "utf8" });
      expect(result).toBe("hello");
    });

    it("writes and reads binary", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await fs.promises.writeFile("/bin.dat", data);
      const result = await fs.promises.readFile("/bin.dat");
      expect(result).toEqual(data);
    });

    it("creates parent directories automatically", async () => {
      await fs.promises.writeFile("/deep/nested/file.txt", "content");
      expect((await fs.promises.stat("/deep/nested")).isDirectory()).toBe(true);
    });

    it("overwrites existing file", async () => {
      await fs.promises.writeFile("/f.txt", "v1");
      await fs.promises.writeFile("/f.txt", "v2");
      expect(await fs.promises.readFile("/f.txt", "utf8")).toBe("v2");
    });

    it("throws ENOENT for missing file", async () => {
      await expect(fs.promises.readFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("throws EISDIR when reading a directory", async () => {
      await fs.promises.mkdir("/dir");
      await expect(fs.promises.readFile("/dir")).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  describe("readdir", () => {
    it("lists directory contents sorted", async () => {
      await fs.promises.writeFile("/b.txt", "");
      await fs.promises.writeFile("/a.txt", "");
      const entries = await fs.promises.readdir("/");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("b.txt");
      expect(entries.indexOf("a.txt")).toBeLessThan(entries.indexOf("b.txt"));
    });

    it("throws ENOENT for missing directory", async () => {
      await expect(fs.promises.readdir("/nope")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("unlink", () => {
    it("removes a file", async () => {
      await fs.promises.writeFile("/f.txt", "");
      await fs.promises.unlink("/f.txt");
      await expect(fs.promises.stat("/f.txt")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("removes file from parent readdir", async () => {
      await fs.promises.writeFile("/f.txt", "");
      await fs.promises.unlink("/f.txt");
      const entries = await fs.promises.readdir("/");
      expect(entries).not.toContain("f.txt");
    });

    it("throws EISDIR for directory", async () => {
      await fs.promises.mkdir("/dir");
      await expect(fs.promises.unlink("/dir")).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  describe("rmdir", () => {
    it("removes empty directory", async () => {
      await fs.promises.mkdir("/empty");
      await fs.promises.rmdir("/empty");
      await expect(fs.promises.stat("/empty")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("throws ENOTEMPTY for non-empty directory", async () => {
      await fs.promises.writeFile("/dir/file.txt", "");
      await expect(fs.promises.rmdir("/dir")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    });
  });

  describe("stat / lstat", () => {
    it("reports file stats correctly", async () => {
      await fs.promises.writeFile("/f.txt", "hi");
      const s = await fs.promises.stat("/f.txt");
      expect(s.isFile()).toBe(true);
      expect(s.isDirectory()).toBe(false);
      expect(s.isSymbolicLink()).toBe(false);
      expect(s.size).toBe(2);
      expect(s.mode).toBe(0o100644);
    });

    it("reports directory stats correctly", async () => {
      await fs.promises.mkdir("/dir");
      const s = await fs.promises.stat("/dir");
      expect(s.isFile()).toBe(false);
      expect(s.isDirectory()).toBe(true);
      expect(s.size).toBe(0);
      expect(s.mode).toBe(0o040000);
    });

    it("stat and lstat return same result for files", async () => {
      await fs.promises.writeFile("/f.txt", "x");
      const stat = await fs.promises.stat("/f.txt");
      const lstat = await fs.promises.lstat("/f.txt");
      expect(stat.isFile()).toBe(lstat.isFile());
      expect(stat.size).toBe(lstat.size);
    });
  });
});
