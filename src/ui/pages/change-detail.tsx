import type { FC } from "hono/jsx";
import { Layout } from "../layout";

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
  evalRuns: Array<{
    id: string;
    evaluatorType: string;
    score: number;
    passed: boolean;
    reason: string;
    issues?: string[];
    ranAt: string;
  }>;
  provenance: {
    commitSha: string;
    workspace: string;
    agentId?: string;
    evalScore?: number;
    mergedAt: string;
  } | null;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return "badge badge-open";
    case "approved":
      return "badge badge-approved";
    case "merged":
      return "badge badge-merged";
    case "rejected":
      return "badge badge-rejected";
    default:
      return "badge";
  }
}

export const ChangeDetailPage: FC<ChangeDetailProps> = ({ change, evalRuns, provenance }) => {
  return (
    <Layout title={`Change ${change.id}`}>
      <div class="page-header">
        <h1>
          <span class="mono">{change.id}</span>{" "}
          <span class={statusBadgeClass(change.status)}>{change.status}</span>
        </h1>
        <a class="btn" href={`/ui/projects/${change.project}/changes`}>
          Back to changes
        </a>
      </div>

      <div class="card">
        <dl class="detail-list">
          <dt>Project</dt>
          <dd>
            <a href={`/ui/projects/${change.project}`}>{change.project}</a>
          </dd>
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
          <dd>{change.evalScore !== undefined ? `${Math.round(change.evalScore * 100)}%` : "—"}</dd>
          <dt>Passed</dt>
          <dd>
            {change.evalPassed !== undefined ? (
              change.evalPassed ? (
                <span class="badge badge-approved">passed</span>
              ) : (
                <span class="badge badge-rejected">failed</span>
              )
            ) : (
              "—"
            )}
          </dd>
          {change.evalReason !== undefined && (
            <>
              <dt>Reason</dt>
              <dd>{change.evalReason}</dd>
            </>
          )}
        </dl>
      </div>

      <div class="card">
        <h2>Evaluator evidence</h2>
        {evalRuns.length === 0 ? (
          <div class="empty-state">
            <p>No evaluator evidence recorded.</p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Evaluator</th>
                <th>Status</th>
                <th>Score</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {evalRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.evaluatorType}</td>
                  <td>
                    {run.passed ? (
                      <span class="badge badge-approved">passed</span>
                    ) : (
                      <span class="badge badge-rejected">failed</span>
                    )}
                  </td>
                  <td>{Math.round(run.score * 100)}%</td>
                  <td>
                    {run.reason}
                    {run.issues !== undefined && run.issues.length > 0 && (
                      <ul class="issue-list">
                        {run.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {provenance !== null && (
        <div class="card">
          <h2>Provenance</h2>
          <dl class="detail-list">
            <dt>Commit</dt>
            <dd class="mono">{provenance.commitSha}</dd>
            <dt>Workspace</dt>
            <dd>{provenance.workspace}</dd>
            {provenance.agentId !== undefined && (
              <>
                <dt>Agent</dt>
                <dd>{provenance.agentId}</dd>
              </>
            )}
            <dt>Merged</dt>
            <dd>{new Date(provenance.mergedAt).toLocaleString()}</dd>
          </dl>
        </div>
      )}

      {(change.status === "approved" || change.status === "open") && (
        <div class="action-row">
          {change.status === "approved" && (
            <form method="post" action={`/api/changes/${change.id}/merge`}>
              <button type="submit" class="btn btn-primary">
                Merge
              </button>
            </form>
          )}
          <form method="post" action={`/api/changes/${change.id}/reject`}>
            <button type="submit" class="btn btn-danger">
              Reject
            </button>
          </form>
        </div>
      )}
    </Layout>
  );
};
