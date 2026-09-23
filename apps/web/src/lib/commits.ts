// Commit lookups backing the New release form's commit picker.
// GET /api/applications/:id/commits and GET /api/applications/:id/commits/:sha
// — see the commit-selector contract. Error codes are surfaced through
// ApiRequestError so the picker can show a plain-language message per code.

import { apiRequest, ApiRequestError } from '@/lib/api-client';

export interface Commit {
  sha: string;
  shortSha: string;
  title: string;
  authorName: string | null;
  committedAt: string | null;
}

export interface CommitsPage {
  repoFullName: string;
  branch: string;
  commits: Commit[];
  /** The next page to fetch, or null when this was the last page. */
  nextPage: number | null;
}

/** GET /api/applications/:id/commits?page=N — page 1..10, fixed size 30. */
export function fetchCommits(applicationId: string, page: number): Promise<CommitsPage> {
  return apiRequest<CommitsPage>(
    `/api/applications/${encodeURIComponent(applicationId)}/commits?page=${page}`,
  );
}

/** GET /api/applications/:id/commits/:sha — resolves a manually typed SHA
 *  (7-40 hex chars) against the repository. */
export async function resolveCommit(applicationId: string, sha: string): Promise<Commit> {
  const body = await apiRequest<{ commit: Commit }>(
    `/api/applications/${encodeURIComponent(applicationId)}/commits/${encodeURIComponent(sha)}`,
  );
  return body.commit;
}

/** Plain-language message for a failed commits/resolve request, for a
 *  non-Git-expert SaaS vendor audience (§65). */
export function commitsErrorMessage(error: unknown, branch: string): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'GITHUB_NOT_CONNECTED':
        return 'GitHub is not connected for this application. Reconnect GitHub, or enter a commit SHA manually.';
      case 'GITHUB_REPO_NOT_FOUND':
        return "We can't find this application's repository on GitHub. It may have been deleted or access was removed.";
      case 'GITHUB_BRANCH_NOT_FOUND':
        return branch
          ? `The ${branch} branch no longer exists in the repository.`
          : 'The branch no longer exists in the repository.';
      case 'GITHUB_RATE_LIMITED':
        return 'GitHub is limiting requests right now. Wait a minute, then retry.';
      default:
        return "We couldn't load commits from GitHub.";
    }
  }
  return "We couldn't load commits from GitHub.";
}
