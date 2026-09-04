/**
 * `confirmOwnerNamespace`: the creation-side half of the rename race guard.
 * Its counterpart, the rename's second listing, is covered in
 * account-settings.test.tsx; between them no interleaving leaves a project
 * under a namespace nobody owns.
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteProject).mockResolvedValue({ success: true, data: undefined });
});

describe("confirmOwnerNamespace", () => {
  it("keeps a project whose owner still carries the namespace", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice"));
    const { env } = makeEnv();
    const result = await confirmOwnerNamespace(env, "usr_1", "@alice", "proj", logger);
    expect(result.success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("withdraws a project written under a name the owner no longer has", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    const result = await confirmOwnerNamespace(env, "usr_1", "@alice", "proj", logger);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalledWith(env.STATE, "@alice", "proj", logger);
    expect(artifactsDelete).toHaveBeenCalledWith("alice__proj");
  });

  it("still withdraws when the backing repository cannot be deleted", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    artifactsDelete.mockRejectedValue(new Error("artifacts down"));
    const result = await confirmOwnerNamespace(env, "usr_1", "@alice", "proj", logger);
    expect(result.success).toBe(false);
    expect(deleteProject).toHaveBeenCalled();
  });

  // A transient read failure must not destroy a project that was just made.
  it("keeps the project when the owner cannot be re-read", async () => {
    vi.mocked(getUser).mockResolvedValue({ success: false, error: new Error("d1") as never });
    const { env } = makeEnv();
    const result = await confirmOwnerNamespace(env, "usr_1", "@alice", "proj", logger);
    expect(result.success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
