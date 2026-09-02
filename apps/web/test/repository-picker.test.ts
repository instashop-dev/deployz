import { describe, expect, it } from 'vitest';

import type { Application } from '../src/lib/applications';
import type { GithubRepository } from '../src/lib/github';
import { connectedApplicationsByRepo, filterRepositories } from '../src/lib/repository-picker';

function repository(overrides: Partial<GithubRepository> = {}): GithubRepository {
  return {
    id: 'repo-1',
    name: 'myapp',
    fullName: 'acme/myapp',
    description: null,
    private: false,
    defaultBranch: 'main',
    ...overrides,
  };
}

const REPOS = [
  repository(),
  repository({
    id: 'repo-2',
    name: 'billing-service',
    fullName: 'acme/billing-service',
    description: 'Invoices and Stripe webhooks',
  }),
  repository({ id: 'repo-3', name: 'Docs-Site', fullName: 'acme/Docs-Site' }),
];

describe('filterRepositories', () => {
  it('keeps every repository for an empty or whitespace-only query', () => {
    expect(filterRepositories(REPOS, '')).toEqual(REPOS);
    expect(filterRepositories(REPOS, '   ')).toEqual(REPOS);
  });

  it('matches the repository name regardless of case', () => {
    expect(filterRepositories(REPOS, 'docs').map((repo) => repo.id)).toEqual(['repo-3']);
    expect(filterRepositories(REPOS, 'BILLING').map((repo) => repo.id)).toEqual(['repo-2']);
  });

  it('matches the owner/repo form so a pasted full name finds the repository', () => {
    expect(filterRepositories(REPOS, 'acme/my').map((repo) => repo.id)).toEqual(['repo-1']);
  });

  it('matches the description when GitHub supplied one', () => {
    expect(filterRepositories(REPOS, 'stripe').map((repo) => repo.id)).toEqual(['repo-2']);
  });

  it('returns nothing when no repository matches', () => {
    expect(filterRepositories(REPOS, 'nope')).toEqual([]);
  });
});

describe('connectedApplicationsByRepo', () => {
  it('maps each connected repository to its application id', () => {
    const applications = [
      { id: 'app-1', repoFullName: 'acme/myapp' },
      { id: 'app-2', repoFullName: 'acme/billing-service' },
    ] as Application[];

    const connected = connectedApplicationsByRepo(applications);

    expect(connected.get('acme/myapp')).toBe('app-1');
    expect(connected.get('acme/billing-service')).toBe('app-2');
    expect(connected.has('acme/Docs-Site')).toBe(false);
  });
});
