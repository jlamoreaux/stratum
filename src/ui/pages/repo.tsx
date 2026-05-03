import type { FC } from "hono/jsx";
import {
  FileConfigIcon,
  FileCssIcon,
  FileDockerIcon,
  FileGenericIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileJsIcon,
  FileJsonIcon,
  FileLockIcon,
  FileMarkdownIcon,
  FileReactIcon,
  FileTsIcon,
  FileYamlIcon,
  FolderDocsIcon,
  FolderExamplesIcon,
  FolderGenericIcon,
  FolderHiddenIcon,
  FolderScriptsIcon,
  FolderSrcIcon,
  FolderTestIcon,
} from "../icons";
import { Layout } from "../layout";

interface RepoProps {
  project: { name: string; remote: string; createdAt: string };
  files: string[];
  log: Array<{ sha: string; message: string; author: string; timestamp: number }>;
}

// Build a tree structure from flat file list
function buildFileTree(files: string[]): FileNode {
  const root: FileNode = { name: "", type: "directory", children: [] };

  for (const filePath of files) {
    const parts = filePath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const isFile = i === parts.length - 1;

      if (isFile) {
        current.children.push({
          name: part,
          type: "file",
          path: filePath,
          extension: part.split(".").pop() || "",
        });
      } else {
        let dir = current.children.find(
          (c): c is FileNode => c.type === "directory" && c.name === part,
        );
        if (!dir) {
          dir = { name: part, type: "directory", children: [] };
          current.children.push(dir);
        }
        current = dir;
      }
    }
  }

  // Sort: directories first, then files, both alphabetically
  const sortNodes = (a: FileNode | FileLeaf, b: FileNode | FileLeaf) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  };

  const sortRecursive = (node: FileNode) => {
    node.children.sort(sortNodes);
    for (const child of node.children) {
      if (child.type === "directory") sortRecursive(child);
    }
  };

  sortRecursive(root);
  return root;
}

interface FileNode {
  name: string;
  type: "directory";
  children: (FileNode | FileLeaf)[];
}

interface FileLeaf {
  name: string;
  type: "file";
  path: string;
  extension: string;
}

function getFileIcon(extension: string): FC {
  const icons: Record<string, FC> = {
    ts: FileTsIcon,
    tsx: FileReactIcon,
    js: FileJsIcon,
    jsx: FileReactIcon,
    json: FileJsonIcon,
    md: FileMarkdownIcon,
    yml: FileYamlIcon,
    yaml: FileYamlIcon,
    css: FileCssIcon,
    html: FileHtmlIcon,
    svg: FileImageIcon,
    png: FileImageIcon,
    jpg: FileImageIcon,
    jpeg: FileImageIcon,
    gif: FileImageIcon,
    ico: FileImageIcon,
    gitignore: FileConfigIcon,
    lock: FileLockIcon,
    toml: FileConfigIcon,
    dockerfile: FileDockerIcon,
  };
  return icons[extension.toLowerCase()] || FileGenericIcon;
}

function getFolderIcon(name: string): FC {
  if (name.startsWith(".")) return FolderHiddenIcon;
  if (name === "src") return FolderSrcIcon;
  if (name === "test" || name === "tests") return FolderTestIcon;
  if (name === "docs") return FolderDocsIcon;
  if (name === "examples" || name === "demo") return FolderExamplesIcon;
  if (name === "scripts" || name === "bin") return FolderScriptsIcon;
  return FolderGenericIcon;
}

const FileTreeNode: FC<{ node: FileNode | FileLeaf; level: number; projectName: string }> = ({
  node,
  level,
  projectName,
}) => {
  const indent = level * 12;

  if (node.type === "file") {
    const IconComponent = getFileIcon(node.extension);
    const encodedPath = node.path.split("/").map(encodeURIComponent).join("/");
    return (
      <li class="file-tree-item file" style={`padding-left: ${indent + 20}px`}>
        <a href={`/ui/projects/${projectName}/files/${encodedPath}`} class="file-link">
          <span class="file-icon">
            <IconComponent />
          </span>
          <span class="file-name">{node.name}</span>
        </a>
      </li>
    );
  }

  // It's a directory
  const IconComponent = getFolderIcon(node.name);
  return (
    <li class="file-tree-item directory">
      <details open={level < 2}>
        <summary style={`padding-left: ${indent + 20}px`} class="folder-summary">
          <span class="folder-icon">
            <IconComponent />
          </span>
          <span class="folder-name">{node.name || projectName}</span>
          <span class="folder-count">({node.children.length})</span>
        </summary>
        <ul class="file-tree-list">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.type === "file" ? child.path : child.name}
              node={child}
              level={level + 1}
              projectName={projectName}
            />
          ))}
        </ul>
      </details>
    </li>
  );
};

export const RepoPage: FC<RepoProps> = ({ project, files, log }) => {
  const fileTree = buildFileTree(files);

  return (
    <Layout title={project.name}>
      <div class="page-header">
        <div class="header-content">
          <h1>{project.name}</h1>
          <span class="project-meta">
            Created {new Date(project.createdAt).toLocaleDateString()}
          </span>
        </div>
        <a class="btn btn-primary" href={`/ui/projects/${project.name}/changes`}>
          View changes
        </a>
      </div>

      <div class="repo-layout">
        {/* Left sidebar - File tree */}
        <aside class="file-sidebar">
          <div class="sidebar-header">
            <h2>Files</h2>
            <span class="file-count">{files.length} files</span>
          </div>
          {files.length === 0 ? (
            <div class="empty-state">
              <p>No files in this repository.</p>
            </div>
          ) : (
            <ul class="file-tree-list">
              {fileTree.children.map((child) => (
                <FileTreeNode
                  key={child.type === "file" ? child.path : child.name}
                  node={child}
                  level={0}
                  projectName={project.name}
                />
              ))}
            </ul>
          )}
        </aside>

        {/* Main content - Commits */}
        <main class="commits-section">
          <div class="section-header">
            <h2>Recent commits</h2>
          </div>
          {log.length === 0 ? (
            <div class="empty-state">
              <p>No commits yet.</p>
            </div>
          ) : (
            <div class="commits-list">
              {log.map((commit) => {
                const messageLines = commit.message.split("\n");
                const firstLine = messageLines[0];
                const restLines = messageLines.slice(1).filter((l) => l.trim());

                return (
                  <div key={commit.sha} class="commit-card">
                    <div class="commit-header">
                      <span class="commit-sha">{commit.sha.slice(0, 7)}</span>
                      <span class="commit-author">{commit.author}</span>
                      <span class="commit-date">
                        {new Date(commit.timestamp * 1000).toLocaleDateString()}
                      </span>
                    </div>
                    <div class="commit-message">
                      <div class="commit-title">{firstLine}</div>
                      {restLines.length > 0 && (
                        <div class="commit-body">
                          {restLines.slice(0, 3).join("\n")}
                          {restLines.length > 3 && "..."}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </Layout>
  );
};
