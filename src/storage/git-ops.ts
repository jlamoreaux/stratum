import { createPatch } from "diff";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { ArtifactsCreateResult, ArtifactsNamespace, Author, CommitLogEntry } from "../types";
import { MemoryFS } from "./memory-fs";

const DIR = "/";

const SYSTEM_AUTHOR: Author = { name: "Stratum", email: "system@usestratum.dev" };

export type MergeStrategy = "merge" | "squash";

export interface MergeWorkspaceOptions {
  author?: Author;
  strategy?: MergeStrategy;
}

export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeConflictError";
  }
}

/**
 * Artifacts tokens are formatted as `<secret>?expires=<timestamp>`.
 * Only the secret portion is used for HTTP Basic auth.
 */
export function extractTokenSecret(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

function makeAuth(token: string) {
  const secret = extractTokenSecret(token);
  return () => ({ username: "x", password: secret });
}

export async function initAndPush(
  remote: string,
  token: string,
  files: Record<string, string>,
  message: string,
  author: Author = SYSTEM_AUTHOR,
): Promise<string> {
  const fs = new MemoryFS();
  await git.init({ fs, dir: DIR, defaultBranch: "main" });

  for (const [path, content] of Object.entries(files)) {
    await fs.promises.writeFile(`/${path}`, content);
    await git.add({ fs, dir: DIR, filepath: path });
  }

  const sha = await git.commit({ fs, dir: DIR, message, author });
  await git.push({ fs, dir: DIR, http, url: remote, ref: "main", onAuth: makeAuth(token) });
  return sha;
}

export async function cloneRepo(
  remote: string,
  token: string,
): Promise<{ fs: MemoryFS; dir: string }> {
  const fs = new MemoryFS();
  await git.clone({
    fs,
    http,
    dir: DIR,
    url: remote,
    ref: "main",
    singleBranch: true,
    depth: 50,
    onAuth: makeAuth(token),
  });
  return { fs, dir: DIR };
}

export async function commitAndPush(
  fs: MemoryFS,
  dir: string,
  remote: string,
  token: string,
  changes: Record<string, string>,
  message: string,
  author: Author = SYSTEM_AUTHOR,
): Promise<string> {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  for (const [path, content] of Object.entries(changes)) {
    await fs.promises.writeFile(`${base}${path}`, content);
    await git.add({ fs, dir, filepath: path });
  }

  const sha = await git.commit({ fs, dir, message, author });
  await git.push({ fs, dir, http, url: remote, ref: "main", onAuth: makeAuth(token) });
  return sha;
}

/**
 * Merges a workspace into its parent project repo.
 *
 * Attempts a true three-way merge via isomorphic-git's multi-remote fetch.
 * Falls back to a squash merge (copy changed files, single commit) if the
 * merge fails — this covers cases where isomorphic-git can't resolve the
 * merge or the remotes have diverged in a way that produces conflicts.
 */
export async function mergeWorkspaceIntoProject(
  projectRemote: string,
  projectToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  options: MergeWorkspaceOptions = {},
): Promise<string> {
  const author = options.author ?? SYSTEM_AUTHOR;
  const { fs, dir } = await cloneRepo(projectRemote, projectToken);

  await git.addRemote({ fs, dir, remote: "workspace", url: workspaceRemote });
  await git.fetch({
    fs,
    http,
    dir,
    remote: "workspace",
    ref: "main",
    singleBranch: true,
    onAuth: makeAuth(workspaceToken),
  });

  let workspaceSha: string;
  try {
    workspaceSha = await git.resolveRef({ fs, dir, ref: "FETCH_HEAD" });
  } catch {
    workspaceSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/workspace/main" });
  }

  if (options.strategy === "squash") {
    return squashMerge(fs, dir, workspaceSha, projectRemote, projectToken, author);
  }

  let result: Awaited<ReturnType<typeof git.merge>>;
  try {
    result = await git.merge({
      fs,
      dir,
      ours: "main",
      theirs: workspaceSha,
      author,
      message: "Merge workspace into project",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MergeConflictError(`Merge failed; workspace may be stale or conflicting: ${message}`);
  }

  await git.push({
    fs,
    dir,
    http,
    url: projectRemote,
    ref: "main",
    onAuth: makeAuth(projectToken),
  });
  if (!result.oid) throw new Error("Merge produced no commit OID");
  return result.oid;
}

async function squashMerge(
  projectFs: MemoryFS,
  projectDir: string,
  workspaceSha: string,
  projectRemote: string,
  projectToken: string,
  author: Author,
): Promise<string> {
  const workspaceFiles = await listFilesAtCommit(projectFs, workspaceSha);
  const projectFiles = await listFilesAtCommit(projectFs, "main");
  const workspaceMap = new Map(workspaceFiles);

  const changed = workspaceFiles.filter(([path, hash]) => {
    const projectHash = projectFiles.find(([p]) => p === path)?.[1];
    return projectHash !== hash;
  });
  const deleted = projectFiles.filter(([path]) => !workspaceMap.has(path));

  for (const [path] of changed) {
    const content = await readFileAtCommit(projectFs, workspaceSha, path);
    await projectFs.promises.writeFile(`${projectDir}/${path}`, content);
    await git.add({ fs: projectFs, dir: projectDir, filepath: path });
  }

  for (const [path] of deleted) {
    await projectFs.promises.unlink(`${projectDir}/${path}`);
    await git.remove({ fs: projectFs, dir: projectDir, filepath: path });
  }

  const changeCount = changed.length + deleted.length;
  if (changeCount === 0) {
    return git.resolveRef({ fs: projectFs, dir: projectDir, ref: "main" });
  }

  const sha = await git.commit({
    fs: projectFs,
    dir: projectDir,
    message: `Squash merge workspace (${changeCount} file${changeCount === 1 ? "" : "s"} changed)`,
    author,
  });

  await git.push({
    fs: projectFs,
    dir: projectDir,
    http,
    url: projectRemote,
    ref: "main",
    onAuth: makeAuth(projectToken),
  });

  return sha;
}

async function listFilesAtCommit(
  fs: MemoryFS,
  ref: string,
): Promise<[path: string, oid: string][]> {
  const files: [string, string][] = [];
  await git.walk({
    fs,
    dir: DIR,
    trees: [git.TREE({ ref })],
    map: async (filepath, [entry]) => {
      if (!entry) return;
      const type = await entry.type();
      if (type === "blob") {
        const oid = await entry.oid();
        files.push([filepath, oid]);
      }
    },
  });
  return files;
}

async function readFileAtCommit(fs: MemoryFS, ref: string, path: string): Promise<string> {
  const { blob } = await git.readBlob({ fs, dir: DIR, oid: ref, filepath: path });
  return new TextDecoder().decode(blob);
}

export async function readFileFromRepo(
  remote: string,
  token: string,
  path: string,
): Promise<string> {
  const { fs } = await cloneRepo(remote, token);
  const content = await fs.promises.readFile(`/${path}`, { encoding: "utf8" });
  return content as string;
}

export async function listFilesInRepo(remote: string, token: string): Promise<string[]> {
  const { fs, dir } = await cloneRepo(remote, token);
  return walkDir(fs, dir, "");
}

async function walkDir(fs: MemoryFS, base: string, prefix: string): Promise<string[]> {
  const dirPath = base === "/" ? "/" : base;
  const entries = await fs.promises.readdir(dirPath);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === ".git") continue;
    const fullPath = base === "/" ? `/${entry}` : `${base}/${entry}`;
    const stat = await fs.promises.stat(fullPath);
    if (stat.isDirectory()) {
      files.push(...(await walkDir(fs, fullPath, `${prefix}${entry}/`)));
    } else {
      files.push(`${prefix}${entry}`);
    }
  }

  return files;
}

export async function getCommitLog(
  remote: string,
  token: string,
  depth = 20,
): Promise<CommitLogEntry[]> {
  const { fs, dir } = await cloneRepo(remote, token);
  const commits = await git.log({ fs, dir, depth });
  return commits.map((c) => ({
    sha: c.oid,
    message: c.commit.message.trim(),
    author: `${c.commit.author.name} <${c.commit.author.email}>`,
    timestamp: c.commit.author.timestamp,
  }));
}

export async function importFromGitHub(
  artifacts: ArtifactsNamespace,
  name: string,
  githubUrl: string,
  branch = "main",
  depth = 10,
  authToken?: string,
): Promise<ArtifactsCreateResult> {
  const source: {
    url: string;
    branch?: string;
    depth?: number;
    auth?: {
      type: "bearer";
      token: string;
    };
  } = {
    url: githubUrl,
    branch,
    depth,
  };

  // Add authentication for private repos
  if (authToken) {
    source.auth = {
      type: "bearer",
      token: authToken,
    };
  }

  return artifacts.import({
    source,
    target: {
      name,
    },
  });
}

/**
 * Builds a git-style unified diff header + POSIX patch for a modified file.
 * `createPatch` computes a real line-level diff with proper @@ hunks.
 */
function fileUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  // createPatch returns: "Index: <path>\n===...\n--- <path>\n+++ <path>\n@@ ... @@\n..."
  // We strip the Index/=== preamble and replace the --- / +++ markers with git-style ones.
  const patch = createPatch(path, oldContent, newContent, "", "");
  const lines = patch.split("\n");
  // Drop the first two lines ("Index: …" and "===…") then fix up --- / +++ paths.
  const body = lines
    .slice(2)
    .map((line) => {
      if (line.startsWith("--- ")) return `--- a/${path}`;
      if (line.startsWith("+++ ")) return `+++ b/${path}`;
      return line;
    })
    .join("\n");
  return `diff --git a/${path} b/${path}\n${body}`;
}

function newFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `+${l}`).join("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lineCount} @@\n${body}\n`;
}

function deletedFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `-${l}`).join("\n");
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lineCount} +0,0 @@\n${body}\n`;
}

export async function getDiffBetweenRepos(
  baseRemote: string,
  baseToken: string,
  workspaceRemote: string,
  workspaceToken: string,
): Promise<string> {
  const [{ fs: workspaceFs }, { fs: baseFs }] = await Promise.all([
    cloneRepo(workspaceRemote, workspaceToken),
    cloneRepo(baseRemote, baseToken),
  ]);

  const [workspaceFiles, baseFiles] = await Promise.all([
    listFilesAtCommit(workspaceFs, "main"),
    listFilesAtCommit(baseFs, "main"),
  ]);

  const baseContent = new Map<string, string>();
  const workspaceContent = new Map<string, string>();

  await Promise.all([
    ...baseFiles.map(async ([path]) => {
      baseContent.set(path, await readFileAtCommit(baseFs, "main", path));
    }),
    ...workspaceFiles.map(async ([path]) => {
      workspaceContent.set(path, await readFileAtCommit(workspaceFs, "main", path));
    }),
  ]);

  return buildUnifiedDiff(baseContent, workspaceContent);
}

export function buildUnifiedDiff(
  baseFiles: Map<string, string>,
  workspaceFiles: Map<string, string>,
): string {
  const diffParts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...workspaceFiles.keys()]);

  for (const path of [...paths].sort()) {
    const oldContent = baseFiles.get(path);
    const newContent = workspaceFiles.get(path);
    if (oldContent === newContent) continue;

    if (oldContent === undefined && newContent !== undefined) {
      diffParts.push(newFileDiff(path, newContent));
    } else if (newContent === undefined && oldContent !== undefined) {
      diffParts.push(deletedFileDiff(path, oldContent));
    } else if (oldContent !== undefined && newContent !== undefined) {
      diffParts.push(fileUnifiedDiff(path, oldContent, newContent));
    }
  }

  return diffParts.join("\n");
}
