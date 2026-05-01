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
`;
