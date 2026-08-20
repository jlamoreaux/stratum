import git from "isomorphic-git";
import { type NodeFS, artifactsRepoNameFromRemote, pushMain, pushTags } from "../storage/git-ops";
import { MemoryFS } from "../storage/memory-fs";
import { placeLooseObject, unpackObjects } from "../storage/object-loader";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import type { RepoManifest, RepoSnapshot } from "./repo-snapshot";

const DIR = "/";
const GITDIR = "/.git";

/**
 * Rebuild a repo in an in-memory git store from a snapshot's pack + manifest:
 * write every object loose, point `main` at the tip, and verify the resolved tip
 * matches the manifest. Because the backup captured the FULL reachable object set,
 * the reconstructed pack is closed under reachability and the original tip sha is
 * preserved. Fully testable — no Artifacts.
 */
export async function reconstructRepo(
  pack: Uint8Array,
  manifest: RepoManifest,
  logger: Logger,
): Promise<Result<{ fs: NodeFS; dir: string }, AppError>> {
  try {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.init({ fs: fs as any, dir: DIR, defaultBranch: "main" });

    for (const obj of unpackObjects(pack)) {
      await placeLooseObject(fs, GITDIR, obj.oid, obj.bytes);
    }
    await git.writeRef({
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      fs: fs as any,
      dir: DIR,
      ref: "refs/heads/main",
      value: manifest.tipSha,
      force: true,
    });

    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    const resolved = await git.resolveRef({ fs: fs as any, dir: DIR, ref: "main" });
    if (resolved !== manifest.tipSha) {
      return err(
        new AppError(
          `Reconstructed tip ${resolved} does not match manifest ${manifest.tipSha}`,
          "BACKUP_ERROR",
          500,
        ),
      );
    }
    // resolveRef only reads back the ref we just wrote; it does not prove the tip
    // COMMIT OBJECT actually unpacked into the store. readCommit does — it throws
    // if the object (or any pack it needs) is missing, catching a corrupt pack
    // that reconstructs a dangling ref.
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.readCommit({ fs: fs as any, dir: DIR, oid: manifest.tipSha });

    // Tag refs (#182). `tags` is OPTIONAL: manifests from backups taken before
    // tag support omit it, and such a restore must keep working unchanged.
    for (const tag of manifest.tags ?? []) {
      // The name becomes a ref path component and is written with force:true,
      // and the manifest is read back from storage — so validate here rather
      // than trust the snapshot writer. A name containing `..` would resolve
      // outside refs/tags/ and could overwrite refs/heads/main.
      if (!isValidTagName(tag.name)) {
        return err(new AppError(`Invalid tag name in manifest: ${tag.name}`, "BACKUP_ERROR", 500));
      }
      await git.writeRef({
        // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
        fs: fs as any,
        dir: DIR,
        ref: `refs/tags/${tag.name}`,
        value: tag.oid,
        force: true,
      });
      // Same dangling-ref guard as the tip: prove the tag's object (annotated
      // tag object or lightweight target) actually unpacked.
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      await git.readObject({ fs: fs as any, dir: DIR, oid: tag.oid });
    }

    logger.debug("Reconstructed repo", {
      tipSha: manifest.tipSha,
      tagCount: manifest.tags?.length ?? 0,
    });
    return ok({ fs, dir: DIR });
  } catch (error) {
    logger.error("Failed to reconstruct repo", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to reconstruct repo", "BACKUP_ERROR", 500));
  }
}

/**
 * Whether a manifest tag name is a safe `refs/tags/<name>` path component.
 * Mirrors the parts of git's ref-name rules that matter for path traversal.
 */
function isValidTagName(name: unknown): name is string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    !/^[\w.\-+/]+$/.test(name) ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/")
  ) {
    return false;
  }
  // Every slash-separated path component must independently be a valid ref
  // component — a bare startsWith(".")/endsWith(".lock") check on the whole
  // name misses a hostile inner component like "release/.hidden" or
  // "release/v1.0.lock/next", and doesn't catch repeated slashes (an empty
  // component) or a component ending in a bare ".".
  return name.split("/").every((component) => {
    return (
      component.length > 0 &&
      !component.startsWith(".") &&
      !component.endsWith(".lock") &&
      !component.endsWith(".")
    );
  });
}

/**
 * Restore a project's repo into Artifacts: create the repo (or reuse with
 * `force`), reconstruct the objects, and push. The push against real Artifacts is
 * the one leg that can't run in CI — it is validated on staging via the runbook.
 */
export async function restoreProjectRepo(
  env: Env,
  snapshot: RepoSnapshot,
  opts: { force?: boolean },
  logger: Logger,
): Promise<Result<{ tipSha: string }, AppError>> {
  if (!env.ARTIFACTS)
    return err(new AppError("ARTIFACTS binding not configured", "CONFIG_ERROR", 500));

  const project = snapshot.manifest.project;
  const name = artifactsRepoNameFromRemote(project.remote);
  if (!name)
    return err(new AppError("Project remote is not an Artifacts repo", "BACKUP_ERROR", 500));

  // Determine whether the repo already exists so we don't clobber live data.
  const existing = await fromPromise(env.ARTIFACTS.get(name));
  let remote: string;
  let token: string;
  const repoExists = existing.success && existing.data != null;

  if (repoExists) {
    if (!opts.force) {
      return err(
        new AppError(`Repo '${name}' already exists; pass force to overwrite`, "CONFLICT", 409),
      );
    }
    const tok = await fromPromise(existing.data.createToken("write"));
    if (!tok.success) return err(new AppError("Failed to mint write token", "STORAGE_ERROR", 500));
    remote = existing.data.remote;
    token = tok.data.plaintext;
  } else {
    const created = await fromPromise(env.ARTIFACTS.create(name));
    if (!created.success)
      return err(new AppError(`Failed to create repo '${name}'`, "STORAGE_ERROR", 500));
    remote = created.data.remote;
    token = created.data.token;
  }

  // If we freshly created the repo but the reconstruction or push fails, delete the
  // empty repo we just made — otherwise a retried restore sees it and (wrongly)
  // demands `force`, even though there is nothing to protect.
  const rollbackIfCreated = async () => {
    if (repoExists) return;
    const removed = await fromPromise(env.ARTIFACTS.delete(name));
    if (!removed.success) {
      logger.warn("Failed to roll back orphaned repo after a failed restore", { name });
    }
  };

  const rebuilt = await reconstructRepo(snapshot.pack, snapshot.manifest, logger);
  if (!rebuilt.success) {
    await rollbackIfCreated();
    return err(rebuilt.error);
  }

  const pushed = await pushMain(remote, token, rebuilt.data.fs, rebuilt.data.dir, logger, {
    force: repoExists,
  });
  if (!pushed.success) {
    await rollbackIfCreated();
    return err(pushed.error);
  }

  // Tag refs (#182): push after main so their target commits are already on the
  // remote. Optional field — a pre-tag-support manifest restores exactly as before.
  const tagNames = (snapshot.manifest.tags ?? []).map((t) => t.name);
  if (tagNames.length > 0) {
    const tagsPushed = await pushTags(
      remote,
      token,
      rebuilt.data.fs,
      rebuilt.data.dir,
      tagNames,
      logger,
      { force: repoExists },
    );
    if (!tagsPushed.success) {
      // rollbackIfCreated is a no-op for a pre-existing repo, so a forced restore
      // that fails here leaves main pushed and only some tags present. Say so
      // explicitly: the caller's error alone cannot convey how far it got.
      if (repoExists) {
        logger.error("Forced restore left partial state on an existing repo", undefined, {
          name,
          tipSha: snapshot.manifest.tipSha,
          mainPushed: true,
          tagCount: tagNames.length,
          detail: tagsPushed.error.message,
        });
      }
      await rollbackIfCreated();
      return err(tagsPushed.error);
    }
  }

  logger.info("Restored project repo", {
    name,
    tipSha: snapshot.manifest.tipSha,
    tagCount: tagNames.length,
  });
  return ok({ tipSha: snapshot.manifest.tipSha });
}
