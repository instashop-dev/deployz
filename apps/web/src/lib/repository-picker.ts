// What the repository picker derives from its inputs, kept apart from the
// component so it can be tested without a DOM (the same split as
// github-state.ts).

import type { Application } from '@/lib/applications';
import type { GithubRepository } from '@/lib/github';

/**
 * repoFullName -> the application already connected to it. An application is
 * keyed by its owner/repo name — the API allows one per repository per
 * organization on exactly that key — so it is the identity the picker
 * matches on rather than GitHub's numeric repository id.
 */
export function connectedApplicationsByRepo(
  applications: readonly Application[],
): Map<string, string> {
  return new Map(applications.map((app) => [app.repoFullName, app.id]));
}

/**
 * Case-insensitive match on the owner/repo name, or on the description when
 * GitHub supplied one. An empty or whitespace-only query keeps every repo.
 */
export function filterRepositories(
  repositories: readonly GithubRepository[],
  query: string,
): GithubRepository[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...repositories];
  return repositories.filter(
    (repo) =>
      repo.fullName.toLowerCase().includes(needle) ||
      (repo.description?.toLowerCase().includes(needle) ?? false),
  );
}
