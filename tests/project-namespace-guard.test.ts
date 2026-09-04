/**
 * The creation side of the rename race guard: the namespace claim written to
 * D1 before a project's KV entry, and `confirmOwnerNamespace`, which re-reads
 * the owner afterwards and withdraws the project if the name moved first. The
 * rename side (the UPDATE that refuses while a claim exists) is covered in
 * user-profile-storage.test.ts and account-settings.test.tsx; between them no
 * interleaving leaves a project under a namespace nobody owns. The guard fails
 * closed: an owner that cannot be re-read or a project that cannot be
 * withdrawn is a server error, never a silently kept entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));
vi.mock("../src/storage/state", () => ({ deleteProject: vi.fn() }));

import {
  claimNamespace,
  confirmOwnerNamespace,
  ownerHasClaims,
  releaseNamespaceClaim,
} from "../src/storage/project-namespace";
import { deleteProject } from "../src/storage/state";
import { getUser } from "../src/storage/users";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const owner = (username: string) => ({
  success: true as const,
  data: {
    id: "usr_1",
    email: "a@b.com",
    username,
    tokenHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
const unreadable = { success: false as const, error: new Error("d1") as never };
const deleted = { success: true as const, data: undefined };
const notDeleted = { success: false as const, error: new Error("kv") as never };

/** Bindings the guard touches, with a spy on the Artifacts delete. `db` defaults to an inert stub for tests that never reach a claim. */
function makeEnv(db: D1Database = {} as D1Database) {
  const artifactsDelete = vi.fn(async () => undefined);
  return {
    env: {
      DB: db,
      STATE: {} as KVNamespace,
      ARTIFACTS: { delete: artifactsDelete } as never,
    },
    artifactsDelete,
  };
}

const aliceProj = { ownerId: "usr_1", namespace: "@alice", slug: "proj" };

const confirm = (env: ReturnType<typeof makeEnv>["env"]) =>
  confirmOwnerNamespace(env, "usr_1", "@alice", "proj", logger);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteProject).mockResolvedValue(deleted);
});

describe("confirmOwnerNamespace", () => {
  it("keeps a project whose owner still carries the namespace", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("withdraws a project written under a name the owner no longer has", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalledWith(env.STATE, "@alice", "proj", logger);
    expect(artifactsDelete).toHaveBeenCalledWith("alice__proj");
  });

  it("still withdraws when the backing repository cannot be deleted", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    artifactsDelete.mockRejectedValue(new Error("artifacts down"));
    const result = await confirm(env);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalled();
  });

  // One failed read must not decide a project's fate; two do, and the answer
  // is to withdraw rather than leave an entry a rename may have stranded.
  it("retries the owner read once and keeps the project when it then matches", async () => {
    vi.mocked(getUser).mockResolvedValueOnce(unreadable).mockResolvedValueOnce(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("withdraws the project and reports a server error when the owner cannot be re-read", async () => {
    vi.mocked(getUser).mockResolvedValue(unreadable);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(artifactsDelete).toHaveBeenCalledWith("alice__proj");
  });

  // A read that throws is a failed read, not an unhandled rejection that would
  // leave the project in place with no verdict at all.
  it("treats a read that throws like one that fails, and withdraws after two", async () => {
    vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));
    const { env } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the project when a thrown first read is followed by a matching one", async () => {
    vi.mocked(getUser)
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("releases the namespace claim of a withdrawn project", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const { env } = makeEnv(db);
    expect((await confirm(env)).success).toBe(false);
    const claims = await ownerHasClaims(db, "usr_1", logger);
    expect(claims.success && claims.data).toBe(false);
  });

  it("keeps the claim, like the repository, when the entry cannot be removed", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const { env } = makeEnv(db);
    expect((await confirm(env)).success).toBe(false);
    const claims = await ownerHasClaims(db, "usr_1", logger);
    expect(claims.success && claims.data).toBe(true);
  });

  // KV first, repository second: a project whose entry cannot be removed is
  // still reachable, so its repository must stay, and someone has to know.
  it("retries the entry delete once, then withdraws normally", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValueOnce(notDeleted).mockResolvedValueOnce(deleted);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalledTimes(2);
    expect(artifactsDelete).toHaveBeenCalled();
  });

  it("keeps the repository and reports a server error when the entry cannot be removed", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(artifactsDelete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("namespace claims", () => {
  it("records a claim and reports it for its owner only", async () => {
    const { db } = makeSqliteD1();
    expect((await claimNamespace(db, aliceProj, logger)).success).toBe(true);
    const alice = await ownerHasClaims(db, "usr_1", logger);
    const bob = await ownerHasClaims(db, "usr_2", logger);
    expect(alice.success && alice.data).toBe(true);
    expect(bob.success && bob.data).toBe(false);
  });

  it("refreshes rather than rejects the same owner re-creating a deleted slug", async () => {
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const again = await claimNamespace(db, aliceProj, logger);
    expect(again.success).toBe(true);
  });

  it("releases a claim so a withdrawn creation leaves nothing behind", async () => {
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    expect((await releaseNamespaceClaim(db, "@alice", "proj", logger)).success).toBe(true);
    const claims = await ownerHasClaims(db, "usr_1", logger);
    expect(claims.success && claims.data).toBe(false);
  });

  it("reports a database failure as a Result rather than throwing", async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("D1 down");
          },
          first: async () => {
            throw new Error("D1 down");
          },
        }),
      }),
    } as unknown as D1Database;
    expect((await claimNamespace(broken, aliceProj, logger)).success).toBe(false);
    expect((await ownerHasClaims(broken, "usr_1", logger)).success).toBe(false);
    expect((await releaseNamespaceClaim(broken, "@alice", "proj", logger)).success).toBe(false);
  });
});
