import type { FC } from "hono/jsx";

/** The header links a page can mark as the one the reader is on. */
export type NavItem = "new" | "settings";

interface LayoutProps {
  title: string;
  user?:
    | { id: string; email: string; username: string; displayName?: string | undefined }
    | null
    | undefined;
  /** Auto-reload the page every N seconds (status polling without client JS). */
  refreshSeconds?: number;
  /** Which header link, if any, points at the current page. */
  active?: NavItem;
  children?: unknown;
}

export const Layout: FC<LayoutProps> = ({ title, user, refreshSeconds, active, children }) => {
  const current = (item: NavItem) => (active === item ? "page" : undefined);
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {refreshSeconds !== undefined && (
          <meta http-equiv="refresh" content={String(refreshSeconds)} />
        )}
        <title>{title} — Stratum</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
        <link rel="stylesheet" href="/ui.css" />
      </head>
      <body>
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
          {user && (
            <>
              {/* Phone-width menu toggle; see the .nav-menu-toggle rules in nav-css.ts. */}
              <input type="checkbox" id="nav-menu" class="nav-menu-toggle" />
              <label for="nav-menu" class="nav-menu-button">
                <span class="nav-menu-open">menu</span>
                <span class="nav-menu-close">close</span>
              </label>
            </>
          )}
          <div class="nav-auth">
            {user ? (
              <>
                {/* Identity, not navigation: who is signed in. The account page is "settings". */}
                <span class="nav-user" title={`@${user.username}`}>
                  {user.displayName ?? user.username ?? user.email}
                </span>
                <a href="/new" class="nav-auth-link" aria-current={current("new")}>
                  new project
                </a>
                <a href="/settings" class="nav-auth-link" aria-current={current("settings")}>
                  settings
                </a>
                <form method="post" action="/auth/logout" class="nav-logout-form">
                  <button type="submit" class="nav-auth-link">
                    logout
                  </button>
                </form>
              </>
            ) : (
              <a href="/auth/login" class="nav-auth-link">
                sign in
              </a>
            )}
          </div>
        </nav>
        <main class="main">{children}</main>
      </body>
    </html>
  );
};
