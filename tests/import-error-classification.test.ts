import { describe, expect, it } from "vitest";
import { classifyError } from "../src/ui/components/import-progress";

describe("classifyError — Git LFS ordering", () => {
  // Stratum exposes no LFS route, so an LFS batch request reaches the app's
  // notFound handler and surfaces as `{"error":"Not found"}` with a 404. Both
  // tokens match the not-found branch, so an LFS message MUST be classified
  // before it — otherwise the failure this guidance exists to explain is
  // reported as a mistyped repository URL.
  it.each([
    [
      "batch endpoint 404",
      'git-lfs: batch request to /objects/batch failed: 404 {"error":"Not found"}',
    ],
    ["lfs marker with not found", "Git LFS objects/batch: Not found"],
    ["smudge filter failure", "external filter 'git-lfs filter-process' failed"],
  ])("classifies an LFS failure that also looks like a 404 (%s)", (_label, message) => {
    const info = classifyError(message);
    expect(info.title).toBe("Git LFS Not Supported");
    expect(info.type).toBe("GIT_ERROR");
    expect(info.tips.join(" ")).toContain("pointer files");
  });

  it("still reports a genuine missing repository as NOT_FOUND", () => {
    const info = classifyError("Repository not found (404)");
    expect(info.type).toBe("NOT_FOUND");
    expect(info.title).toBe("Repository Not Found");
  });

  // The LFS tip used to hang off every git error, so an unrelated clone
  // failure advertised a limitation that had nothing to do with it.
  it("does not mention LFS on an unrelated git error", () => {
    const info = classifyError("git clone failed: repository has submodules");
    expect(info.type).toBe("GIT_ERROR");
    expect(info.title).toBe("Git Operation Failed");
    expect(info.tips.join(" ").toLowerCase()).not.toContain("lfs");
  });

  it("still classifies auth failures ahead of everything else", () => {
    expect(classifyError("403 unauthorized").type).toBe("AUTH_ERROR");
  });
});
