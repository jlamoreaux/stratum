import { describe, expect, it } from "vitest";
import { discoveryRouter } from "../src/routes/discovery";

const ORIGIN = "https://app.usestratum.dev";

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

interface AuthServerMetadata {
  issuer: string;
  service_documentation: string;
  scopes_supported: string[];
  grant_types_supported: string[];
  agent_auth: {
    skill: string;
    register_uri: string;
    identity_types_supported: string[];
    credential_types_supported: string[];
    registration_methods: Array<{ identity_type: string; method: string; uri: string }>;
    claim_uri: string;
    revocation_uri: string;
    revocation_method: string;
  };
}

describe("GET /auth.md", () => {
  it("serves markdown with an auth.md H1 and origin-derived URLs", async () => {
    const res = await discoveryRouter.request(`${ORIGIN}/auth.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Cache-Control")).toContain("public");

    const body = await res.text();
    const h1 = body.split("\n")[0] ?? "";
    expect(h1.startsWith("# ")).toBe(true);
    expect(h1).toContain("auth.md");
    expect(body).toContain(`${ORIGIN}/api/agents`);
    expect(body).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(body).toContain("stratum_agent_");
  });

  it("derives URLs from the request origin (self-hosted instances)", async () => {
    const res = await discoveryRouter.request("https://stratum.example.com/auth.md");
    const body = await res.text();
    expect(body).toContain("https://stratum.example.com/api/agents");
    expect(body).not.toContain("usestratum.dev/api/agents");
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns RFC 9728 metadata with header bearer method", async () => {
    const res = await discoveryRouter.request(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProtectedResourceMetadata;
    expect(body.resource).toBe(ORIGIN);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.bearer_methods_supported).toContain("header");
    expect(body.scopes_supported.length).toBeGreaterThan(0);
    expect(body.resource_documentation).toBe(`${ORIGIN}/auth.md`);
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns an issuer matching the protected-resource advertisement", async () => {
    const prRes = await discoveryRouter.request(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const pr = (await prRes.json()) as ProtectedResourceMetadata;

    const asRes = await discoveryRouter.request(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(asRes.status).toBe(200);
    const as = (await asRes.json()) as AuthServerMetadata;

    expect(as.issuer).toBe(ORIGIN);
    expect(pr.authorization_servers).toContain(as.issuer);
    expect(as.service_documentation).toBe(`${ORIGIN}/auth.md`);
    // Stratum runs no OAuth flows as an AS — the grant list must stay honest.
    expect(as.grant_types_supported).toEqual([]);
  });

  it("carries a complete agent_auth registration block", async () => {
    const res = await discoveryRouter.request(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const { agent_auth: agentAuth } = (await res.json()) as AuthServerMetadata;

    expect(agentAuth.skill).toBe(`${ORIGIN}/auth.md`);
    expect(agentAuth.register_uri).toBe(`${ORIGIN}/api/agents`);
    expect(agentAuth.identity_types_supported).toContain("service_auth");
    expect(agentAuth.credential_types_supported).toContain("bearer_token");
    expect(agentAuth.claim_uri).toBe(`${ORIGIN}/auth/signup`);
    expect(agentAuth.revocation_uri).toBe(`${ORIGIN}/api/agents/{agent_id}`);
    expect(agentAuth.revocation_method).toBe("DELETE");

    const method = agentAuth.registration_methods[0];
    expect(method).toBeDefined();
    expect(method?.identity_type).toBe("service_auth");
    expect(method?.method).toBe("POST");
    expect(method?.uri).toBe(`${ORIGIN}/api/agents`);
  });
});
