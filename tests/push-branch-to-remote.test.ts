import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("isomorphic-git", () => ({
  default: { push: vi.fn() },
}));

import git from "isomorphic-git";
import { type NodeFS, pushBranchToRemote } from "../src/storage/git-ops";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });
const fs = {} as NodeFS;

describe("pushBranchToRemote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes local main to the given remote ref with token auth, not forced by default", async () => {
    vi.mocked(git.push).mockResolvedValueOnce({ ok: true } as never);

    const result = await pushBranchToRemote(
      fs,
      "/",
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "refs/heads/stratum/chg_1",
        token: "gh-token",
      },
      logger,
    );

    expect(result.success).toBe(true);
    expect(git.push).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(git.push).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(opts.url).toBe("https://github.com/acme/widgets.git");
    expect(opts.ref).toBe("main");
    expect(opts.remoteRef).toBe("refs/heads/stratum/chg_1");
    expect(opts.force).toBe(false);
    const onAuth = opts.onAuth as () => { username: string; password: string };
    expect(onAuth()).toEqual({ username: "x-access-token", password: "gh-token" });
  });

  it("passes an explicit force: true through, for a Stratum-owned ref", async () => {
    vi.mocked(git.push).mockResolvedValueOnce({ ok: true } as never);

    const result = await pushBranchToRemote(
      fs,
      "/",
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "refs/heads/stratum/chg_1",
        token: "gh-token",
        force: true,
      },
      logger,
    );

    expect(result.success).toBe(true);
    const opts = vi.mocked(git.push).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(opts.force).toBe(true);
  });

  it("wraps push failures in a 502 external-service error without leaking the token", async () => {
    vi.mocked(git.push).mockRejectedValueOnce(new Error("HTTP Error: 403 Forbidden"));

    const result = await pushBranchToRemote(
      fs,
      "/",
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "refs/heads/stratum/chg_1",
        token: "gh-token",
      },
      logger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.statusCode).toBe(502);
      expect(result.error.message).toContain("Failed to push branch");
      expect(result.error.message).toContain("HTTP Error: 403 Forbidden");
      expect(result.error.message).not.toContain("gh-token");
    }
  });
});
