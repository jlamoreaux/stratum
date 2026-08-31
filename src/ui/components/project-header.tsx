import type { FC } from "hono/jsx";

export type ProjectTab =
  | "code"
  | "changes"
  | "issues"
  | "activity"
  | "branches"
  | "tags"
  | "settings";

export interface ProjectRef {
  name: string;
  namespace: string;
  slug: string;
  visibility?: string;
}

interface ProjectHeaderProps {
  project: ProjectRef;
  /** Which tab the current page belongs to; omit for pages outside the tab set. */
  active?: ProjectTab;
  /** Settings is only offered to users who can actually open it. */
  canWrite?: boolean;
  /** Page-level action (e.g. Sync Now) rendered to the right of the breadcrumb. */
  children?: unknown;
}

/**
 * The persistent project chrome: identity crumb + tab navigation, shared by
 * every project page so switching sections never requires "Back to repo"
 * round-trips through the overview.
 */
export const ProjectHeader: FC<ProjectHeaderProps> = ({ project, active, canWrite, children }) => {
  const base = `/${project.namespace}/${project.slug}`;
  const tabs: Array<{ key: ProjectTab; label: string; href: string }> = [
    { key: "code", label: "Code", href: base },
    { key: "changes", label: "Changes", href: `${base}/changes` },
    { key: "issues", label: "Issues", href: `${base}/issues` },
    { key: "activity", label: "Activity", href: `${base}/activity` },
    // Next to Tags: both list refs, and grouping them keeps the ref-shaped
    // sections together rather than burying branches under Code.
    { key: "branches", label: "Branches", href: `${base}/branches` },
    { key: "tags", label: "Tags", href: `${base}/tags` },
    ...(canWrite
      ? [{ key: "settings" as const, label: "Settings", href: `${base}/settings` }]
      : []),
  ];

  return (
    <header class="project-header">
      <div class="project-header-row">
        <div class="project-crumb">
          <span class="project-crumb-namespace">{project.namespace}</span>
          <span class="project-crumb-sep">/</span>
          <a class="project-crumb-name" href={base}>
            {project.slug}
          </a>
          {project.visibility === "public" && <span class="badge badge-public">public</span>}
        </div>
        {children ? <div class="header-actions">{children}</div> : null}
      </div>
      <nav class="project-tabs" aria-label="Project sections">
        {tabs.map((tab) => (
          <a
            key={tab.key}
            href={tab.href}
            class={`project-tab ${active === tab.key ? "project-tab-active" : ""}`}
            {...(active === tab.key ? { "aria-current": "page" } : {})}
          >
            {tab.label}
          </a>
        ))}
      </nav>
    </header>
  );
};
