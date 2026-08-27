import type { FC } from "hono/jsx";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface ProjectSettingsProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
    createdAt: string;
    sourceUrl?: string;
    lastSyncedAt?: string;
    autoSyncEnabled?: boolean;
  };
  isOwner: boolean;
  user?: { id: string; email: string; username: string } | null;
}

export const ProjectSettingsPage: FC<ProjectSettingsProps> = ({ project, isOwner, user }) => {
  const base = `/${project.namespace}/${project.slug}`;
  return (
    <Layout title={`Settings — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="settings" canWrite={true} />

      <div class="card">
        <h3 style={{ marginTop: 0 }}>General</h3>
        <dl class="detail-list">
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Path</dt>
          <dd>
            {project.namespace}/{project.slug}
          </dd>
          <dt>Visibility</dt>
          <dd>{project.visibility ?? "private"}</dd>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleDateString()}</dd>
        </dl>
      </div>

      {project.sourceUrl && (
        <div class="card">
          <h3 style={{ marginTop: 0 }}>Upstream sync</h3>
          <p class="settings-help">
            This project was imported from{" "}
            <a href={project.sourceUrl} target="_blank" rel="noopener noreferrer">
              {project.sourceUrl.replace(/^https?:\/\//, "")}
            </a>
            . Sync pulls new upstream commits into the project.
          </p>
          <div class="action-row">
            <a class="btn" href={`${base}/sync`}>
              Sync settings &amp; history
            </a>
          </div>
        </div>
      )}

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Webhooks</h3>
        <p class="settings-help">
          Deliver signed JSON payloads to your endpoints when events happen in this project.
        </p>
        <div class="action-row">
          <a class="btn" href={`${base}/webhooks`}>
            Manage webhooks
          </a>
        </div>
      </div>

      {isOwner && (
        <div class="card danger-zone">
          <h3 style={{ marginTop: 0 }}>Danger Zone</h3>
          <p>
            Permanently delete this project and every byte tied to it — repo, forks, changes, and
            all metadata. This cannot be undone. Type{" "}
            <code>
              {project.namespace}/{project.slug}
            </code>{" "}
            to confirm.
          </p>
          <form method="post" action={`/api/projects/${project.namespace}/${project.slug}/delete`}>
            <input
              type="text"
              name="confirm"
              required
              autocomplete="off"
              placeholder={`${project.namespace}/${project.slug}`}
            />
            <button type="submit" class="btn btn-danger">
              Delete project
            </button>
          </form>
        </div>
      )}
    </Layout>
  );
};
