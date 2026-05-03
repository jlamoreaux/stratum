# Error Handling & Logging Refactor Plan

## Executive Summary

**Scope:** 53 TypeScript files  
**Current State:** Ad-hoc error handling, 16+ console statements, inconsistent patterns  
**Target State:** `better-result` pattern everywhere, structured logging with pino  
**Estimated Effort:** Large - requires multiple agents

---

## Part 1: Infrastructure Setup

### 1.1 Install Dependencies
**File:** `package.json`

Add to dependencies:
```json
{
  "pino": "^9.0.0",
  "pino-pretty": "^11.0.0"
}
```

### 1.2 Create Logger Module
**New File:** `src/utils/logger.ts`

```typescript
import pino from 'pino';

export interface LoggerContext {
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, error?: Error, meta?: Record<string, unknown>) => void;
  fatal: (msg: string, error?: Error, meta?: Record<string, unknown>) => void;
  child: (context: LoggerContext) => Logger;
}

// Implementation that works in Cloudflare Workers
export function createLogger(context: LoggerContext = {}): Logger {
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development' 
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    base: {
      service: 'stratum',
      ...context,
    },
  });

  return {
    trace: (msg, meta) => logger.trace(meta || {}, msg),
    debug: (msg, meta) => logger.debug(meta || {}, msg),
    info: (msg, meta) => logger.info(meta || {}, msg),
    warn: (msg, meta) => logger.warn(meta || {}, msg),
    error: (msg, error, meta) => logger.error({ err: error, ...meta }, msg),
    fatal: (msg, error, meta) => logger.fatal({ err: error, ...meta }, msg),
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

// Singleton for use outside request context
export const defaultLogger = createLogger();
```

### 1.3 Create Result Type Module
**New File:** `src/utils/result.ts`

```typescript
export type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

export function fromThrowable<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function fromPromise<T>(
  promise: Promise<T>
): Promise<Result<T, Error>> {
  try {
    const data = await promise;
    return ok(data);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// Helper to unwrap with default
export function unwrapOr<T>(result: Result<T, unknown>, defaultValue: T): T {
  return result.success ? result.data : defaultValue;
}

// Helper to map error
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  return result.success ? result : err(fn(result.error));
}

// Helper to chain results
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (data: T) => Result<U, E>
): Result<U, E> {
  return result.success ? fn(result.data) : result;
}
```

### 1.4 Create Error Types Module
**New File:** `src/utils/errors.ts`

```typescript
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, context);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, 'NOT_FOUND', 404, { resource, id });
    this.name = 'NotFoundError';
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    service: string,
    message: string,
    public readonly cause?: Error
  ) {
    super(
      `${service} error: ${message}`,
      'EXTERNAL_SERVICE_ERROR',
      502,
      { service, cause: cause?.message }
    );
    this.name = 'ExternalServiceError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(error.message, 'INTERNAL_ERROR', 500);
  }
  return new AppError(String(error), 'INTERNAL_ERROR', 500);
}
```

---

## Part 2: File-by-File Assessment

### Category A: Routes (12 files) - HIGH PRIORITY
**Pattern:** Convert to use Result types and structured logging

1. **src/routes/projects.ts**
   - Lines: ~160
   - Console statements: 1 (line 140)
   - Error patterns: try-catch with console.error
   - Changes needed:
     - [ ] Replace console.error with logger
     - [ ] Convert API calls to return Result types
     - [ ] Add request context logging

2. **src/routes/workspaces.ts**
   - Lines: ~120
   - Console statements: 1 (line 113)
   - Changes needed:
     - [ ] Replace console.warn with logger.warn
     - [ ] Add structured error context

3. **src/routes/changes.ts**
   - Lines: ~511
   - Console statements: 1 (line 119)
   - Error patterns: try-catch, returns error responses
   - Changes needed:
     - [ ] Replace ad-hoc error handling
     - [ ] Add operation logging with context
     - [ ] Convert to Result types

4. **src/routes/users.ts**
   - Lines: ~80
   - Changes needed:
     - [ ] Add logging for user operations
     - [ ] Result types for DB operations

5. **src/routes/agents.ts**
   - Lines: ~100
   - Changes needed:
     - [ ] Add logging
     - [ ] Result types

6. **src/routes/orgs.ts**
   - Lines: ~192
   - Changes needed:
     - [ ] Add logging for org operations
     - [ ] Result types

7. **src/routes/auth.ts**
   - Lines: ~161
   - Changes needed:
     - [ ] Add logging for auth flows
     - [ ] Error handling with context

8. **src/routes/email-auth.tsx**
   - Lines: ~362
   - Console statements: 7
   - Changes needed:
     - [ ] Replace all console.* with logger
     - [ ] Add structured logging with email context (sanitized)

9. **src/routes/sync.ts**
   - Lines: ~150
   - Changes needed:
     - [ ] Add logging for sync operations
     - [ ] Result types

10. **src/routes/ui.tsx**
    - Lines: ~220
    - Changes needed:
      - [ ] Add request logging
      - [ ] Error handling with context

11. **src/ui/pages/*.tsx** (6 files)
    - Changes needed:
      - [ ] Minimal - mostly presentational

### Category B: Storage Layer (11 files) - HIGH PRIORITY
**Pattern:** Return Result types instead of throwing or returning null

1. **src/storage/state.ts**
   - Lines: ~73
   - Console statements: 1 (line 10)
   - Changes needed:
     - [ ] Replace console.error with logger
     - [ ] Return Result types instead of null
     - [ ] Add KV operation logging

2. **src/storage/users.ts**
   - Lines: ~116
   - Current: Throws errors
   - Changes needed:
     - [ ] Convert throws to Result types
     - [ ] Add user operation logging

3. **src/storage/sessions.ts**
   - Lines: ~46
   - Changes needed:
     - [ ] Return Result types
     - [ ] Add session logging

4. **src/storage/changes.ts**
   - Lines: ~200
   - Changes needed:
     - [ ] Return Result types
     - [ ] Add change operation logging

5. **src/storage/agents.ts**
   - Lines: ~80
   - Changes needed:
     - [ ] Return Result types
     - [ ] Add agent logging

6. **src/storage/orgs.ts**
   - Lines: ~123
   - Changes needed:
     - [ ] Return Result types
     - [ ] Add org operation logging

7. **src/storage/teams.ts**
   - Lines: ~100
   - Changes needed:
     - [ ] Return Result types

8. **src/storage/provenance.ts**
   - Lines: ~80
   - Changes needed:
     - [ ] Return Result types

9. **src/storage/eval-runs.ts**
   - Lines: ~60
   - Changes needed:
     - [ ] Return Result types

10. **src/storage/git-ops.ts**
    - Lines: ~397
    - Console statements: 1 (line 304)
    - Error patterns: Throws errors, custom error types
    - Changes needed:
      - [ ] Convert throws to Result types
      - [ ] Replace console.error with logger
      - [ ] Add git operation logging
      - [ ] Keep MergeConflictError but make it an AppError

11. **src/storage/memory-fs.ts**
    - Lines: ~180
    - Error patterns: Custom fsError function
    - Changes needed:
      - [ ] Convert to Result types
      - [ ] Keep error codes

### Category C: Evaluation Layer (5 files) - MEDIUM PRIORITY

1. **src/evaluation/composite-evaluator.ts**
2. **src/evaluation/diff-evaluator.ts**
3. **src/evaluation/llm-evaluator.ts**
   - Console statements: 1 (line 95)
4. **src/evaluation/webhook-evaluator.ts**
   - Console statements: 1 (line 51)
5. **src/evaluation/sandbox-evaluator.ts**
   - Console statements: 1 (line 97)
6. **src/evaluation/secret-scanner.ts**

Changes needed:
- [ ] Add evaluation logging
- [ ] Result types for eval operations
- [ ] Replace console statements

### Category D: Queue & Middleware (5 files) - MEDIUM PRIORITY

1. **src/queue/merge-queue.ts**
   - Console statements: 1 (line 56)
   - Changes needed:
     - [ ] Add merge queue logging
     - [ ] Result types

2. **src/queue/ttl-sweep.ts**
   - Changes needed:
     - [ ] Add sweep logging

3. **src/queue/events.ts**
   - Changes needed:
     - [ ] Add event publishing logging

4. **src/middleware/auth.ts**
   - Changes needed:
     - [ ] Add auth logging with context

5. **src/middleware/analytics.ts**
6. **src/middleware/rate-limit.ts**

### Category E: Utils & Core (6 files) - LOW PRIORITY

1. **src/utils/response.ts**
   - Current: HTTP response helpers
   - Changes needed:
     - [ ] Integrate with AppError types
     - [ ] Add logging hooks

2. **src/utils/validation.ts**
   - Changes needed:
     - [ ] Return Result types instead of boolean

3. **src/utils/authz.ts**
4. **src/utils/crypto.ts**
5. **src/utils/ids.ts**
6. **src/types.ts**
   - Changes needed:
     - [ ] Add Result types
     - [ ] Add logging context types

### Category F: UI Layer (7 files) - LOW PRIORITY

1. **src/ui/layout.tsx**
2. **src/ui/styles.ts**
3. **src/ui/pages/*.tsx** (5 files)
   - Changes needed: Minimal - mostly presentational

---

## Part 3: Implementation Phases

### Phase 1: Infrastructure (1 agent)
**Duration:** 30 minutes
**Files:** 3 new files, package.json

1. Install pino dependencies
2. Create logger.ts
3. Create result.ts
4. Create errors.ts
5. Update types.ts with new types

### Phase 2: Storage Layer (2-3 agents in parallel)
**Duration:** 1-2 hours
**Files:** 11 files

Agent 2A: Core storage (state, users, sessions)
Agent 2B: Project storage (changes, agents, provenance)
Agent 2C: Org storage (orgs, teams, eval-runs)
Agent 2D: Git operations (git-ops, memory-fs)

Each agent:
- [ ] Replace console statements with logger
- [ ] Convert functions to return Result<T, Error>
- [ ] Add structured logging with context
- [ ] Update tests

### Phase 3: Routes (3 agents in parallel)
**Duration:** 2-3 hours
**Files:** 12 files

Agent 3A: Core routes (projects, workspaces, changes)
Agent 3B: Auth routes (auth, email-auth, users, agents)
Agent 3C: Other routes (orgs, sync, ui)

Each agent:
- [ ] Replace console statements with logger
- [ ] Handle Result types from storage
- [ ] Add request context logging
- [ ] Update error responses
- [ ] Update tests

### Phase 4: Evaluation & Queue (2 agents)
**Duration:** 1 hour
**Files:** 8 files

Agent 4A: Evaluators
Agent 4B: Queue and middleware

### Phase 5: Integration & Testing (1 agent)
**Duration:** 1 hour
**Files:** All

1. Integration testing
2. Fix any type errors
3. Verify all console statements replaced
4. Run full test suite
5. Update documentation

---

## Part 4: Example Transformations

### Before (Current State)
```typescript
// src/storage/state.ts
export async function getProject(kv: KVNamespace, name: string): Promise<ProjectEntry | null> {
  const raw = await kv.get(projectKey(name));
  return raw ? parseEntry<ProjectEntry>(raw, projectKey(name)) : null;
}

// src/routes/projects.ts
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const repo = await c.env.ARTIFACTS.create(body.name);
    await initAndPush(repo.remote, repo.token, files, "Initial commit");
    return created({ name: body.name });
  } catch (err) {
    console.error("[import] Error:", err);
    return c.json({ error: "Import failed" }, 500);
  }
});
```

### After (Target State)
```typescript
// src/storage/state.ts
export async function getProject(
  kv: KVNamespace, 
  name: string,
  logger: Logger
): Promise<Result<ProjectEntry, NotFoundError>> {
  logger.debug('Fetching project from KV', { name });
  
  const raw = await kv.get(projectKey(name));
  if (!raw) {
    return err(new NotFoundError('Project', name));
  }
  
  const parsed = parseEntry<ProjectEntry>(raw, projectKey(name));
  if (!parsed) {
    logger.error('Failed to parse project entry', undefined, { name });
    return err(new AppError('Invalid project data', 'PARSE_ERROR'));
  }
  
  return ok(parsed);
}

// src/routes/projects.ts
app.post("/", async (c) => {
  const logger = c.get('logger') as Logger;
  
  const result = await fromPromise(
    (async () => {
      const body = await c.req.json();
      const repo = await c.env.ARTIFACTS.create(body.name);
      await initAndPush(repo.remote, repo.token, files, "Initial commit");
      return { name: body.name };
    })()
  );
  
  if (!result.success) {
    logger.error('Failed to create project', result.error, { 
      userId: c.get('userId'),
      projectName: body.name 
    });
    return internalError('Failed to create project');
  }
  
  logger.info('Project created', { 
    name: result.data.name,
    userId: c.get('userId') 
  });
  
  return created(result.data);
});
```

---

## Part 5: Agent Task Allocation

### Agent A: Infrastructure Setup
**Files:**
- `package.json`
- `src/utils/logger.ts` (NEW)
- `src/utils/result.ts` (NEW)
- `src/utils/errors.ts` (NEW)
- `src/types.ts` (MODIFY)

**Deliverables:**
- Working logger with pino
- Result type utilities
- AppError hierarchy
- Updated types

### Agent B: Storage Layer - Part 1
**Files:**
- `src/storage/state.ts`
- `src/storage/users.ts`
- `src/storage/sessions.ts`

### Agent C: Storage Layer - Part 2
**Files:**
- `src/storage/changes.ts`
- `src/storage/agents.ts`
- `src/storage/provenance.ts`

### Agent D: Storage Layer - Part 3
**Files:**
- `src/storage/orgs.ts`
- `src/storage/teams.ts`
- `src/storage/eval-runs.ts`

### Agent E: Git Operations
**Files:**
- `src/storage/git-ops.ts`
- `src/storage/memory-fs.ts`

### Agent F: Core Routes
**Files:**
- `src/routes/projects.ts`
- `src/routes/workspaces.ts`
- `src/routes/changes.ts`

### Agent G: Auth Routes
**Files:**
- `src/routes/auth.ts`
- `src/routes/email-auth.tsx`
- `src/routes/users.ts`
- `src/routes/agents.ts`

### Agent H: Other Routes
**Files:**
- `src/routes/orgs.ts`
- `src/routes/sync.ts`
- `src/routes/ui.tsx`

### Agent I: Evaluation Layer
**Files:**
- `src/evaluation/*.ts` (6 files)

### Agent J: Queue & Middleware
**Files:**
- `src/queue/*.ts` (3 files)
- `src/middleware/*.ts` (3 files)
- `src/utils/response.ts`
- `src/utils/validation.ts`

### Agent K: Integration & Testing
**Responsibilities:**
- Run all tests
- Fix integration issues
- Verify no console statements remain
- Update documentation

---

## Quick Start Commands

```bash
# Install dependencies
npm install pino pino-pretty

# Run typecheck
npm run typecheck

# Run tests
npm test -- --run

# Start dev server
npm run dev
```

---

## Success Criteria

- [ ] All 16+ console statements replaced with structured logger
- [ ] All storage functions return Result<T, Error> types
- [ ] All routes handle Result types properly
- [ ] Zero TypeScript errors
- [ ] All 262+ tests pass
- [ ] New tests for error handling
- [ ] Logs include request context (requestId, userId, path)
- [ ] Errors include structured context for debugging
