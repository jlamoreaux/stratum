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

interface AnalyticsEngineDataset {
  writeDataPoint(data: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface Queue<T = unknown> {
  send(body: T): Promise<void>;
}

export interface MessageBatch<T = unknown> {
  messages: Array<{ body: T; ack(): void; retry(): void }>;
}

export interface AiBinding {
  run(
    model: string,
    options: {
      messages?: Array<{ role: string; content: string }>;
      prompt?: string;
    },
  ): Promise<{ response?: string } | ReadableStream>;
}

export interface SandboxBinding {
  create(): Promise<SandboxInstance>;
}

export interface SandboxInstance {
  writeFile(path: string, content: string): Promise<void>;
  run(
    command: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy(): Promise<void>;
}

export interface Env {
  ARTIFACTS: ArtifactsNamespace;
  STATE: KVNamespace;
  DB: D1Database;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  ANALYTICS?: AnalyticsEngineDataset;
  SANDBOX?: SandboxBinding;
  AI?: AiBinding;
  MERGE_QUEUE?: DurableObjectNamespace;
  EVENTS_QUEUE?: Queue;
}

export interface ProjectEntry {
  name: string;
  remote: string;
  token: string;
  createdAt: string;
  githubUrl?: string;
  ownerId?: string;
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

export interface User {
  id: string;
  email: string;
  githubId?: string;
  githubUsername?: string;
  tokenHash: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface Agent {
  id: string;
  name: string;
  ownerId: string;
  model?: string;
  description?: string;
  promptHash?: string;
  tokenHash: string;
  createdAt: string;
}

export interface Change {
  id: string;
  project: string;
  workspace: string;
  status: "open" | "approved" | "merged" | "rejected";
  agentId?: string;
  evalScore?: number;
  evalPassed?: boolean;
  evalReason?: string;
  createdAt: string;
  mergedAt?: string;
}
