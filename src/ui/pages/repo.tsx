import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface RepoProps {
  project: { name: string; remote: string; createdAt: string };
  files: string[];
  log: Array<{ sha: string; message: string; author: string; timestamp: number }>;
  user?: { id: string; email: string } | null;
}

export const RepoPage: FC<RepoProps> = ({ project, files, log, user }) => {
  return (
    <Layout title={project.name} user={user}>
      <div class="page-header">
        <h1>{project.name}</h1>
        <a class="btn btn-primary" href={`/ui/projects/${project.name}/changes`}>
          View changes
        </a>
      </div>

      <div class="card">
        <h2>Files</h2>
        {files.length === 0 ? (
          <div class="empty-state">
            <p>No files in this repository.</p>
          </div>
        ) : (
          <ul class="file-list">
            {files.map((file) => (
              <li key={file} class="file-item">
                {file}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="card">
        <h2>Recent commits</h2>
        {log.length === 0 ? (
          <div class="empty-state">
            <p>No commits yet.</p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>SHA</th>
                <th>Message</th>
                <th>Author</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {log.map((commit) => (
                <tr key={commit.sha}>
                  <td class="mono">{commit.sha.slice(0, 7)}</td>
                  <td>{commit.message}</td>
                  <td>{commit.author}</td>
                  <td>{new Date(commit.timestamp * 1000).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
};
