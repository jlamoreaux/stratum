import { describe, expect, it } from "vitest";
import { repoDoConfigError } from "../src/middleware/config-guard";
import type { Env } from "../src/types";

const bucket = {} as Env["REPO_OBJECTS"];

describe("repoDoConfigError", () => {
  it("flags REPO_DO_ENABLED='true' with no REPO_OBJECTS bound", () => {
    const problem = repoDoConfigError({ REPO_DO_ENABLED: "true", REPO_OBJECTS: undefined });
    expect(problem).toContain("REPO_OBJECTS");
    expect(problem).toContain("REPO_DO_ENABLED");
  });

  it("is silent when the flag is on and the bucket is bound (staging)", () => {
    expect(repoDoConfigError({ REPO_DO_ENABLED: "true", REPO_OBJECTS: bucket })).toBeNull();
  });

  it("is silent when the flag is off, bound or not (production default)", () => {
    expect(repoDoConfigError({ REPO_DO_ENABLED: "false", REPO_OBJECTS: undefined })).toBeNull();
    expect(repoDoConfigError({ REPO_DO_ENABLED: undefined, REPO_OBJECTS: undefined })).toBeNull();
  });
});
