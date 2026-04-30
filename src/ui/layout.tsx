import type { FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  children?: unknown;
}

export const Layout: FC<LayoutProps> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
      </head>
      <body>
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
          <div class="nav-links">
            <a href="/ui/projects">projects</a>
          </div>
        </nav>
        <main class="main">{children}</main>
      </body>
    </html>
  );
};
