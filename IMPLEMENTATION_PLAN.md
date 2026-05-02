# UI Auth & Routing Fixes - Implementation Plan

**Branch:** `fix/ui-auth-and-routing`  
**Worktree:** `/Users/jlmx/projects/indy/stratum-audit-fixes`

---

## Overview

This branch addresses the critical security and UX issues identified in the audit:
1. **Security:** UI routes don't check permissions (private projects exposed)
2. **UX:** /ui prefix is unnecessary and URLs should be GitHub-style
3. **Auth:** Layout doesn't show login status or user info

---

## Task 1: Fix UI Route Authorization (CRITICAL)

**Problem:** UI routes in `src/routes/ui.tsx` don't call `canReadProject()` - they serve any project to anyone.

**Solution:** Add permission checks to all project-scoped routes.

### Files to Modify:
- `src/routes/ui.tsx` - Add `canReadProject` checks
- `src/utils/authz.ts` - Already exists, verify it handles undefined userId correctly

### Implementation:

```typescript
// In each route handler that accesses a project:
const userId = c.get("userId");
const agentOwnerId = c.get("agentOwnerId");
const project = await getProject(c.env.STATE, name);

if (!project) return c.html(<NotFoundPage />, 404);
if (!canReadProject(project, userId, agentOwnerId)) {
  return c.html(<ForbiddenPage />, 403);
}
```

### Routes to Fix:
1. `GET /ui/projects/:name` - Repo view
2. `GET /ui/projects/:name/files/:path` - File viewer
3. `GET /ui/projects/:name/changes` - Changes list
4. `GET /ui/projects/:name/workspaces` - Workspaces list

---

## Task 2: Add Auth Status to Layout

**Problem:** Users can't see if they're logged in or access logout.

**Solution:** Update `src/ui/layout.tsx` to accept user info and show auth UI.

### Files to Modify:
- `src/ui/layout.tsx` - Add user prop, show login/logout
- `src/routes/ui.tsx` - Pass user info to all pages
- `src/ui/pages/*.tsx` - Accept and pass through user prop

### Implementation:

Update Layout interface:
```typescript
interface LayoutProps {
  title: string;
  user?: { id: string; email: string } | null;
  children?: unknown;
}
```

Update nav to show auth status:
```typescript
<nav class="nav">
  <a class="nav-brand" href="/">stratum</a>
  <div class="nav-links">
    <a href="/ui/projects">projects</a>
  </div>
  <div class="nav-auth">
    {user ? (
      <>
        <span>{user.email}</span>
        <a href="/auth/logout">logout</a>
      </>
    ) : (
      <a href="/auth/email">sign in</a>
    )}
  </div>
</nav>
```

---

## Task 3: Remove /ui Prefix, Implement GitHub-Style URLs

**Problem:** URLs are `/ui/projects/:name` instead of `/:owner/:repo`.

**Solution:** 
1. Move UI routes to root
2. Change project URL pattern to include owner
3. Update all internal links

### Files to Modify:
- `src/index.ts` - Mount uiRouter at `/` instead of `/ui`
- `src/routes/ui.tsx` - Update all route paths
- `src/ui/layout.tsx` - Update nav links
- `src/ui/pages/*.tsx` - Update all hrefs

### URL Mapping:

| Current | New |
|---------|-----|
| `/` | `/` (dashboard when authed, landing when not) |
| `/ui/` | `/` (dashboard) |
| `/ui/projects` | `/` (dashboard) |
| `/ui/projects/:name` | `/:owner/:repo` |
| `/ui/projects/:name/files/:path` | `/:owner/:repo/blob/:path` |
| `/ui/projects/:name/changes` | `/:owner/:repo/changes` |
| `/ui/projects/:name/workspaces` | `/:owner/:repo/workspaces` |
| `/ui/changes/:id` | `/changes/:id` |

### Challenge: Owner Resolution

Currently projects only have `ownerId` (user ID), not an owner slug. Options:

**Option A: Flat URLs** (Quick fix)
- Use `/:project` instead of `/:owner/:repo`
- Simpler, but not GitHub-style

**Option B: Lookup by owner** (Better long-term)
- Need to fetch user by ID to get their slug/email for URL
- Or add `ownerSlug` field to ProjectEntry

**Decision:** Start with Option A (flat URLs) to avoid data migration, can migrate to Option B later.

New flat URLs:
| Current | New |
|---------|-----|
| `/ui/projects/:name` | `/p/:name` |
| `/ui/projects/:name/files/:path` | `/p/:name/blob/:path` |
| `/ui/projects/:name/changes` | `/p/:name/changes` |
| `/ui/projects/:name/workspaces` | `/p/:name/workspaces` |
| `/ui/changes/:id` | `/changes/:id` |

---

## Task 4: Add Project Visibility Controls

**Problem:** Projects default to undefined visibility, no way to set public/private.

**Solution:** 
1. Update project creation to accept visibility parameter
2. Default to private
3. Show visibility badge in UI

### Files to Modify:
- `src/routes/projects.ts` - Accept visibility in POST /
- `src/types.ts` - Ensure ProjectEntry.visibility is typed
- `src/ui/pages/repo.tsx` - Show visibility badge
- `src/ui/pages/home.tsx` - Show visibility indicators

### API Change:
```typescript
// POST /api/projects
{
  "name": "my-project",
  "visibility": "public" | "private" // new optional field, default "private"
}
```

---

## Task 5: Public Project Discovery

**Problem:** Anonymous users can't browse public projects.

**Solution:** 
1. Update dashboard to show public projects when unauthenticated
2. Show different empty state for unauthenticated users

### Files to Modify:
- `src/routes/ui.tsx` - Filter projects by readability for dashboard
- `src/ui/pages/home.tsx` - Add CTA to sign in or create account

---

## Task 6: Link Organizations to Projects (Future)

**Problem:** Orgs exist in DB but projects can't be owned by orgs.

**Note:** This requires data model changes and is medium priority. Can be done in separate PR.

### Required Changes:
- Migration: Add `org_id` to projects table or ProjectEntry
- Update authz.ts: Check org membership for access
- Update UI: Show org in project URLs

---

## Task 7: Add README Rendering

**Problem:** Repo page shows file tree but not README content.

**Solution:** Fetch and render README.md on repo page.

### Files to Modify:
- `src/routes/ui.tsx` - Fetch README content in repo route
- `src/ui/pages/repo.tsx` - Add README section
- `src/ui/styles.ts` - Add README styling

---

## Task 8: Create Project Creation UI

**Problem:** Users can only create projects via API.

**Solution:** Add "New Project" button and form.

### Files to Modify:
- `src/ui/pages/home.tsx` - Add "New Project" button
- `src/routes/ui.tsx` - Add GET /new route for form
- Create `src/ui/pages/new-project.tsx` - Project creation form

---

## Implementation Order

1. **Task 1 (Security)** - Must be first, critical security fix
2. **Task 2 (Auth UI)** - Improves UX significantly
3. **Task 4 (Visibility)** - Works with Task 1
4. **Task 3 (URLs)** - Breaking change, do after security
5. **Task 5 (Public discovery)** - Depends on Task 1 & 4
6. **Task 7 (README)** - Nice to have
7. **Task 8 (Create UI)** - Nice to have
8. **Task 6 (Orgs)** - Separate PR

---

## Testing Checklist

- [ ] Private project returns 403 when accessed by non-owner
- [ ] Public project readable by anyone
- [ ] Login link shows when unauthenticated
- [ ] User email and logout show when authenticated
- [ ] All old /ui URLs redirect to new URLs
- [ ] Creating project with visibility=public works
- [ ] Creating project defaults to private
- [ ] Unauthenticated users see public projects on dashboard
- [ ] README renders on repo page
- [ ] Project creation form works
