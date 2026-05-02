import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface FileViewerProps {
  project: { name: string };
  filePath: string;
  content: string;
  error: string;
}

function getLanguageFromPath(path: string): string {
  if (!path) return "";
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    html: "html",
    svg: "xml",
    xml: "xml",
    sh: "bash",
    bash: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
  };
  return langMap[ext] || "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const FileViewerPage: FC<FileViewerProps> = ({ project, filePath, content, error }) => {
  const safePath = filePath ?? "";
  const language = getLanguageFromPath(safePath);
  const safeContent = content ?? "";
  const lines = safeContent.split("\n");
  const maxLineNumWidth = String(lines.length).length;

  return (
    <Layout title={`${safePath} — ${project.name}`}>
      <div class="page-header">
        <div class="breadcrumb">
          <a href={`/ui/projects/${project.name}`}>{project.name}</a>
          <span class="breadcrumb-separator">/</span>
          <span class="file-path">{safePath}</span>
        </div>
        <a class="btn" href={`/ui/projects/${project.name}`}>
          Back to repo
        </a>
      </div>

      <div class="card file-viewer-card">
        <div class="file-viewer-header">
          <span class="file-path-display">{safePath}</span>
          {language && <span class="file-language">{language}</span>}
        </div>

        {error ? (
          <div class="empty-state">
            <p>{error}</p>
          </div>
        ) : (
          <div class="code-viewer">
            <table class="code-table">
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td
                      class="line-number"
                      style={`width: ${maxLineNumWidth + 2}ch`}
                    >
                      {i + 1}
                    </td>
                    <td class="line-content">
                      <pre>
                        <code
                          dangerouslySetInnerHTML={{
                            __html: line === "" ? "\n" : escapeHtml(line),
                          }}
                        />
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
};
