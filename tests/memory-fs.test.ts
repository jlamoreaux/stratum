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
  });
});
