import { Fragment } from "hono/jsx";
import type { FC } from "hono/jsx";
import { ProjectHeader } from "../components/project-header";
import type { FileContentResult } from "../file-content";
import { highlightCode } from "../highlight";
import { Layout } from "../layout";

const extensionToLanguage: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  md: "markdown",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  sh: "shell",
  bash: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  php: "php",
  xml: "xml",
  svg: "xml",
};

function languageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extensionToLanguage[ext] ?? "plaintext";
}

interface BreadcrumbProps {
  namespace: string;
  slug: string;
  filePath: string;
}

/**
 * Only the project crumb is a link: there is no user-profile route for the
 * namespace and no directory-listing route for intermediate path segments,
 * so rendering those as links would promise navigation that doesn't exist.
 */
const Breadcrumb: FC<BreadcrumbProps> = ({ namespace, slug, filePath }) => {
  const segments = filePath.split("/").filter((s) => s.length > 0);

  return (
    <div class="file-viewer-breadcrumb">
      <span>{namespace}</span>
      <span class="sep">/</span>
      <a href={`/${namespace}/${slug}`}>{slug}</a>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={`seg-${i}`}>
            <span class="sep">/</span>
            {isLast ? (
              <span class="file-viewer-breadcrumb-current">{segment}</span>
            ) : (
              <span>{segment}</span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
};

interface FileViewerPageProps {
  project: { namespace: string; slug: string; name: string; visibility?: string };
  path: string;
  content: FileContentResult;
  canWrite?: boolean;
  user?: { id: string; email: string; username: string } | null;
}

export const FileViewerPage: FC<FileViewerPageProps> = ({
  project,
  path,
  content,
  canWrite,
  user,
}) => {
  const { namespace, slug } = project;
  const language = languageFromPath(path);
  const fileName = path.split("/").pop() ?? path;

  return (
    <Layout title={`${fileName} — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="code" canWrite={canWrite ?? false} />
      <div class="page-header">
        <Breadcrumb namespace={namespace} slug={slug} filePath={path} />
      </div>

      <div class="card file-viewer-content">
        {content.kind === "content" &&
          (() => {
            // highlightCode escapes its input; the returned markup is trusted.
            const highlighted = highlightCode(content.value, language);
            return (
              <pre>
                {highlighted !== null ? (
                  <code
                    class={`highlighted language-${language}`}
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                ) : (
                  <code class={`language-${language}`}>{content.value}</code>
                )}
              </pre>
            );
          })()}
        {content.kind === "binary" && <p class="file-viewer-message">Binary file — not shown.</p>}
        {content.kind === "oversize" && (
          <p class="file-viewer-message">File too large to display (&gt; 512 KB).</p>
        )}
      </div>
    </Layout>
  );
};
