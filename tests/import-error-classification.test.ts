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

  // The ordering fix above put the LFS branch ahead of not-found, so an
  // over-broad LFS predicate is answered on far more messages than a real LFS
  // failure. "lfs" appears in ordinary repository names, and a 404 for one of
  // those must not be reported as an LFS limitation.
  it.each([
    ["repo name", "Repository not found: https://github.com/acme/lfs-tools (404)"],
    ["owner name", "fatal: repository 'https://github.com/lfs/demo.git' not found"],
    ["branch name", "couldn't find remote ref refs/heads/add-lfs-support (404)"],
    // "git-lfs" is itself a repository name. A bare-token match — and word
    // boundaries too, since /\bgit-lfs\b/ matches "git-lfs-tools" — puts these
    // on the LFS branch and strips the "View Repository" action.
    [
      "repo named git-lfs-tools",
      "Repository not found: https://github.com/acme/git-lfs-tools (404)",
    ],
    [
      "the git-lfs project itself",
      "fatal: repository 'https://github.com/git-lfs/git-lfs.git' not found",
    ],
    // Path-shaped markers are unusable however LFS-specific they look: a
    // repository URL can contain any path, so an owner/repo pair is free to
    // spell one out.
    ["owner info, repo lfs", "repository not found: https://github.com/info/lfs (404)"],
    [
      "owner objects, repo batch",
      "fatal: repository 'https://github.com/objects/batch.git' not found",
    ],
  ])(
    "classifies a 404 for a repository merely named ...lfs... as NOT_FOUND (%s)",
    (_l, message) => {
      const info = classifyError(message);
      expect(info.type).toBe("NOT_FOUND");
      expect(info.title).toBe("Repository Not Found");
    },
  );

  // The LFS tip used to hang off every git error, so an unrelated clone
  // failure advertised a limitation that had nothing to do with it.
  it("does not mention LFS on an unrelated git error", () => {
    const info = classifyError("git clone failed: repository has submodules");
    expect(info.type).toBe("GIT_ERROR");
    expect(info.title).toBe("Git Operation Failed");
    expect(info.tips.join(" ").toLowerCase()).not.toContain("lfs");
  });

  // git-lfs reports batch-API failures without naming itself, so this form
  // matches none of the tool-name markers even though it is git-lfs output.
  it("classifies a batch-response failure that never names git-lfs", () => {
    const info = classifyError(
      "batch response: Repository or object not found: https://github.com/acme/app.git/info/lfs/objects/batch",
    );
    expect(info.type).toBe("GIT_ERROR");
    expect(info.title).toBe("Git LFS Not Supported");
  });

  it.each([
    [
      "endpoint path alone, no batch-response prefix",
      "fatal: repository 'https://github.com/info/lfs/objects/batch.git' not found (404)",
    ],
    [
      "batch-response prefix alone, unrelated endpoint",
      "batch response: not found: https://github.com/acme/app.git/objects/info",
    ],
  ])("requires BOTH halves before treating a batch response as LFS (%s)", (_label, message) => {
    // Either half alone is ambiguous: the path is path-shaped and can be a
    // real repository, and "batch response" is ordinary English. Only the
    // pair is evidence, so a single half must fall through to not-found and
    // keep the "View Repository" action.
    const info = classifyError(message);
    expect(info.type).toBe("NOT_FOUND");
    expect(info.title).toBe("Repository Not Found");
  });

  it("still classifies auth failures ahead of everything else", () => {
    expect(classifyError("403 unauthorized").type).toBe("AUTH_ERROR");
  });
});

/**
 * The message classification reads carries the repository URL, so a bare
 * substring test lets the repository's NAME decide its error message. Invisible
 * to any rendering test: the function returns a perfectly well-formed object,
 * just the wrong one.
 */
describe("classifyError — a repository's name must not decide its error message", () => {
  // Every row is a repository that does not exist, failing with a 404. The
  // name contains a word that one of the branches used to match on.
  it.each([
    ["oauth ⊃ auth", "Repository not found: https://github.com/acme/oauth-server (404)"],
    ["fetch-utils ⊃ fetch", "Repository not found: https://github.com/acme/fetch-utils (404)"],
    ["timeout-rs ⊃ timeout", "Repository not found: https://github.com/acme/timeout-rs (404)"],
    [
      "connection-pool ⊃ connection",
      "Repository not found: https://github.com/acme/connection-pool (404)",
    ],
    ["network ⊃ network", "Repository not found: https://github.com/acme/network-tools (404)"],
    [
      "credentials ⊃ credentials",
      "fatal: repository 'https://github.com/acme/credentials' not found",
    ],
    // The scp-style remote carries the same names and must be stripped too.
    ["scp-style remote", "fatal: repository 'git@github.com:acme/oauth-server.git' not found"],
    // An owner, not a repo.
    ["owner name", "Repository not found: https://github.com/timeout/demo (404)"],
  ])("reports a missing %s repository as NOT_FOUND", (_label, message) => {
    const info = classifyError(message);
    expect(info.type).toBe("NOT_FOUND");
    expect(info.title).toBe("Repository Not Found");
  });

  // Narrowing the predicates trades a false positive for a false negative if
  // done carelessly, so every phrasing git and the GitHub API actually emit
  // gets its own row.
  it.each([
    ["git over https", "fatal: Authentication failed for 'https://github.com/acme/private.git/'"],
    [
      "no terminal prompt",
      "fatal: could not read Username for 'https://github.com': No such device",
    ],
    ["ssh refusal", "git@github.com: Permission denied (publickey)."],
    ["github api", '{"message":"Bad credentials","status":"401"}'],
    ["private repo via api", '{"message":"Must have admin rights. Requires authentication"}'],
    ["bare 403", "remote: HTTP 403 while accessing the repository"],
  ])("still reports a real authentication failure as AUTH_ERROR (%s)", (_label, message) => {
    const info = classifyError(message);
    expect(info.type).toBe("AUTH_ERROR");
    expect(info.title).toBe("Authentication Failed");
  });

  it.each([
    [
      "connection refused",
      "fatal: unable to access 'https://github.com/acme/x.git/': Failed to connect to github.com port 443: Connection refused",
    ],
    ["curl timeout", "error: RPC failed; curl 28 Operation timed out after 30001 milliseconds"],
    ["dns", "request to https://github.com/acme/x.git failed, reason: getaddrinfo ENOTFOUND"],
    ["socket", "fetch failed: socket hang up"],
    ["unreachable", "connect: Network is unreachable"],
  ])("still reports a real transport failure as NETWORK_ERROR (%s)", (_label, message) => {
    const info = classifyError(message);
    expect(info.type).toBe("NETWORK_ERROR");
    expect(info.title).toBe("Network Error");
  });

  // A URL path that happens to contain three digits is not an HTTP status.
  it("does not read digits inside a repository path as a status code", () => {
    const info = classifyError(
      "Repository not found: https://github.com/acme/error-403-demo (404)",
    );
    expect(info.type).toBe("NOT_FOUND");
  });

  // The URL strip must not disturb the LFS detection added in #218, whose
  // batch marker is a path that can legitimately arrive inside a URL.
  it("still classifies an LFS batch failure whose endpoint is a full URL", () => {
    const info = classifyError(
      "batch response: https://github.com/acme/x.git/info/lfs/objects/batch returned 404",
    );
    expect(info.title).toBe("Git LFS Not Supported");
  });
});
