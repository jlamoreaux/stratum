export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

/* ============================================================================
   Design tokens
   The single source of truth for color. Four text steps, darkest to brightest:
   faint (decorative only — never for information), muted, body, primary.
   Every informational step clears WCAG AA (4.5:1) on every surface token;
   --text-faint deliberately does not, so it must only style ornaments
   (separators, chrome) whose meaning is carried elsewhere.
   The standalone auth pages reference these same custom properties, so renames
   here must be mirrored in src/routes/{login,signup,email-auth}.tsx.
   ========================================================================== */
:root {
  /* Surfaces */
  --bg-page: #0a0a0a;
  --bg-panel: #0d0d0d;   /* nav bar, inset code panes */
  --bg-card: #111111;
  --bg-raised: #1a1a1a;  /* badges, inline code, hover fills */

  /* Borders */
  --border: #1e1e1e;
  --divider: #222222;
  --border-strong: #333333;
  --border-hover: #444444;

  /* Text */
  --text-primary: #f0f0f0;
  --text-body: #cccccc;
  --text-muted: #9aa4ad;  /* 7.3:1 on --bg-card */
  --text-faint: #6e7681;  /* decorative only */

  /* Accent (blue) — "-text" variants are foregrounds, the rest are surfaces */
  --accent: #1a3a6e;
  --accent-hover: #1f4a8e;
  --accent-border: #2a5aae;
  --accent-text: #7ca9f7;
  --accent-text-hover: #a8c8f8;

  /* Status foregrounds */
  --success-text: #4ade80;
  --error-text: #f87171;
  --error-text-soft: #fca5a5;
  --warning-text: #f7c97c;
  --merged-text: #c084fc;

  /* Status fills */
  --success-bg: rgba(74, 222, 128, 0.1);
  --success-border: rgba(74, 222, 128, 0.3);
  --error-bg: rgba(248, 113, 113, 0.1);
  --error-border: rgba(248, 113, 113, 0.3);
  --danger-surface: #3d1a1a;
  --danger-border: #6e2a2a;

  /* Aliases the auth pages already reference */
  --bg-primary: var(--bg-page);
  --bg-secondary: var(--bg-card);
  --bg-tertiary: var(--bg-raised);
  --text-secondary: var(--text-muted);
  --text-tertiary: var(--text-muted);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg-page);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  line-height: 1.6;
}

a { color: var(--accent-text); text-decoration: none; }
a:hover { text-decoration: underline; }

.nav {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

@media (max-width: 600px) {
  .nav { padding: 0.6rem 1rem; }
}

.nav-brand {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.05em;
  margin-right: auto;
}
.nav-brand:hover { text-decoration: none; color: var(--accent-text); }

.nav-auth {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.nav-user {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.nav-auth-link {
  color: var(--accent-text);
  font-size: 0.9rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  transition: background 0.15s;
}

.nav-auth-link:hover {
  background: var(--accent);
  text-decoration: none;
}

.main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  margin-bottom: 1.5rem;
}

.page-header h1 { font-size: 1.4rem; font-weight: 700; overflow-wrap: anywhere; }

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: var(--text-body); }

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}

.card-link {
  display: block;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s;
}
.card-link:hover { border-color: var(--border-hover); text-decoration: none; }
.card-title { font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem; }
.card-meta { font-size: 0.8rem; color: var(--text-muted); }

.table-scroll { overflow-x: auto; }

.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 500; font-size: 0.85rem; }
.table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--bg-card); vertical-align: middle; }
.table tr:last-child td { border-bottom: none; }
.table a { color: var(--accent-text); }

.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-raised);
  color: var(--text-muted);
}
.badge-open     { background: #1a3a6e; color: #7ca9f7; }
.badge-approved { background: #1a3d2b; color: #4ade80; }
.badge-merged   { background: #2d1a5e; color: #c084fc; }
.badge-rejected { background: #3d1a1a; color: #f87171; }
.badge-public   { background: #1a3a1e; color: #4ade80; margin-left: 0.5rem; font-size: 0.75rem; }

/* Status badges (sync + import cards) */
.badge-info     { background: #1a3a6e; color: #7ca9f7; }
.badge-success  { background: #1a3e1a; color: #4ade80; }
.badge-warning  { background: #3e3a1a; color: #f7c97c; }
.badge-error    { background: #3d1a1a; color: #f87171; }
.badge-resolved { background: #1a3e1a; color: #4ade80; }
.badge-conflict { background: #3e3a1a; color: #f7c97c; }

/* README styling */
.readme-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
}

.readme-content pre {
  margin: 0;
  padding: 1rem;
  background: transparent;
  color: var(--text-body);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.btn {
  display: inline-block;
  padding: 0.4rem 0.85rem;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-raised);
  color: var(--text-body);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}
.btn:hover { background: #222; color: var(--text-primary); text-decoration: none; }
.btn-primary { background: var(--accent); border-color: var(--accent-border); color: var(--accent-text); }
.btn-primary:hover { background: var(--accent-hover); color: var(--accent-text-hover); }
.btn-danger  { background: var(--danger-surface); border-color: var(--danger-border); color: var(--error-text); }
.btn-danger:hover  { background: #4d2020; color: var(--error-text-soft); }

.empty-state { padding: 2rem 0; color: var(--text-muted); text-align: center; }
.empty-state-hint { margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-muted); }

.file-list { list-style: none; }
.file-item { padding: 0.3rem 0; border-bottom: 1px solid #161616; font-size: 0.85rem; color: var(--text-body); }
.file-item:last-child { border-bottom: none; }

.detail-list { display: grid; grid-template-columns: 140px 1fr; gap: 0.4rem 1rem; }
.detail-list dt { color: var(--text-muted); font-size: 0.85rem; }
.detail-list dd { color: var(--text-body); }

.action-row { display: flex; gap: 0.75rem; margin-top: 1rem; }

.issue-list { margin-top: 0.35rem; padding-left: 1rem; color: var(--error-text-soft); }

.mono { font-family: 'JetBrains Mono', monospace; }
.text-muted { color: var(--text-muted); }

/* Import Progress Styles */
.import-progress-card {
  border-left: 4px solid var(--accent-text);
}

.import-progress-card[data-import-status="completed"] {
  border-left-color: var(--success-text);
}

.import-progress-card[data-import-status="failed"] {
  border-left-color: var(--error-text);
}

.import-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.import-header h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.1rem;
}

.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.spinner-small {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  vertical-align: -1px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.icon-success { color: var(--success-text); }
.icon-error { color: var(--error-text); }
.icon-cancelled { color: var(--text-muted); }
.icon-conflict { margin-right: 0.35rem; }

.badge-queued { background: var(--bg-raised); color: var(--text-muted); }
.badge-cloning { background: #1a3a6e; color: #7ca9f7; }
.badge-processing { background: #3e3a1a; color: #f7c97c; }
.badge-completed { background: #1a3e1a; color: #4ade80; }
.badge-failed { background: #3d1a1a; color: #f87171; }
.badge-cancelled { background: #2a2a2a; color: #9aa4ad; }

.import-source {
  margin-bottom: 1rem;
  padding: 0.75rem;
  background: var(--bg-card);
  border-radius: 6px;
  font-size: 0.85rem;
}

.import-source p {
  margin: 0.25rem 0;
  color: var(--text-muted);
}

.progress-section {
  margin: 1rem 0;
}

.progress-bar {
  height: 8px;
  background: var(--bg-raised);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #7ca9f7, #a8c8f8);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.current-file {
  color: var(--text-muted);
  margin-left: 0.5rem;
}

.errors-section {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #1a0a0a;
  border: 1px solid var(--danger-surface);
  border-radius: 6px;
}

.errors-section h3 {
  color: var(--error-text);
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}

.error-list {
  list-style: none;
  font-size: 0.8rem;
}

.error-item {
  padding: 0.25rem 0;
  color: var(--error-text-soft);
  border-bottom: 1px solid #2d1a1a;
}

.error-item:last-child {
  border-bottom: none;
}

.more-errors {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.5rem;
}

.logs-section {
  margin-top: 1rem;
}

.logs-section details {
  font-size: 0.85rem;
}

.logs-section summary {
  cursor: pointer;
  color: var(--text-muted);
  padding: 0.5rem 0;
}

.log-list {
  list-style: none;
  padding: 0.5rem;
  background: var(--bg-card);
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.log-item {
  display: flex;
  gap: 0.5rem;
  padding: 0.2rem 0;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--bg-raised);
}

.log-item:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--text-muted);
  flex-shrink: 0;
}

.log-info .log-message { color: var(--text-muted); }
.log-warn .log-message { color: var(--warning-text); }
.log-error .log-message { color: var(--error-text); }

.actions-section {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.btn-secondary { background: var(--border); border-color: var(--border-strong); color: var(--text-body); }
.btn-secondary:hover { background: #2a2a2a; color: var(--text-primary); }

.error-alert {
  margin: 1rem 0;
  padding: 1rem;
  background: #1a0a0a;
  border: 1px solid #5d2a2a;
  border-radius: 6px;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.error-header h3 {
  font-size: 0.95rem;
  color: var(--error-text);
  margin: 0;
}

.error-icon { font-size: 1rem; }

.error-description {
  font-size: 0.85rem;
  color: var(--error-text-soft);
  margin: 0 0 0.75rem;
}

.troubleshooting-section { margin-top: 0.75rem; }

.troubleshooting-section h4 {
  font-size: 0.85rem;
  color: var(--warning-text);
  margin: 0 0 0.4rem;
}

.troubleshooting-tips {
  padding-left: 1.25rem;
  margin: 0;
}

.troubleshooting-tips li {
  font-size: 0.82rem;
  color: var(--text-body);
  padding: 0.15rem 0;
}

.error-action { margin-top: 0.75rem; }

.failed-actions { display: flex; gap: 0.5rem; }

.retry-form { display: inline; }

.technical-errors summary { color: var(--text-muted); cursor: pointer; padding: 0.5rem 0; font-size: 0.85rem; }

/* File Tree */
.file-tree { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
.file-tree-dir { border: none; }
.file-tree-dir > summary {
  cursor: pointer;
  list-style: none;
  padding: 0.25rem 0;
  color: var(--text-body);
  user-select: none;
}
.file-tree-dir > summary::before { content: "▶  "; font-size: 0.7rem; }
.file-tree-dir[open] > summary::before { content: "▼  "; font-size: 0.7rem; }
.file-tree-dir > summary::-webkit-details-marker { display: none; }
.file-tree-dir > summary::marker { content: ""; }
.file-tree-children { padding-left: 1.25rem; }
.file-tree-file { padding: 0.2rem 0; }
.file-tree-file a { color: var(--text-body); text-decoration: none; display: block; }
.file-tree-file a:hover { color: var(--text-primary); text-decoration: underline; }
.file-tree-notice { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.75rem; font-style: italic; }
.file-tree-controls { margin-bottom: 0.5rem; }
.file-tree-toggle-btn { background: none; border: none; color: var(--text-muted); font-size: 0.75rem; cursor: pointer; padding: 0; font-family: inherit; }
.file-tree-toggle-btn:hover { color: var(--text-body); }

/* Activity Feed */
.activity-list { list-style: none; padding: 0; margin: 0; }
.activity-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--divider);
  font-size: 0.9rem;
}
.activity-actor {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.activity-actor-user { background: #1e3a5f; color: #7ca9f7; }
.activity-actor-agent { background: #3b2a5f; color: #c4a7ff; }
.activity-actor-system { background: #2a2a2a; color: #9aa4ad; }
.activity-description { flex: 1; color: var(--text-body); }
.activity-description a { color: var(--accent-text); text-decoration: none; }
.activity-description a:hover { text-decoration: underline; }
.activity-time { color: var(--text-muted); font-size: 0.8rem; flex-shrink: 0; }

/* Webhooks */
.webhook-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 480px; }
.webhook-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--text-body); }
.webhook-form input {
  background: var(--bg-card); border: 1px solid var(--border-strong); color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}
.webhook-help { font-size: 0.8rem; color: var(--text-muted); }
.webhook-card { margin-top: 1rem; }
.webhook-card-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.webhook-url { font-size: 0.85rem; color: var(--accent-text); margin-right: 0.5rem; word-break: break-all; }
.webhook-actions { display: flex; gap: 0.5rem; }
.webhook-meta { font-size: 0.8rem; color: var(--text-muted); margin: 0.5rem 0 0; word-break: break-all; }
.webhook-deliveries { margin-top: 0.75rem; font-size: 0.85rem; }
.webhook-deliveries summary { cursor: pointer; color: var(--text-muted); }
.webhook-deliveries ul { list-style: none; padding: 0.5rem 0 0; margin: 0; }
.webhook-delivery { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.25rem 0; flex-wrap: wrap; }
.webhook-delivery-type { font-family: 'JetBrains Mono', monospace; color: var(--text-body); }
.webhook-delivery-meta { color: var(--text-muted); }
.webhook-delivery-time { color: var(--text-muted); margin-left: auto; }
.btn-small, .btn-sm { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
.btn-link { background: none; border-color: transparent; color: var(--accent-text); }

/* Issues */
.page-header-actions { display: flex; gap: 0.5rem; }
.issues-filter { display: flex; gap: 1rem; margin-bottom: 1rem; font-size: 0.9rem; }
.issues-filter a { color: var(--text-muted); text-decoration: none; }
.issues-filter a:hover { color: var(--text-body); }
.issues-filter-active { color: var(--text-primary) !important; font-weight: 600; }
.issues-list { list-style: none; padding: 0; margin: 0; }
.issues-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--divider);
  font-size: 0.9rem;
  flex-wrap: wrap;
}
.issues-title { color: #e8e8e8; text-decoration: none; flex: 1; min-width: 200px; }
.issues-title:hover { color: var(--accent-text); }
.issues-linked-change { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: #c4a7ff; }
.issues-meta { color: var(--text-muted); font-size: 0.8rem; }
.issue-status-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.issue-body { margin-top: 1rem; }
.issue-body-text { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0; }
.issue-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 560px; }
.issue-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--text-body); }
.issue-form input, .issue-form textarea {
  background: var(--bg-card); border: 1px solid var(--border-strong); color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}

/* Syntax highlighting (server-side lexer) */
.tok-comment { color: #6a737d; font-style: italic; }
.tok-string { color: #9ecbff; }
.tok-number { color: #f8c555; }
.tok-keyword { color: #f97583; }

/* Diff viewer */
.diff-view { display: flex; flex-direction: column; gap: 0.75rem; }
.diff-empty { color: var(--text-muted); font-size: 0.85rem; }
.diff-file { border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
.diff-file-header {
  display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
  padding: 0.5rem 0.75rem; background: #181818; cursor: pointer;
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
}
.diff-file-path { color: #e8e8e8; word-break: break-all; }
.diff-file-stats { flex-shrink: 0; }
.diff-stat-add { color: var(--success-text); }
.diff-stat-del { color: var(--error-text); }
.diff-file-body {
  margin: 0; padding: 0.5rem 0; overflow-x: auto;
  font-size: 0.8rem; line-height: 1.5; background: var(--bg-panel);
}
.diff-line { display: block; padding: 0 0.75rem; white-space: pre; }
.diff-add { background: rgba(74, 222, 128, 0.12); color: #b9f0cd; }
.diff-del { background: rgba(248, 113, 113, 0.12); color: #f5c2c2; }
.diff-hunk { color: var(--accent-text); background: #14181f; }
.diff-meta { color: var(--text-muted); font-style: italic; }

/* Present for assistive tech, removed from the visual layout. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; border: 0; clip-path: inset(50%); overflow: hidden;
  white-space: nowrap;
}

/* Unified/split toggle: hidden checkbox + sibling selectors, no client JS.
   The instant client-side switch (vs. GitHub's full reload) is deliberate. */
.diff-split-toggle { position: absolute; opacity: 0; pointer-events: none; }
.diff-split-label {
  align-self: flex-end; cursor: pointer; user-select: none;
  font-size: 0.8rem; color: var(--accent-text); border: 1px solid #2a2a2a;
  border-radius: 6px; padding: 0.25rem 0.6rem; background: #181818;
}
.diff-split-label:hover { border-color: var(--accent-text); }
.diff-split-toggle:focus-visible ~ .diff-split-label { outline: 2px solid var(--accent-text); outline-offset: 2px; }
.diff-label-split { display: none; }
.diff-split-toggle:checked ~ .diff-split-label .diff-label-unified { display: none; }
.diff-split-toggle:checked ~ .diff-split-label .diff-label-split { display: inline; }

/* Split view: hidden until the toggle is checked, then replaces unified. */
.diff-split { display: none; }
.diff-split-toggle:checked ~ .diff-file .diff-file-body { display: none; }
.diff-split-toggle:checked ~ .diff-file .diff-split {
  display: table; width: 100%; table-layout: fixed; border-collapse: collapse;
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; line-height: 1.5;
  background: var(--bg-panel);
}
.diff-cell {
  width: 50%; padding: 0 0.75rem; white-space: pre-wrap; word-break: break-all;
  vertical-align: top; border-left: 1px solid #1c1c1c;
}
.diff-cell:first-child { border-left: none; }

/* Settings */
.settings-help { font-size: 0.85rem; color: var(--text-muted); }
.settings-token-reveal { border: 1px solid #2d4f2d; background: #101a10; }
.settings-token {
  display: block; padding: 0.6rem 0.75rem; background: var(--bg-panel);
  border: 1px solid var(--border-strong); border-radius: 4px; word-break: break-all;
  font-size: 0.85rem; color: #9ecbff;
}
.settings-agent-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 420px; margin-top: 1rem; }
.settings-agent-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--text-body); }
.settings-agent-form input {
  background: var(--bg-card); border: 1px solid var(--border-strong); color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}

/* Danger zone (project + account deletion) */
.danger-zone { border-color: var(--danger-border); }
.danger-zone h3 { color: var(--error-text); }
.danger-zone p { color: var(--text-body); }
.danger-zone form { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
.danger-zone input[type="text"] {
  background: var(--bg-page); border: 1px solid var(--border-strong); color: var(--text-primary);
  padding: 0.4rem 0.6rem; border-radius: 4px; font-family: inherit; font-size: 0.85rem;
  min-width: 220px;
}
.danger-zone input[type="text"]:focus {
  outline: none; border-color: var(--danger-border);
  box-shadow: 0 0 0 3px var(--error-bg);
}

/* Sync status (repo page banner + sync page) */
.sync-status-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 0.5rem 1rem; flex-wrap: wrap; margin-bottom: 0.75rem;
}
.sync-status-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.sync-provider { color: var(--text-body); font-weight: 600; font-size: 0.9rem; }
.sync-source-link { font-size: 0.8rem; color: var(--accent-text); word-break: break-all; }
.sync-status-badge { flex-shrink: 0; display: flex; gap: 0.5rem; }
.sync-status-details { display: flex; gap: 0.35rem 1.5rem; flex-wrap: wrap; font-size: 0.85rem; }
.sync-detail { display: flex; gap: 0.4rem; align-items: baseline; }
.sync-label { color: var(--text-muted); }
.sync-value { color: var(--text-body); }
.sync-commit { color: var(--accent-text); font-size: 0.8rem; }
.sync-error { border-color: var(--danger-border); }
.sync-error-message {
  margin-top: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 4px;
  background: #1a0a0a; border: 1px solid var(--danger-surface);
  color: var(--error-text-soft); font-size: 0.85rem;
}

/* Sync page */
.status-header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.status-indicator { font-size: 1.1rem; flex-shrink: 0; }
.status-info { flex: 1; min-width: 200px; }
.status-info h2 { margin-bottom: 0.15rem; }
.status-meta { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
.status-actions { flex-shrink: 0; }
.icon-idle { color: var(--text-muted); }
.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem 1.5rem; }
.info-item label {
  display: block; color: var(--text-muted); font-size: 0.75rem;
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.2rem;
}
.info-item a, .info-item span, .info-item code { font-size: 0.85rem; word-break: break-all; }
.error-hint { color: var(--error-text-soft); font-size: 0.8rem; text-decoration: underline dotted; cursor: help; }
.form-group { margin-bottom: 1rem; }
.form-group > label { display: block; color: var(--text-body); font-size: 0.85rem; margin-bottom: 0.25rem; }
.form-group select {
  background: var(--bg-card); border: 1px solid var(--border-strong); color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit; font-size: 0.85rem;
}
.form-group select:disabled { color: var(--text-muted); }
.checkbox-label, .form-group > label.checkbox-label {
  display: flex; align-items: center; gap: 0.5rem; color: var(--text-body); cursor: pointer; margin-bottom: 0;
}
.help-text { color: var(--text-muted); font-size: 0.8rem; margin-top: 0.25rem; }
.error-message {
  margin-top: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 4px;
  background: #1a0a0a; border: 1px solid var(--danger-surface); color: var(--error-text-soft); font-size: 0.85rem;
}
.btn-success { background: #1a3d2b; border-color: #2a6e4a; color: #4ade80; }
.btn-info { background: var(--accent); border-color: var(--accent-border); color: var(--accent-text); }

/* Conflict resolution */
.conflict-header {
  display: flex; justify-content: space-between; align-items: center;
  gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem;
}
.conflict-info { font-size: 0.85rem; color: var(--text-body); margin-bottom: 1rem; }
.conflict-info p { margin: 0.2rem 0; }
.conflicts-list { display: flex; flex-direction: column; gap: 1rem; }
.conflict-file { border: 1px solid #2a2a2a; border-radius: 6px; padding: 0.75rem; }
.conflict-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
.file-header {
  display: flex; justify-content: space-between; align-items: center;
  gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem;
}
.file-path { color: #e8e8e8; font-size: 0.85rem; word-break: break-all; }
.file-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.diff-viewer { display: grid; gap: 0.75rem; }
.diff-section { border: 1px solid var(--divider); border-radius: 4px; overflow: hidden; }
.diff-header {
  display: flex; gap: 0.75rem; align-items: baseline; flex-wrap: wrap;
  padding: 0.4rem 0.6rem; background: #181818; font-size: 0.8rem;
}
.diff-label { color: var(--text-body); font-weight: 600; }
.diff-commit { color: var(--accent-text); }
.diff-time { color: var(--text-muted); margin-left: auto; }
.diff-content {
  margin: 0; padding: 0.6rem 0.75rem; overflow-x: auto; max-height: 240px;
  font-size: 0.8rem; line-height: 1.5; background: var(--bg-panel); color: #d4d4d4;
}
.manual-edit { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
.manual-edit label { font-size: 0.85rem; color: var(--text-body); }
.manual-editor {
  background: var(--bg-panel); border: 1px solid var(--border-strong); color: #d4d4d4;
  padding: 0.6rem; border-radius: 4px; font-family: inherit; font-size: 0.8rem;
  width: 100%;
}

/* Costs */
.cost-list { list-style: none; padding: 0; margin: 0; font-size: 0.9rem; color: var(--text-body); }
.cost-list li { padding: 0.2rem 0; }

/* Change reviews and comments */
.review-empty { color: var(--text-muted); font-size: 0.85rem; }
.review-list, .comment-list { list-style: none; padding: 0; margin: 0; }
.review-item {
  display: flex; align-items: baseline; gap: 0.75rem;
  padding: 0.4rem 0; border-bottom: 1px solid var(--divider); font-size: 0.85rem; flex-wrap: wrap;
}
.review-reviewer { color: var(--text-body); font-size: 0.8rem; }
.review-comment { color: var(--text-body); flex: 1; }
.review-time { color: var(--text-muted); font-size: 0.75rem; margin-left: auto; }
.review-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.comment-item { padding: 0.6rem 0; border-bottom: 1px solid var(--divider); }
.comment-meta { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.8rem; color: var(--text-muted); }
.comment-body {
  white-space: pre-wrap; word-break: break-word; font-family: inherit;
  margin: 0.35rem 0 0; color: #ddd; font-size: 0.9rem;
}
.comment-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.75rem; max-width: 560px; }
.comment-form textarea {
  background: var(--bg-card); border: 1px solid var(--border-strong); color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}
.comment-form button { align-self: flex-start; }

/* File Viewer */
.file-viewer-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  margin-bottom: 0;
  color: var(--text-muted);
}
.file-viewer-breadcrumb a { color: var(--accent-text); text-decoration: none; }
.file-viewer-breadcrumb a:hover { text-decoration: underline; }
.file-viewer-breadcrumb .sep { color: var(--text-faint); }
.file-viewer-breadcrumb-current { color: var(--text-primary); }
.file-viewer-content { padding: 0; overflow: hidden; }
.file-viewer-content pre {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  white-space: pre;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: #d4d4d4;
  line-height: 1.6;
  background: var(--bg-panel);
}
.file-viewer-message { padding: 1.5rem; color: var(--text-muted); font-style: italic; font-size: 0.85rem; margin: 0; }

/* Repo page two-column layout */
.repo-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 1rem;
  align-items: start;
}

.repo-sidebar { position: sticky; top: 1rem; }
.repo-main { min-width: 0; }

@media (max-width: 700px) {
  .repo-layout { grid-template-columns: 1fr; }
  .repo-sidebar { position: static; }
}

/* README rendered markdown */
.readme-card h2 { margin-bottom: 1rem; }

.readme-content { font-size: 0.875rem; line-height: 1.7; color: var(--text-body); }
.readme-content h1 { font-size: 1.3rem; color: var(--text-primary); margin: 1.25rem 0 0.5rem; border-bottom: 1px solid var(--divider); padding-bottom: 0.3rem; }
.readme-content h2 { font-size: 1.1rem; color: #e0e0e0; margin: 1.1rem 0 0.4rem; border-bottom: 1px solid var(--bg-raised); padding-bottom: 0.25rem; }
.readme-content h3 { font-size: 0.95rem; color: #d0d0d0; margin: 0.9rem 0 0.3rem; }
.readme-content h4, .readme-content h5, .readme-content h6 { color: #bbb; margin: 0.75rem 0 0.25rem; }
.readme-content p { margin: 0.5rem 0; }
.readme-content a { color: var(--accent-text); }
.readme-content a:hover { text-decoration: underline; }
.readme-content code { font-family: 'JetBrains Mono', monospace; font-size: 0.8em; background: var(--bg-raised); padding: 0.1em 0.35em; border-radius: 3px; color: #e0e0e0; }
.readme-content pre { background: var(--bg-panel); border: 1px solid var(--divider); border-radius: 6px; padding: 1rem; overflow-x: auto; margin: 0.75rem 0; }
.readme-content pre code { background: none; padding: 0; font-size: 0.8rem; color: #d4d4d4; }
.readme-content blockquote { border-left: 3px solid var(--border-strong); margin: 0.75rem 0; padding: 0.25rem 0 0.25rem 1rem; color: var(--text-muted); }
.readme-content ul, .readme-content ol { padding-left: 1.5rem; margin: 0.5rem 0; }
.readme-content li { margin: 0.2rem 0; }
.readme-content table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.75rem 0; }
.readme-content th { background: var(--bg-raised); color: var(--text-body); font-weight: 600; text-align: left; padding: 0.4rem 0.6rem; border: 1px solid #2a2a2a; }
.readme-content td { padding: 0.35rem 0.6rem; border: 1px solid var(--border); color: #bbb; }
.readme-content tr:nth-child(even) td { background: var(--bg-panel); }
.readme-content img { max-width: 100%; border-radius: 4px; }
.readme-content hr { border: none; border-top: 1px solid var(--divider); margin: 1rem 0; }
.readme-content details { margin: 0.5rem 0; }
.readme-content summary { cursor: pointer; color: var(--text-muted); }

/* Project header: identity crumb + tab navigation */
.project-header { margin-bottom: 1.5rem; }
.project-header-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem 1rem; flex-wrap: wrap; margin-bottom: 0.75rem;
}
.project-crumb {
  display: flex; align-items: baseline; gap: 0.4rem;
  font-size: 1.25rem; overflow-wrap: anywhere;
}
.project-crumb-namespace { color: var(--text-muted); }
.project-crumb-sep { color: var(--text-faint); }
.project-crumb-name { font-weight: 700; color: var(--text-primary); }
.project-crumb-name:hover { color: var(--accent-text); text-decoration: none; }
.project-tabs {
  display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none;
}
.project-tabs::-webkit-scrollbar { display: none; }
.project-tab {
  padding: 0.45rem 0.85rem; color: var(--text-muted); font-size: 0.9rem;
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
}
.project-tab:hover { color: var(--text-body); text-decoration: none; }
.project-tab-active { color: var(--text-primary); border-bottom-color: var(--accent-text); }

/* Project settings */
.settings-links { display: flex; gap: 0.5rem; flex-wrap: wrap; }

/* Error pages (400/404/500) */
.error-page { max-width: 480px; margin: 4rem auto; text-align: center; }
.error-page-code {
  font-size: 3.5rem; font-weight: 700; color: var(--text-faint);
  letter-spacing: 0.1em; line-height: 1;
}
.error-page-title { font-size: 1.4rem; font-weight: 700; margin: 0.75rem 0 0.5rem; }
.error-page-hint { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem; overflow-wrap: anywhere; }
.error-page-actions { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }

/* Commit table */
.commit-table { table-layout: fixed; width: 100%; }
.commit-sha { width: 72px; font-size: 0.8rem; color: var(--accent-text); }
.commit-message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }
.commit-author { width: 160px; font-size: 0.82rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-date { width: 96px; font-size: 0.82rem; color: var(--text-muted); text-align: right; }
`;
