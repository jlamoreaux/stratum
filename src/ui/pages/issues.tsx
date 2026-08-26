import type { FC } from "hono/jsx";
import type { IssueComment } from "../../storage/issue-comments";
import type { Issue } from "../../storage/issues";
import { Layout } from "../layout";

interface ProjectRef {
  name: string;
  namespace: string;
  slug: string;
}

interface IssuesPageProps {
  project: ProjectRef;
  issues: Issue[];
  /** Absent for an issue with no labels, rather than an empty array. */
  labels: Record<string, string[]>;
  authors: Record<string, string>;
  filter: "open" | "closed" | "all";
  activeLabel?: string;
  query?: string;
  /** Zero-based page index; `hasNext` comes from reading one row past the page. */
  page: number;
  hasNext: boolean;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

/**
 * Previous/next links for a page bounded by a fixed limit. `hasNext` comes from
 * reading one row past the limit, so there is no total to show — the label
 * carries the 1-based page number rather than "of N".
 */
const PageNav: FC<{ base: string; keep: string; page: number; hasNext: boolean }> = ({
  base,
  keep,
  page,
  hasNext,
}) => {
  if (page === 0 && !hasNext) return null;
  const href = (target: number) => {
    const params = [...(keep ? [keep] : []), ...(target > 0 ? [`page=${target}`] : [])].join("&");
    return params ? `${base}?${params}` : base;
  };
  return (
    <nav class="page-nav" aria-label="Pagination">
      {page > 0 ? (
        <a class="btn" href={href(page - 1)} rel="prev">
          ← Newer
        </a>
      ) : (
        <span class="btn btn-disabled" aria-disabled="true">
          ← Newer
        </span>
      )}
      <span class="issues-meta">Page {page + 1}</span>
      {hasNext ? (
        <a class="btn" href={href(page + 1)} rel="next">
          Older →
        </a>
      ) : (
        <span class="btn btn-disabled" aria-disabled="true">
          Older →
        </span>
      )}
    </nav>
  );
};

const statusBadge = (status: Issue["status"]) =>
  status === "open" ? "badge badge-open" : "badge badge-merged";

/**
 * `keep` carries the filters a label link must not discard — the status tab and
 * the search text. The label itself is replaced, not accumulated, so the caller
 * must leave the active `label=` out of `keep`.
 */
const LabelChips: FC<{ labels: string[]; base: string; keep?: string }> = ({
  labels,
  base,
  keep,
}) => (
  <>
    {labels.map((label) => (
      <a
        key={label}
        class="badge issue-label"
        href={`${base}?label=${encodeURIComponent(label)}${keep ? `&${keep}` : ""}`}
        title={`Filter by label "${label}"`}
      >
        {label}
      </a>
    ))}
  </>
);

export const IssuesPage: FC<IssuesPageProps> = ({
  project,
  issues,
  labels,
  authors,
  filter,
  activeLabel,
  query,
  page,
  hasNext,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  // Preserve the label/search filters when switching status tabs.
  const keep = [
    ...(activeLabel ? [`label=${encodeURIComponent(activeLabel)}`] : []),
    ...(query ? [`q=${encodeURIComponent(query)}`] : []),
  ].join("&");
  // A label link swaps the label filter, so it carries the status tab and the
  // search text but deliberately not the current `label=`.
  const labelKeep = [
    ...(filter !== "open" ? [`status=${filter}`] : []),
    ...(query ? [`q=${encodeURIComponent(query)}`] : []),
  ].join("&");
  // Everything the pager must carry across pages: status tab, label, search.
  const pageKeep = [...(filter !== "open" ? [`status=${filter}`] : []), ...(keep ? [keep] : [])]
    .filter(Boolean)
    .join("&");
  const tab = (status?: "closed" | "all") => {
    const params = [...(status ? [`status=${status}`] : []), ...(keep ? [keep] : [])].join("&");
    return params ? `${base}?${params}` : base;
  };
  return (
    <Layout title={`Issues — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Issues</h1>
        <div class="page-header-actions">
          {canWrite && (
            <a class="btn btn-primary" href={`${base}/new`}>
              New issue
            </a>
          )}
          <a class="btn" href={`/${project.namespace}/${project.slug}`}>
            Back to repo
          </a>
        </div>
      </div>

      <div class="issues-filter">
        <a href={tab()} class={filter === "open" ? "issues-filter-active" : ""}>
          Open
        </a>
        <a href={tab("closed")} class={filter === "closed" ? "issues-filter-active" : ""}>
          Closed
        </a>
        <a href={tab("all")} class={filter === "all" ? "issues-filter-active" : ""}>
          All
        </a>
        <form method="get" action={base} class="issues-search">
          {filter !== "open" && <input type="hidden" name="status" value={filter} />}
          {activeLabel && <input type="hidden" name="label" value={activeLabel} />}
          <input type="search" name="q" placeholder="Search issues…" value={query ?? ""} />
        </form>
        {activeLabel && (
          <span class="issues-meta">
            label: <strong>{activeLabel}</strong> <a href={tab()}>clear</a>
          </span>
        )}
      </div>

      {issues.length === 0 ? (
        <div class="empty-state">
          <p>
            No {filter === "all" ? "" : `${filter} `}issues
            {activeLabel || query ? " match the current filter" : ""}.
          </p>
          <p class="empty-state-hint">
            Open an issue to track work, bugs, or ideas for this project.
          </p>
        </div>
      ) : (
        <ul class="issues-list">
          {issues.map((issue) => (
            <li key={issue.id} class="issues-item">
              <span class={statusBadge(issue.status)}>{issue.status}</span>
              <a href={`${base}/${issue.number}`} class="issues-title">
                #{issue.number} {issue.title}
              </a>
              <LabelChips labels={labels[issue.id] ?? []} base={base} keep={labelKeep} />
              {issue.linkedChangeId && (
                <a href={`/changes/${issue.linkedChangeId}`} class="issues-linked-change">
                  {issue.linkedChangeId}
                </a>
              )}
              <span class="issues-meta">
                opened {new Date(issue.createdAt).toLocaleDateString()} by{" "}
                {authors[issue.authorId] ?? issue.authorType}
                {issue.assignee
                  ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <PageNav base={base} keep={pageKeep} page={page} hasNext={hasNext} />
    </Layout>
  );
};

interface IssueDetailPageProps {
  project: ProjectRef;
  issue: Issue;
  labels: string[];
  comments: IssueComment[];
  /** Zero-based comment page; `commentsHasNext` reads one row past the page. */
  commentPage: number;
  commentsHasNext: boolean;
  /** Author display names keyed by author id (issue + comment authors + assignee). */
  authors: Record<string, string>;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

export const IssueDetailPage: FC<IssueDetailPageProps> = ({
  project,
  issue,
  labels,
  comments,
  commentPage,
  commentsHasNext,
  authors,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  const apiBase = `/api/projects/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`#${issue.number} ${issue.title} — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>
          #{issue.number} {issue.title}
        </h1>
        <a class="btn" href={base}>
          Back to issues
        </a>
      </div>

      <div class="issue-status-row">
        <span class={statusBadge(issue.status)}>{issue.status}</span>
        <LabelChips labels={labels} base={base} />
        <span class="issues-meta">
          opened {new Date(issue.createdAt).toLocaleString()} by{" "}
          {authors[issue.authorId] ?? issue.authorType}
          {issue.assignee ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}` : ""}
          {issue.closedAt ? ` · closed ${new Date(issue.closedAt).toLocaleString()}` : ""}
          {issue.closedBy === "system" ? " (auto-closed by merged change)" : ""}
        </span>
        {canWrite && (
          <form method="post" action={`${apiBase}/${issue.number}/close`}>
            <button type="submit" class="btn btn-small">
              {issue.status === "open" ? "Close issue" : "Reopen issue"}
            </button>
          </form>
        )}
      </div>

      {issue.linkedChangeId && (
        <div class="card" style={{ marginTop: "1rem" }}>
          <p style={{ margin: 0 }}>
            Linked change: <a href={`/changes/${issue.linkedChangeId}`}>{issue.linkedChangeId}</a>
            {issue.status === "open" ? " — this issue closes automatically when it merges." : ""}
          </p>
        </div>
      )}

      <div class="card issue-body">
        {issue.body ? <pre class="issue-body-text">{issue.body}</pre> : <p>No description.</p>}
      </div>

      <div class="issue-comments">
        <h2>
          {comments.length === 0 || commentPage > 0 || commentsHasNext
            ? "Comments"
            : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
        </h2>
        {comments.map((comment) => (
          <div key={comment.id} class="card issue-comment">
            <div class="issues-meta">
              {authors[comment.authorId] ?? comment.authorType} ·{" "}
              {new Date(comment.createdAt).toLocaleString()}
            </div>
            <pre class="issue-body-text">{comment.body}</pre>
          </div>
        ))}
        <PageNav
          base={`${base}/${issue.number}`}
          keep=""
          page={commentPage}
          hasNext={commentsHasNext}
        />
        {user ? (
          <div class="card">
            <form method="post" action={`${apiBase}/${issue.number}/comments`} class="issue-form">
              <label>
                Add a comment
                <textarea name="body" rows={4} required />
              </label>
              <button type="submit" class="btn btn-primary">
                Comment
              </button>
            </form>
          </div>
        ) : (
          <p class="issues-meta">Sign in to comment.</p>
        )}
      </div>
    </Layout>
  );
};

interface NewIssuePageProps {
  project: ProjectRef;
  user?: { id: string; email: string; username: string } | null;
}

export const NewIssuePage: FC<NewIssuePageProps> = ({ project, user }) => {
  const apiBase = `/api/projects/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`New issue — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>New issue</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}/issues`}>
          Cancel
        </a>
      </div>

      <div class="card">
        <form method="post" action={apiBase} class="issue-form">
          <label>
            Title
            <input type="text" name="title" maxlength={200} required />
          </label>
          <label>
            Description
            <textarea name="body" rows={8} />
          </label>
          <label>
            Linked change ID (optional — issue closes when it merges)
            <input type="text" name="linkedChangeId" placeholder="chg_…" />
          </label>
          <button type="submit" class="btn btn-primary">
            Open issue
          </button>
        </form>
      </div>
    </Layout>
  );
};
