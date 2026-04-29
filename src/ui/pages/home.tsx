import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

interface HomeProps {
  projects: Array<{ name: string; remote: string; createdAt: string }>;
}

export const HomePage: FC<HomeProps> = ({ projects }) => {
  return (
    <Layout title="Dashboard">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>
      {projects.length === 0 ? (
        <div class="empty-state">
          <p>No projects yet. Create one via the API.</p>
        </div>
      ) : (
        <div class="card-grid">
          {projects.map((project) => (
            <a class="card card-link" href={`/ui/projects/${project.name}`} key={project.name}>
              <div class="card-title">{project.name}</div>
              <div class="card-meta">{new Date(project.createdAt).toLocaleDateString()}</div>
            </a>
          ))}
        </div>
      )}
    </Layout>
  );
};
