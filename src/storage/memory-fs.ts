type FileEntry = { kind: "file"; data: Uint8Array; mtimeMs: number };
type DirEntry = { kind: "dir"; children: Set<string>; mtimeMs: number };
type Entry = FileEntry | DirEntry;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class MemoryStats {
  constructor(private readonly entry: Entry) {}

  get size(): number {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return false;
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

  private requireEntry(path: string): Entry {
    const entry = this.getEntry(path);
    if (!entry) throw fsError("ENOENT", `ENOENT: no such file or directory: ${path}`);
    return entry;
  }

  private requireDir(path: string): DirEntry {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", `ENOTDIR: not a directory: ${path}`);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = options?.recursive === true;
    const parentPath = this.parent(target);

    if (!this.entries.has(parentPath)) {
      if (!recursive) throw fsError("ENOENT", `ENOENT: no such file or directory: ${parentPath}`);
      await this.mkdir(parentPath, { recursive: true });
    }

    if (this.entries.has(target)) return;

    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parentPath).children.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const target = this.normalize(path);
    const parentPath = this.parent(target);
    await this.mkdir(parentPath, { recursive: true });

    const bytes =
      typeof data === "string"
        ? encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);

    if (this.getEntry(target)?.kind === "dir")
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`);

    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.requireDir(parentPath).children.add(this.basename(target));
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<string | Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file")
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`);

    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file")
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0)
      throw fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty: ${path}`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }
}
