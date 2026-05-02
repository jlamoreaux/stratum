export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0a0a0a;
  color: #f0f0f0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  line-height: 1.6;
}

a { color: #7ca9f7; text-decoration: none; }
a:hover { text-decoration: underline; }

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid #1e1e1e;
  background: #0d0d0d;
}

.nav-brand {
  font-size: 1.1rem;
  font-weight: 700;
  color: #f0f0f0;
  letter-spacing: 0.05em;
}
.nav-brand:hover { text-decoration: none; color: #7ca9f7; }

.nav-links { display: flex; gap: 1.25rem; }
.nav-links a { color: #999; font-size: 0.9rem; }
.nav-links a:hover { color: #f0f0f0; text-decoration: none; }

.main {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.page-header h1 { font-size: 1.4rem; font-weight: 700; }

.card {
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #ccc; }

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
.card-link:hover { border-color: #444; text-decoration: none; }
.card-title { font-weight: 600; color: #f0f0f0; margin-bottom: 0.25rem; }
.card-meta { font-size: 0.8rem; color: #666; }

.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e1e1e; color: #888; font-weight: 500; font-size: 0.85rem; }
.table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #111; vertical-align: middle; }
.table tr:last-child td { border-bottom: none; }
.table a { color: #7ca9f7; }

.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.badge-open     { background: #1a3a6e; color: #7ca9f7; }
.badge-approved { background: #1a3d2b; color: #4ade80; }
.badge-merged   { background: #2d1a5e; color: #c084fc; }
.badge-rejected { background: #3d1a1a; color: #f87171; }

.btn {
  display: inline-block;
  padding: 0.4rem 0.85rem;
  border: 1px solid #333;
  border-radius: 4px;
  background: #1a1a1a;
  color: #ccc;
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}
.btn:hover { background: #222; color: #f0f0f0; text-decoration: none; }
.btn-primary { background: #1a3a6e; border-color: #2a5aae; color: #7ca9f7; }
.btn-primary:hover { background: #1f4a8e; color: #a8c8f8; }
.btn-danger  { background: #3d1a1a; border-color: #6e2a2a; color: #f87171; }
.btn-danger:hover  { background: #4d2020; color: #fca5a5; }

.empty-state { padding: 2rem 0; color: #555; text-align: center; }

.file-list { list-style: none; }
.file-item { padding: 0.3rem 0; border-bottom: 1px solid #161616; font-size: 0.85rem; color: #ccc; }
.file-item:last-child { border-bottom: none; }

.detail-list { display: grid; grid-template-columns: 140px 1fr; gap: 0.4rem 1rem; }
.detail-list dt { color: #666; font-size: 0.85rem; }
.detail-list dd { color: #ccc; }

.action-row { display: flex; gap: 0.75rem; margin-top: 1rem; }

.issue-list { margin-top: 0.35rem; padding-left: 1rem; color: #fca5a5; }

.mono { font-family: 'JetBrains Mono', monospace; }

/* Repo page layout */
.header-content { display: flex; flex-direction: column; gap: 0.25rem; }
.project-meta { font-size: 0.85rem; color: #666; }

.repo-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  align-items: start;
}

/* File sidebar */
.file-sidebar {
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  overflow: hidden;
  max-height: calc(100vh - 200px);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #1e1e1e;
  background: #0d0d0d;
}

.sidebar-header h2 {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0;
}

.file-count {
  font-size: 0.8rem;
  color: #666;
}

/* File tree */
.file-tree-list {
  list-style: none;
  overflow-y: auto;
  flex: 1;
  padding: 0.5rem 0;
}

.file-tree-list::-webkit-scrollbar {
  width: 6px;
}

.file-tree-list::-webkit-scrollbar-track {
  background: transparent;
}

.file-tree-list::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 3px;
}

.file-tree-item {
  font-size: 0.85rem;
}

.file-tree-item.directory details > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}

.file-tree-item.directory details > summary::-webkit-details-marker {
  display: none;
}

.file-tree-item.directory details > summary::before {
  content: "▶";
  display: inline-block;
  margin-right: 0.25rem;
  font-size: 0.7rem;
  color: #666;
  transition: transform 0.15s;
}

.file-tree-item.directory details[open] > summary::before {
  transform: rotate(90deg);
}

.folder-summary, .file {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  transition: background 0.15s;
}

.folder-summary:hover, .file:hover {
  background: #1a1a1a;
}

.folder-icon, .file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  flex-shrink: 0;
}

.folder-name {
  font-weight: 500;
  color: #aaa;
}

.file-name {
  color: #ccc;
}

.folder-count {
  font-size: 0.75rem;
  color: #555;
  margin-left: 0.25rem;
}

.file-link {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  text-decoration: none;
  flex: 1;
}

.file-link:hover {
  text-decoration: none;
}

/* Commits section */
.commits-section {
  min-width: 0;
}

.section-header {
  margin-bottom: 1rem;
}

.section-header h2 {
  font-size: 1rem;
  font-weight: 600;
  color: #ccc;
}

.commits-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.commit-card {
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  padding: 1rem;
}

.commit-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.commit-sha {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: #7ca9f7;
  background: #1a3a6e;
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
}

.commit-author {
  font-size: 0.85rem;
  color: #888;
}

.commit-date {
  font-size: 0.8rem;
  color: #666;
  margin-left: auto;
}

.commit-title {
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 0.25rem;
  line-height: 1.4;
}

.commit-body {
  font-size: 0.85rem;
  color: #888;
  white-space: pre-wrap;
  line-height: 1.5;
}

/* File viewer */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.95rem;
}

.breadcrumb a {
  color: #7ca9f7;
}

.breadcrumb-separator {
  color: #555;
}

.file-path {
  color: #ccc;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
}

.file-viewer-card {
  padding: 0;
  overflow: hidden;
}

.file-viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: #0d0d0d;
  border-bottom: 1px solid #1e1e1e;
}

.file-path-display {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  color: #e0e0e0;
}

.file-language {
  font-size: 0.8rem;
  color: #888;
  background: #1a1a1a;
  padding: 0.25rem 0.5rem;
  border-radius: 3px;
  text-transform: uppercase;
}

.code-viewer {
  overflow-x: auto;
  background: #0a0a0a;
}

.code-viewer::-webkit-scrollbar {
  height: 8px;
}

.code-viewer::-webkit-scrollbar-track {
  background: transparent;
}

.code-viewer::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 4px;
}

.code-table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  line-height: 1.6;
}

.code-table td {
  padding: 0;
  vertical-align: top;
}

.line-number {
  color: #444;
  text-align: right;
  padding: 0 0.75rem !important;
  background: #0d0d0d;
  border-right: 1px solid #1a1a1a;
  user-select: none;
  font-size: 0.8rem;
}

.line-content {
  padding: 0 1rem !important;
  white-space: pre;
}

.line-content pre {
  margin: 0;
  padding: 0;
  background: transparent;
  overflow: visible;
}

.line-content code {
  color: #ccc;
  font-family: inherit;
}

/* Responsive */
@media (max-width: 900px) {
  .repo-layout {
    grid-template-columns: 1fr;
  }

  .file-sidebar {
    max-height: 400px;
  }
}
`;
