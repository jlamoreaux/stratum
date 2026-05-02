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

  // mode needs to be writable for isomorphic-git compatibility
  private _mode: number | undefined;
  get mode(): number {
    return this._mode ?? (this.entry.kind === "file" ? 0o100644 : 0o040000);
  }
  set mode(value: number) {
    this._mode = value;
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

// Type for callback-style fs functions
type Callback<T> = (err: Error | null, result?: T) => void;

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

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

  // Internal implementations
  private async mkdirImpl(path: string, options?: { recursive?: boolean }): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = options?.recursive === true;
    const parentPath = this.parent(target);

    if (!this.entries.has(parentPath)) {
      if (!recursive) throw fsError("ENOENT", `ENOENT: no such file or directory: ${parentPath}`);
      await this.mkdirImpl(parentPath, { recursive: true });
    }

    if (this.entries.has(target)) return;

    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parentPath).children.add(this.basename(target));
  }

  private async writeFileImpl(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const target = this.normalize(path);
    const parentPath = this.parent(target);
    await this.mkdirImpl(parentPath, { recursive: true });

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

  private async readFileImpl(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<string | Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file")
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`);

    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? decoder.decode(entry.data) : entry.data;
  }

  private async readdirImpl(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  private async unlinkImpl(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file")
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  private async rmdirImpl(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0)
      throw fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty: ${path}`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  private async statImpl(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  private async lstatImpl(path: string): Promise<MemoryStats> {
    return this.statImpl(path);
  }

  // Promise-style API methods - these are the ones isomorphic-git prefers
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.mkdirImpl(path, options);
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    return this.writeFileImpl(path, data);
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array> {
    return this.readFileImpl(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.readdirImpl(path);
  }

  async unlink(path: string): Promise<void> {
    return this.unlinkImpl(path);
  }

  async rmdir(path: string): Promise<void> {
    return this.rmdirImpl(path);
  }

  async stat(path: string): Promise<MemoryStats> {
    return this.statImpl(path);
  }

  async lstat(path: string): Promise<MemoryStats> {
    return this.lstatImpl(path);
  }

  // Callback-style API methods - for compatibility
  mkdirCb(path: string, options: { recursive?: boolean } | null | undefined, callback: Callback<void>): void {
    this.mkdir(path, options ?? undefined).then(() => callback(null)).catch((err) => callback(err));
  }

  writeFileCb(path: string, data: string | Uint8Array | ArrayBuffer, options: { encoding?: string } | null | undefined, callback: Callback<void>): void {
    this.writeFile(path, data).then(() => callback(null)).catch((err) => callback(err));
  }

  readFileCb(path: string, options: string | { encoding?: string } | null | undefined, callback: Callback<string | Uint8Array>): void {
    this.readFile(path, options ?? undefined).then((data) => callback(null, data)).catch((err) => callback(err));
  }

  readdirCb(path: string, options: { encoding?: string } | null | undefined, callback: Callback<string[]>): void {
    this.readdir(path).then((files) => callback(null, files)).catch((err) => callback(err));
  }

  unlinkCb(path: string, callback: Callback<void>): void {
    this.unlink(path).then(() => callback(null)).catch((err) => callback(err));
  }

  rmdirCb(path: string, options: { recursive?: boolean } | null | undefined, callback: Callback<void>): void {
    this.rmdir(path).then(() => callback(null)).catch((err) => callback(err));
  }

  statCb(path: string, options: { bigint?: boolean } | null | undefined, callback: Callback<MemoryStats>): void {
    this.stat(path).then((stats) => callback(null, stats)).catch((err) => callback(err));
  }

  lstatCb(path: string, options: { bigint?: boolean } | null | undefined, callback: Callback<MemoryStats>): void {
    this.lstat(path).then((stats) => callback(null, stats)).catch((err) => callback(err));
  }

  // The promises object that isomorphic-git checks for
  get promises(): MemoryFS {
    return this;
  }

  // Aliases for isomorphic-git compatibility
  readlink = this.readFile.bind(this);
  symlink = this.mkdir.bind(this);
}
