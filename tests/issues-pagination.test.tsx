/**
 * Pagination controls on the issues list and the issue detail comment list.
 *
 * Bounding both queries (round 1) made everything past the first page
 * unreachable from the UI: the list always asked for page 0 and rendered no
 * way to move. These tests pin the navigation and, just as importantly, that
 * it carries the active status/label/search filters — a pager that silently
 * resets the filter is its own bug.
 */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { IssueComment } from "../src/storage/issue-comments";
import type { Issue } from "../src/storage/issues";
import { IssueDetailPage, IssuesPage } from "../src/ui/pages/issues";

const project = { name: "acme/api", namespace: "acme", slug: "api" };
const BASE = "/acme/api/issues";

function issue(n: number): Issue {
  return {
    id: `iss_${n}`,
    project: "acme/api",
    number: n,
    title: `Issue ${n}`,
    status: "open",
    authorType: "user",
    authorId: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Issue;
}

function comment(n: number): IssueComment {
  return {
    id: `icm_${n}`,
    issueId: "iss_1",
    authorType: "user",
    authorId: "user_1",
    body: `comment ${n}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderList(overrides: Partial<Parameters<typeof IssuesPage>[0]> = {}) {
  return renderToString(
    <IssuesPage
      project={project}
      issues={[issue(1)]}
      labels={{}}
      authors={{}}
      filter="open"
      page={0}
      hasNext={false}
      canWrite={false}
      {...overrides}
    />,
  );
}

describe("IssuesPage pagination", () => {
  it("renders no pager on a single page", () => {
    expect(renderList()).not.toContain('class="page-nav"');
  });

  it("offers a next page and keeps status, label, and search on the link", () => {
    const html = renderList({
      hasNext: true,
      filter: "closed",
      activeLabel: "bug",
      query: "crash",
    });
    expect(html).toContain('class="page-nav"');
    // Every active filter survives the hop, and the page index is appended.
    expect(html).toContain(`href="${BASE}?status=closed&amp;label=bug&amp;q=crash&amp;page=1"`);
    expect(html).toContain("Page 1");
  });

  it("links back to the unnumbered first page from page one", () => {
    const html = renderList({ page: 1, hasNext: false, activeLabel: "bug" });
    // Going back to page 0 drops `page=` rather than emitting `page=0`.
    expect(html).toContain(`href="${BASE}?label=bug"`);
    expect(html).toContain("Page 2");
    // No next page: the forward control is inert, not a link.
    expect(html).not.toContain("page=2");
  });

  it("escapes filter values into the pager href", () => {
    const html = renderList({ hasNext: true, query: "a&b c" });
    expect(html).toContain("q=a%26b%20c");
  });
});

describe("IssueDetailPage comment pagination", () => {
  function renderDetail(overrides: Record<string, unknown> = {}) {
    return renderToString(
      <IssueDetailPage
        project={project}
        issue={issue(7)}
        labels={[]}
        comments={[comment(1)]}
        commentPage={0}
        commentsHasNext={false}
        authors={{}}
        canWrite={false}
        {...overrides}
      />,
    );
  }

  it("renders no pager when every comment fits on one page", () => {
    const html = renderDetail();
    expect(html).not.toContain('class="page-nav"');
    // With no pagination in play the heading may state the true total.
    expect(html).toContain("1 comment");
  });

  it("pages comments off the issue's own URL", () => {
    const html = renderDetail({ commentsHasNext: true });
    expect(html).toContain(`href="${BASE}/7?page=1"`);
  });

  it("stops claiming a total once the list is paginated", () => {
    const html = renderDetail({ commentsHasNext: true });
    // "1 comment" would be a lie when a further page exists.
    expect(html).not.toContain("1 comment<");
    expect(html).toContain("Comments");
  });

  /**
   * Comments are read oldest-first, so page 1 holds *newer* comments than page
   * 0 — the opposite of the newest-first issue list. Sharing the list's labels
   * pointed the reader backwards through the thread.
   */
  it("labels the next comment page as newer, not older", () => {
    const html = renderDetail({ commentsHasNext: true, commentPage: 1 });
    expect(html).toContain("Newer →");
    expect(html).toContain("← Older");
    expect(html).not.toContain("Older →");
    expect(html).not.toContain("← Newer");
  });

  it("keeps the newest-first labelling on the issue list", () => {
    const html = renderList({ hasNext: true, page: 1 });
    expect(html).toContain("Older →");
    expect(html).toContain("← Newer");
    expect(html).not.toContain("Newer →");
    expect(html).not.toContain("← Older");
  });
});
