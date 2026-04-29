import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Author, CommitLogEntry } from "../types";
import { MemoryFS } from "./memory-fs";

const DIR = "/";

const SYSTEM_AUTHOR: Author = { name: "Stratum", email: "system@usestratum.dev" };

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
  author: Author = SYSTEM_AUTHOR,
): Promise<string> {
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

  try {
    const result = await git.merge({
      fs,
      dir,
      ours: "main",
      theirs: workspaceSha,
      author,
      message: "Merge workspace into project",
    });
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
  } catch {
    return squashMerge(fs, dir, workspaceSha, projectRemote, projectToken, author);
  }
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

  const changed = workspaceFiles.filter(([path, hash]) => {
    const projectHash = projectFiles.find(([p]) => p === path)?.[1];
    return projectHash !== hash;
  });

  for (const [path] of changed) {
    const content = await readFileAtCommit(projectFs, workspaceSha, path);
    await projectFs.promises.writeFile(`${projectDir}/${path}`, content);
    await git.add({ fs: projectFs, dir: projectDir, filepath: path });
  }

  const sha = await git.commit({
    fs: projectFs,
    dir: projectDir,
    message: `Squash merge workspace (${changed.length} file${changed.length === 1 ? "" : "s"} changed)`,
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
  remote: string,
  token: string,
  githubUrl: string,
  branch = 'main',
  depth = 10,
): Promise<void> {
  const importRes = await fetch(`${remote}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: githubUrl, branch, depth }),
  });
  if (!importRes.ok) {
    const detail = await importRes.text().catch(() => 'unknown error');
    throw new Error(`Artifacts import failed (${importRes.status}): ${detail}`);
  }
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
    listFilesAtCommit(workspaceFs, 'main'),
    listFilesAtCommit(baseFs, 'main'),
  ]);

  const baseMap = new Map(baseFiles);
  const workspaceMap = new Map(workspaceFiles);

  const diffParts: string[] = [];

  for (const [path, oid] of workspaceFiles) {
    const baseOid = baseMap.get(path);
    if (baseOid === oid) continue;

    const workspaceContent = await readFileAtCommit(workspaceFs, 'main', path);
    const workspaceLines = workspaceContent.split('\n');

    diffParts.push(`diff --git a/${path} b/${path}`);

    if (baseOid === undefined) {
      diffParts.push(`--- /dev/null`);
      diffParts.push(`+++ b/${path}`);
      diffParts.push(`@@ -0,0 +1,${workspaceLines.length} @@`);
      for (const line of workspaceLines) {
        diffParts.push(`+${line}`);
      }
    } else {
      const baseContent = await readFileAtCommit(baseFs, 'main', path);
      const baseLines = baseContent.split('\n');
      diffParts.push(`--- a/${path}`);
      diffParts.push(`+++ b/${path}`);
      diffParts.push(`@@ -1,${baseLines.length} +1,${workspaceLines.length} @@`);
      for (const line of baseLines) {
        diffParts.push(`-${line}`);
      }
      for (const line of workspaceLines) {
        diffParts.push(`+${line}`);
      }
    }
  }

  for (const [path] of baseFiles) {
    if (!workspaceMap.has(path)) {
      const baseContent = await readFileAtCommit(baseFs, 'main', path);
      const baseLines = baseContent.split('\n');
      diffParts.push(`diff --git a/${path} b/${path}`);
      diffParts.push(`--- a/${path}`);
      diffParts.push(`+++ /dev/null`);
      diffParts.push(`@@ -1,${baseLines.length} +0,0 @@`);
      for (const line of baseLines) {
        diffParts.push(`-${line}`);
      }
    }
  }

  return diffParts.join('\n');
}
