/**
 * The site header, shared verbatim between the app and the docs site.
 *
 * app.usestratum.dev renders it from `src/ui/layout.tsx` with this stylesheet
 * spliced into `src/ui/styles.ts`; docs.usestratum.dev renders the same markup
 * from `website/src/components/Header.astro` against a generated copy of this
 * file. `website/scripts/mirror-header.mjs` writes that copy into
 * `website/src/styles/header.css` (along with the design tokens the rules below
 * reference, read out of `styles.ts`), and `npm run check:header` in `website/`
 * fails the build if it has drifted.
 *
 * So: edit the header here. Never edit `website/src/styles/header.css` — the
 * next sync overwrites it — and keep the rules self-contained, since the docs
 * site has none of the app's other styles. The one thing the copy does not
 * carry is the token *values*: the mirror emits them for the app's dark chrome,
 * and the docs site remaps them for its light theme in `theme.css`.
 */
export const NAV_CSS = `
.nav {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.6;
}

.nav a { text-decoration: none; }

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

.nav-logout-form { display: inline; }
button.nav-auth-link {
  background: none; border: none; cursor: pointer;
  font-family: inherit; font-size: 0.9rem; line-height: inherit;
}
`;
