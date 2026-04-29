import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

interface ChangeDetailProps {
  change: {
    id: string;
    project: string;
    workspace: string;
    status: string;
    evalScore?: number;
    evalPassed?: boolean;
    evalReason?: string;
    createdAt: string;
    mergedAt?: string;
  };
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'open': return 'badge badge-open';
    case 'approved': return 'badge badge-approved';
    case 'merged': return 'badge badge-merged';
    case 'rejected': return 'badge badge-rejected';
    default: return 'badge';
  }
}

export const ChangeDetailPage: FC<ChangeDetailProps> = ({ change }) => {
  return (
    <Layout title={`Change ${change.id}`}>
      <div class="page-header">
        <h1>
          <span class="mono">{change.id}</span>
          {' '}
          <span class={statusBadgeClass(change.status)}>{change.status}</span>
        </h1>
        <a class="btn" href={`/ui/projects/${change.project}/changes`}>Back to changes</a>
      </div>

      <div class="card">
        <dl class="detail-list">
          <dt>Project</dt>
          <dd><a href={`/ui/projects/${change.project}`}>{change.project}</a></dd>
          <dt>Workspace</dt>
          <dd>{change.workspace}</dd>
          <dt>Created</dt>
          <dd>{new Date(change.createdAt).toLocaleString()}</dd>
          {change.mergedAt !== undefined && (
            <>
              <dt>Merged</dt>
              <dd>{new Date(change.mergedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </div>

      <div class="card">
        <h2>Eval result</h2>
        <dl class="detail-list">
          <dt>Score</dt>
          <dd>
            {change.evalScore !== undefined
              ? `${Math.round(change.evalScore * 100)}%`
              : '—'}
          </dd>
          <dt>Passed</dt>
          <dd>
            {change.evalPassed !== undefined
              ? (change.evalPassed
                  ? <span class="badge badge-approved">passed</span>
                  : <span class="badge badge-rejected">failed</span>)
              : '—'}
          </dd>
          {change.evalReason !== undefined && (
            <>
              <dt>Reason</dt>
              <dd>{change.evalReason}</dd>
            </>
          )}
        </dl>
      </div>

      {(change.status === 'approved' || change.status === 'open') && (
        <div class="action-row">
          {change.status === 'approved' && (
            <form method="post" action={`/api/changes/${change.id}/merge`}>
              <button type="submit" class="btn btn-primary">Merge</button>
            </form>
          )}
          <form method="post" action={`/api/changes/${change.id}/reject`}>
            <button type="submit" class="btn btn-danger">Reject</button>
          </form>
        </div>
      )}
    </Layout>
  );
};
