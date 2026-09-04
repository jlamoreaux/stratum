/**
 * `confirmOwnerNamespace`: the creation-side half of the rename race guard.
 * Its counterpart, the rename's second listing, is covered in
 * account-settings.test.tsx; between them no interleaving leaves a project
 * under a namespace nobody owns. The guard fails closed: an owner that cannot
 * be re-read or a project that cannot be withdrawn is a server error, never
 * a silently kept entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));
vi.mock("../src/storage/state", () => ({ deleteProject: vi.fn() }));

import { confirmOwnerNamespace } from "../src/storage/project-namespace";
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

function makeEnv() {
  const artifactsDelete = vi.fn(async () => undefined);
  return {
    env: {
      DB: {} as D1Database,
      STATE: {} as KVNamespace,
      ARTIFACTS: { delete: artifactsDelete } as never,
    },
    artifactsDelete,
  };
}

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
