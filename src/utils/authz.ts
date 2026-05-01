import type { ProjectEntry } from "../types";

export function canReadProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (project.visibility === "public") return true;
  return canWriteProject(project, userId, agentOwnerId);
}

export function canWriteProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (!project.ownerId) return false;
  return project.ownerId === userId || project.ownerId === agentOwnerId;
}

export function filterReadableProjects(
  projects: ProjectEntry[],
  userId?: string,
  agentOwnerId?: string,
): ProjectEntry[] {
  return projects.filter((project) => canReadProject(project, userId, agentOwnerId));
}
