export interface ArtifactsCreateResult {
  name: string;
  remote: string;
  token: string;
}

export interface ArtifactsRepo {
  name: string;
  remote: string;
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<{ plaintext: string; expiresAt: number }>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<ArtifactsCreateResult>;
}

export interface ArtifactsNamespace {
  create(name: string, opts?: Record<string, unknown>): Promise<ArtifactsCreateResult>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: Record<string, unknown>): Promise<unknown>;
  delete(name: string): Promise<boolean>;
}

export interface Env {
  ARTIFACTS: ArtifactsNamespace;
  STATE: KVNamespace;
}

export interface ProjectEntry {
  name: string;
  remote: string;
  token: string;
  createdAt: string;
}

export interface WorkspaceEntry {
  name: string;
  remote: string;
  token: string;
  parent: string;
  createdAt: string;
}

export interface Author {
  name: string;
  email: string;
}

export interface CommitLogEntry {
  sha: string;
  message: string;
  author: string;
  timestamp: number;
}

export interface ApiError {
  error: string;
  code?: string;
}
