import { AppError } from "../utils/errors";
import { type Result, err, ok } from "../utils/result";

type FileEntry = { kind: "file"; data: Uint8Array; mode: number; mtimeMs: number };
type SymlinkEntry = { kind: "symlink"; target: string; mtimeMs: number };
type DirEntry = { kind: "dir"; children: Set<string>; mtimeMs: number };
type Entry = FileEntry | SymlinkEntry | DirEntry;

// Git tree-entry modes (the only file modes git records).
export const MODE_FILE = 0o100644;
export const MODE_EXEC = 0o100755;
export const MODE_SYMLINK = 0o120000;
export const MODE_DIR = 0o040000;
export const MODE_GITLINK = 0o160000;

// Matches Linux's SYMLOOP_MAX-style cap so a symlink cycle errors instead of spinning.
const MAX_SYMLINK_HOPS = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fsError(code: string, message: string): AppError {
  return new AppError(message, code, 500);
}

class MemoryStats {
  // isomorphic-git assigns stats.mode after lstat during checkout (0o755 for
  // executables — a Windows workaround — and 0o160000 for gitlinks); the override
  // honors those writes on this stats instance so the index records the intended mode.
  private modeOverride?: number;

  constructor(private readonly entry: Entry) {}

  get size(): number {
    if (this.entry.kind === "file") return this.entry.data.byteLength;
    if (this.entry.kind === "symlink") return encoder.encode(this.entry.target).byteLength;
    return 0;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    if (this.modeOverride !== undefined) return this.modeOverride;
    if (this.entry.kind === "file") return this.entry.mode;
    if (this.entry.kind === "symlink") return MODE_SYMLINK;
    return MODE_DIR;
  }

  set mode(value: number) {
    if (value === MODE_GITLINK) {
      // Gitlinks (submodules) are recorded in the index but MemoryFS has no
      // checked-out submodule behind them — surface it instead of failing silently.
      console.warn(
        "MemoryFS: gitlink (submodule) entry encountered; submodules are not fully supported",
      );
    }
    this.modeOverride = value;
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private getEntry(path: string): Entry | undefined {
    return this.entries.get(this.normalize(path));
  }

  private getEntryResult(path: string): Result<Entry, AppError> {
    const entry = this.getEntry(path);
    if (!entry) return err(fsError("ENOENT", `ENOENT: no such file or directory: ${path}`));
    return ok(entry);
  }

  private getDirResult(path: string): Result<DirEntry, AppError> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind !== "dir") return err(fsError("ENOTDIR", `ENOTDIR: not a directory: ${path}`));
    return ok(entry);
  }

  /**
   * Follow a trailing symlink chain to its final path (Node stat/readFile/writeFile
   * semantics; the final path need not exist). Intermediate components are not
   * resolved — git working trees never require traversing through symlinked dirs.
   */
  private resolveLink(path: string): Result<string, AppError> {
    let current = this.normalize(path);
    for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
      const entry = this.entries.get(current);
      if (entry?.kind !== "symlink") return ok(current);
      current = entry.target.startsWith("/")
        ? this.normalize(entry.target)
        : this.normalize(`${this.parent(current)}/${entry.target}`);
    }
    return err(fsError("ELOOP", `ELOOP: too many symbolic links encountered: ${path}`));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    if (target === "/") return ok(undefined);
    const recursive = options?.recursive === true;
    const parentPath = this.parent(target);

    if (!this.entries.has(parentPath)) {
      if (!recursive)
        return err(fsError("ENOENT", `ENOENT: no such file or directory: ${parentPath}`));
      const mkdirResult = await this.mkdir(parentPath, { recursive: true });
      if (!mkdirResult.success) return mkdirResult;
    }

    if (this.entries.has(target)) return ok(undefined);

    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    const dirResult = this.getDirResult(parentPath);
    if (!dirResult.success) return dirResult;
    dirResult.data.children.add(this.basename(target));
    return ok(undefined);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: { mode?: number },
  ): Promise<Result<void, AppError>> {
    const resolved = this.resolveLink(path);
    if (!resolved.success) return resolved;
    const target = resolved.data;
    const parentPath = this.parent(target);
    const mkdirResult = await this.mkdir(parentPath, { recursive: true });
    if (!mkdirResult.success) return mkdirResult;

    const bytes =
      typeof data === "string"
        ? encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);

    const existing = this.entries.get(target);
    if (existing?.kind === "dir")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));

    // isomorphic-git's checkout passes { mode: 0o777 } for executable blobs; git
    // only records the exec bit, so any exec bit maps to 100755. Without an
    // explicit mode an overwrite keeps the file's existing mode (Node semantics).
    const mode =
      options?.mode !== undefined
        ? options.mode & 0o111
          ? MODE_EXEC
          : MODE_FILE
        : existing?.kind === "file"
          ? existing.mode
          : MODE_FILE;

    this.entries.set(target, { kind: "file", data: bytes, mode, mtimeMs: Date.now() });
    const dirResult = this.getDirResult(parentPath);
    if (!dirResult.success) return dirResult;
    dirResult.data.children.add(this.basename(target));
    return ok(undefined);
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<Result<string | Uint8Array, AppError>> {
    const resolved = this.resolveLink(path);
    if (!resolved.success) return resolved;
    const entryResult = this.getEntryResult(resolved.data);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind !== "file")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));

    const encoding = typeof options === "string" ? options : options?.encoding;
    return ok(encoding ? decoder.decode(entry.data) : entry.data);
  }

  async readdir(path: string): Promise<Result<string[], AppError>> {
    const dirResult = this.getDirResult(path);
    if (!dirResult.success) return dirResult;
    return ok([...dirResult.data.children].sort());
  }

  async unlink(path: string): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    const entryResult = this.getEntryResult(target);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind === "dir")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));
    this.entries.delete(target);
    const dirResult = this.getDirResult(this.parent(target));
    if (!dirResult.success) return dirResult;
    dirResult.data.children.delete(this.basename(target));
    return ok(undefined);
  }

  async rmdir(path: string): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    const entryResult = this.getDirResult(target);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.children.size > 0)
      return err(fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty: ${path}`));
    this.entries.delete(target);
    const dirResult = this.getDirResult(this.parent(target));
    if (!dirResult.success) return dirResult;
    dirResult.data.children.delete(this.basename(target));
    return ok(undefined);
  }

  async stat(path: string): Promise<Result<MemoryStats, AppError>> {
    const resolved = this.resolveLink(path);
    if (!resolved.success) return resolved;
    const entryResult = this.getEntryResult(resolved.data);
    if (!entryResult.success) return entryResult;
    return ok(new MemoryStats(entryResult.data));
  }

  async lstat(path: string): Promise<Result<MemoryStats, AppError>> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    return ok(new MemoryStats(entryResult.data));
  }

  async readlink(path: string): Promise<Result<string, AppError>> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    if (entryResult.data.kind !== "symlink")
      return err(fsError("EINVAL", `EINVAL: invalid argument, readlink '${path}'`));
    return ok(entryResult.data.target);
  }

  async symlink(target: string, path: string): Promise<Result<void, AppError>> {
    const linkPath = this.normalize(path);
    const parentPath = this.parent(linkPath);
    const mkdirResult = await this.mkdir(parentPath, { recursive: true });
    if (!mkdirResult.success) return mkdirResult;

    const existing = this.entries.get(linkPath);
    if (existing?.kind === "dir")
      return err(
        fsError("EEXIST", `EEXIST: file already exists, symlink '${target}' -> '${path}'`),
      );

    // Node's symlink() fails EEXIST on any existing entry, but isomorphic-git's
    // checkout rewrites a changed symlink in place (writelink without an unlink),
    // so an existing file/symlink is replaced instead.
    this.entries.set(linkPath, { kind: "symlink", target, mtimeMs: Date.now() });
    const dirResult = this.getDirResult(parentPath);
    if (!dirResult.success) return dirResult;
    dirResult.data.children.add(this.basename(linkPath));
    return ok(undefined);
  }

  /**
   * Returns a Node.js fs-compatible interface for isomorphic-git
   * This unwraps Result objects and throws errors like standard Node.js fs
   */
  toNodeFS(): {
    promises: {
      readFile: (
        path: string,
        options?: string | { encoding?: string },
      ) => Promise<string | Uint8Array>;
      writeFile: (
        path: string,
        data: string | Uint8Array,
        options?: { mode?: number },
      ) => Promise<void>;
      unlink: (path: string) => Promise<void>;
      readdir: (path: string) => Promise<string[]>;
      mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
      rmdir: (path: string) => Promise<void>;
      stat: (path: string) => Promise<MemoryStats>;
      lstat: (path: string) => Promise<MemoryStats>;
      readlink: (path: string) => Promise<string>;
      symlink: (target: string, path: string) => Promise<void>;
    };
  } {
    const nodeFS = {
      promises: {
        readFile: async (path: string, options?: string | { encoding?: string }) => {
          const result = await this.readFile(path, options);
          if (!result.success) throw result.error;
          return result.data;
        },
        writeFile: async (path: string, data: string | Uint8Array, options?: { mode?: number }) => {
          const result = await this.writeFile(path, data, options);
          if (!result.success) throw result.error;
        },
        unlink: async (path: string) => {
          const result = await this.unlink(path);
          if (!result.success) throw result.error;
        },
        readdir: async (path: string) => {
          const result = await this.readdir(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        mkdir: async (path: string, options?: { recursive?: boolean }) => {
          const result = await this.mkdir(path, options);
          if (!result.success) throw result.error;
        },
        rmdir: async (path: string) => {
          const result = await this.rmdir(path);
          if (!result.success) throw result.error;
        },
        stat: async (path: string) => {
          const result = await this.stat(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        lstat: async (path: string) => {
          const result = await this.lstat(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        readlink: async (path: string) => {
          const result = await this.readlink(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        symlink: async (target: string, path: string) => {
          const result = await this.symlink(target, path);
          if (!result.success) throw result.error;
        },
      },
    };
    return nodeFS;
  }
}
