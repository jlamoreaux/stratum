import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface WorkspacesProps {
  project: string;
  workspaces: Array<{ name: string; parent: string; createdAt: string }>;
}

export const WorkspacesPage: FC<WorkspacesProps> = ({ project, workspaces }) => {
  return (
    <Layout title={`Workspaces — ${project}`}>
      <div class="page-header">
        <h1>Workspaces</h1>
        <a class="btn" href={`/ui/projects/${project}`}>
          Back to repo
        </a>
      </div>

      {workspaces.length === 0 ? (
        <div class="empty-state">
          <p>No workspaces yet.</p>
        </div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Parent</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((ws) => (
              <tr key={ws.name}>
                <td>{ws.name}</td>
                <td>{ws.parent}</td>
                <td>{new Date(ws.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
};
