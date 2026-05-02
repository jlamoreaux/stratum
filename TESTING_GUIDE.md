# Testing Guide for UI Auth & Routing Fixes

## Automated Tests

Run all tests:
```bash
npm test -- --run
```

Run specific test file:
```bash
npm test -- --run tests/ui.test.ts
npm test -- --run tests/routes.test.ts
npm test -- --run tests/auth.test.ts
```

## Manual Testing

### 1. Start Local Development Server

```bash
npm run dev
```

Or with wrangler:
```bash
npx wrangler dev
```

### 2. Test Security - Private Project Access

Create a private project as User A:
```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Authorization: Bearer YOUR_USER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "private-test", "visibility": "private"}'
```

Try to access it without auth (should get 403):
```bash
curl http://localhost:8787/p/private-test
```

Try with different user (should get 403):
```bash
curl http://localhost:8787/p/private-test \
  -H "Authorization: Bearer DIFFERENT_USER_TOKEN"
```

### 3. Test Public Project Access

Create a public project:
```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "public-test", "visibility": "public"}'
```

Access without auth (should work):
```bash
curl http://localhost:8787/p/public-test
```

### 4. Test New URL Structure

Old URLs should redirect (301) to new URLs:
```bash
# Test redirect
curl -I http://localhost:8787/ui/projects/test-project
# Should show: HTTP/1.1 301 Moved Permanently
# Location: /p/test-project
```

New URLs should work directly:
```bash
curl http://localhost:8787/p/test-project
curl http://localhost:8787/p/test-project/changes
curl http://localhost:8787/p/test-project/workspaces
curl http://localhost:8787/changes/CHANGE_ID
```

### 5. Test Auth Status in UI

**Unauthenticated:**
1. Open browser to `http://localhost:8787/`
2. Verify navbar shows: "sign in" link
3. Click "sign in" - should go to `/auth/email`

**Authenticated:**
1. Sign in via email magic link or GitHub OAuth
2. Verify navbar shows: your email + "logout" link
3. Click "logout" - should clear session and redirect to `/`

### 6. Test Project Creation UI

**Authenticated:**
1. Go to `http://localhost:8787/`
2. Click "New Project" button
3. Fill in form:
   - Project name: `my-test-project`
   - Visibility: Public or Private
   - Check "Seed with sample files"
4. Submit form
5. Should redirect to new project at `/p/my-test-project`

**Unauthenticated:**
1. Go to `http://localhost:8787/new` directly
2. Should redirect to `/auth/email` (login required)

### 7. Test Visibility Badges

Create both public and private projects, then:
1. Go to dashboard `/`
2. Verify public projects show "public" badge
3. Verify private projects don't show badge

### 8. Test README Rendering

Create project with README:
```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "readme-test",
    "visibility": "public",
    "files": {
      "README.md": "# Hello World\n\nThis is a test readme."
    }
  }'
```

Visit in browser:
```
http://localhost:8787/p/readme-test
```

Should see README content displayed at top of page.

### 9. Test Dashboard Filtering

**Authenticated:**
1. Create multiple projects (some public, some private)
2. Sign in as different users
3. Verify dashboard only shows:
   - Your own projects
   - Public projects from other users

**Unauthenticated:**
1. Visit `/` without logging in
2. Should only see public projects

### 10. Test GitHub Import

Via UI:
1. Go to `/new`
2. Fill in "Import from GitHub" section
3. Enter GitHub URL (e.g., `https://github.com/owner/repo`)
4. Set visibility
5. Submit - should import and redirect to project

Via API:
```bash
curl -X POST http://localhost:8787/api/projects/my-import/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/facebook/react",
    "visibility": "public"
  }'
```

## Browser Testing Checklist

### Visual Testing
- [ ] Dark theme renders correctly
- [ ] Project cards display properly
- [ ] File list is readable
- [ ] Commit log table displays correctly
- [ ] Forms are styled and usable
- [ ] Mobile responsive (basic)

### Functionality Testing
- [ ] All links work (no 404s)
- [ ] Back buttons work
- [ ] Forms submit correctly
- [ ] Error messages display properly
- [ ] Loading states work

### Cross-browser (if possible)
- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari

## Debugging Tips

### Check Logs
```bash
# In dev mode, watch console output
npm run dev
```

### Inspect KV Storage
```bash
# List projects in KV
npx wrangler kv:key list --binding STATE --local
```

### Check D1 Database
```bash
# Query projects
npx wrangler d1 execute stratum --local --command="SELECT * FROM changes LIMIT 5"
```

### API Testing with curl
```bash
# Get your user token
curl http://localhost:8787/api/auth/me \
  -H "Cookie: stratum_session=YOUR_SESSION_ID"

# List projects
curl http://localhost:8787/api/projects \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Common Issues

**Issue:** "Project not found" error
**Fix:** Check that project exists in KV: `npx wrangler kv:key list --binding STATE --local | grep project:`

**Issue:** 403 Forbidden on private project
**Fix:** This is expected behavior! Verify you're sending correct auth token.

**Issue:** CSS not loading
**Fix:** Check `/ui.css` loads correctly: `curl http://localhost:8787/ui.css`

**Issue:** Redirect loop
**Fix:** Clear cookies and try again

## Performance Testing

Test with many projects:
```bash
# Create 20 test projects
for i in {1..20}; do
  curl -X POST http://localhost:8787/api/projects \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"perf-test-$i\", \"visibility\": \"public\"}"
done
```

Then load dashboard and verify it renders quickly.
