import type { FC } from "hono/jsx";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface WorkspacesProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
  };
  canWrite?: boolean;
  workspaces: Array<{ name: string; createdAt: string }>;
  user?: { id: string; email: string; username: string } | null;
}

export const WorkspacesPage: FC<WorkspacesProps> = ({ project, workspaces, canWrite, user }) => {
  return (
    <Layout title={`Workspaces — ${project.name}`} user={user}>
      <ProjectHeader project={project} canWrite={canWrite ?? false} />
      <div class="page-header">
        <h1>Workspaces</h1>
      </div>

      {workspaces.length === 0 ? (
        <div class="empty-state">
          <p>No workspaces yet.</p>
          <p class="empty-state-hint">
            A workspace is your private fork of this project — agents and humans commit there, then
            open a change. From your terminal:
          </p>
          <pre class="cli-hint">{`stratum workspace create ${project.namespace}/${project.slug}`}</pre>
          <p class="empty-state-hint">
            <a href="https://docs.usestratum.dev" target="_blank" rel="noopener noreferrer">
              CLI setup guide →
            </a>
          </p>
        </div>
      ) : (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((ws) => (
                <tr key={ws.name}>
                  <td>{ws.name}</td>
                  <td>{new Date(ws.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
};
