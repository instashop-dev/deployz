'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { commitsErrorMessage, fetchCommits, resolveCommit, type Commit } from '@/lib/commits';
import { alreadyReleasedVersions, type Release } from '@/lib/releases';
import { cn } from '@/lib/utils';

/** Matches the manual-SHA validation the API applies (§ commit-selector contract). */
const MANUAL_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

type CommitsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; commits: Commit[]; branch: string; nextPage: number | null };

export interface CommitPickerHandle {
  /**
   * Resolves the field's current selection to the full 40-char SHA to
   * submit, running the manual-mode GitHub lookup at call time. Returns
   * null when the field cannot submit yet (no selection, or an unresolved/
   * invalid manual value) — the caller should not proceed.
   */
  resolveGitSha(): Promise<string | null>;
}

function formatCommitDate(committedAt: string | null): string | null {
  if (!committedAt) return null;
  return new Date(committedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The New release form's commit field: a searchable combobox of the
 * application's default-branch commits (Popover + Command, same
 * composition as CustomerPicker), with a manual-SHA fallback so a GitHub
 * outage never blocks creating a release. Fetching, pagination and the
 * manual lookup all live here; the parent form only reads the resolved SHA
 * via `resolveGitSha()` at submit time.
 */
export const CommitPicker = forwardRef<
  CommitPickerHandle,
  {
    applicationId: string;
    releases: readonly Release[];
    /** The application's configured branch, shown before (or instead of) a
     *  successful commits response — e.g. in the error state. */
    defaultBranch?: string | null;
    disabled?: boolean;
    /** Called whenever the field can (or can no longer) be submitted, so the
     *  form's submit button can reflect it. Manual mode is always "ready" —
     *  its validation happens at submit time, in `resolveGitSha`. */
    onReadyChange?: (ready: boolean) => void;
  }
>(function CommitPicker({ applicationId, releases, defaultBranch = null, disabled = false, onReadyChange }, ref) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CommitsState>({ status: 'loading' });
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [mode, setMode] = useState<'picker' | 'manual'>('picker');
  const [manualValue, setManualValue] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const preselectedRef = useRef(false);

  async function load(): Promise<void> {
    setState({ status: 'loading' });
    try {
      const page = await fetchCommits(applicationId, 1);
      if (page.commits.length === 0) {
        setState({ status: 'empty' });
        return;
      }
      setState({ status: 'loaded', commits: page.commits, branch: page.branch, nextPage: page.nextPage });
      const newest = page.commits[0];
      if (!preselectedRef.current && newest) {
        preselectedRef.current = true;
        setSelectedSha((current) => current ?? newest.sha);
      }
    } catch (error) {
      setState({ status: 'error', message: commitsErrorMessage(error, defaultBranch ?? '') });
    }
  }

  useEffect(() => {
    void load();
    // Refetches only when the application changes; `load` is stable enough
    // for this form's lifetime (it closes over applicationId directly).
  }, [applicationId]);

  useEffect(() => {
    onReadyChange?.(mode === 'manual' || (state.status === 'loaded' && selectedSha !== null));
  }, [mode, state.status, selectedSha, onReadyChange]);

  async function loadMore(): Promise<void> {
    if (state.status !== 'loaded' || state.nextPage === null) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchCommits(applicationId, state.nextPage);
      setState({
        status: 'loaded',
        commits: [...state.commits, ...page.commits],
        branch: page.branch,
        nextPage: page.nextPage,
      });
    } catch (error) {
      setLoadMoreError(commitsErrorMessage(error, state.branch));
    } finally {
      setLoadingMore(false);
    }
  }

  useImperativeHandle(ref, () => ({
    async resolveGitSha(): Promise<string | null> {
      if (mode === 'picker') {
        return selectedSha;
      }
      const typed = manualValue.trim().toLowerCase();
      if (!MANUAL_SHA_PATTERN.test(typed)) {
        setManualError('Enter 7 to 40 hexadecimal characters.');
        return null;
      }
      setManualError(null);
      setResolving(true);
      try {
        const commit = await resolveCommit(applicationId, typed);
        return commit.sha;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
          const code = (error as { code?: string }).code;
          if (code === 'COMMIT_NOT_FOUND') {
            setManualError("This commit doesn't exist in the repository.");
            return null;
          }
          if (code === 'INVALID_COMMIT_SHA') {
            setManualError('Enter 7 to 40 hexadecimal characters.');
            return null;
          }
        }
        // GitHub itself is unavailable/unreachable — never let that block
        // release creation when the vendor typed the full SHA already.
        if (FULL_SHA_PATTERN.test(typed)) {
          return typed;
        }
        setManualError("GitHub is unavailable, so we can't check a short SHA. Enter the full 40-character SHA.");
        return null;
      } finally {
        setResolving(false);
      }
    },
  }));

  const branch = state.status === 'loaded' ? state.branch : defaultBranch;
  const selectedCommit =
    state.status === 'loaded' ? state.commits.find((commit) => commit.sha === selectedSha) : undefined;
  const alreadyReleased = alreadyReleasedVersions(
    releases,
    mode === 'picker' ? (selectedSha ?? '') : manualValue,
  );

  if (mode === 'manual') {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor="gitShaManual">Commit SHA</Label>
        <Input
          id="gitShaManual"
          name="gitShaManual"
          placeholder="a1b2c3d"
          className="font-mono"
          disabled={disabled}
          value={manualValue}
          onChange={(event) => {
            setManualValue(event.target.value);
            setManualError(null);
          }}
        />
        {manualError ? (
          <p role="alert" className="text-sm text-destructive">
            {manualError}
          </p>
        ) : alreadyReleased.length > 0 ? (
          <p className="text-xs text-muted-foreground">Already released as {alreadyReleased.join(', ')}</p>
        ) : null}
        {resolving ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner aria-hidden className="size-3" /> Checking commit…
          </p>
        ) : null}
        <Button
          type="button"
          variant="link"
          className="h-auto w-fit p-0 text-xs"
          onClick={() => {
            setMode('picker');
            setManualError(null);
          }}
        >
          Choose from recent commits
        </Button>
      </div>
    );
  }

  const loading = state.status === 'loading';
  const triggerLabel = loading
    ? 'Loading commits…'
    : selectedCommit
      ? selectedCommit.title
      : 'Select a commit…';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="commit-picker-trigger">Commit</Label>
        {branch ? <span className="text-xs text-muted-foreground">Commits from {branch}</span> : null}
      </div>

      {state.status === 'empty' ? (
        <p className="text-sm text-muted-foreground">This branch has no commits yet.</p>
      ) : state.status === 'error' ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            <span>{state.message}</span>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id="commit-picker-trigger"
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled || loading}
              className="w-full justify-between font-normal"
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {selectedCommit ? (
                  <span className="shrink-0 font-mono text-xs">{selectedCommit.shortSha}</span>
                ) : null}
                {selectedCommit ? <span aria-hidden>·</span> : null}
                <span className="truncate">{triggerLabel}</span>
              </span>
              <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
            <Command
              filter={(value, search, keywords) => {
                const haystack = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase();
                return haystack.includes(search.toLowerCase()) ? 1 : 0;
              }}
            >
              <CommandInput placeholder="Search commits…" />
              <CommandList>
                <CommandEmpty>No commits found.</CommandEmpty>
                <CommandGroup>
                  {state.status === 'loaded'
                    ? state.commits.map((commit) => {
                        const date = formatCommitDate(commit.committedAt);
                        const releasedVersions = alreadyReleasedVersions(releases, commit.sha);
                        return (
                          <CommandItem
                            key={commit.sha}
                            value={commit.sha}
                            keywords={[commit.shortSha, commit.sha, commit.title]}
                            onSelect={() => {
                              setSelectedSha(commit.sha);
                              setOpen(false);
                            }}
                          >
                            <Check
                              aria-hidden
                              className={cn('size-4', commit.sha === selectedSha ? 'opacity-100' : 'opacity-0')}
                            />
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate">
                                <span className="font-mono">{commit.shortSha}</span> · {commit.title}
                              </span>
                              <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                                {[date, commit.authorName].filter(Boolean).join(' · ')}
                                {releasedVersions.length > 0 ? (
                                  <Badge variant="secondary">{releasedVersions[0]}</Badge>
                                ) : null}
                              </span>
                            </div>
                          </CommandItem>
                        );
                      })
                    : null}
                  {state.status === 'loaded' && state.nextPage !== null ? (
                    <CommandItem
                      value="load-more-commits"
                      disabled={loadingMore}
                      onSelect={() => void loadMore()}
                      className="justify-center text-muted-foreground"
                    >
                      {loadingMore ? (
                        <>
                          <Spinner aria-hidden className="size-3.5" /> Loading…
                        </>
                      ) : (
                        'Load more commits'
                      )}
                    </CommandItem>
                  ) : null}
                </CommandGroup>
              </CommandList>
            </Command>
            {loadMoreError ? (
              <div className="border-t p-2">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col gap-2">
                    <span>{loadMoreError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={() => void loadMore()}
                    >
                      Retry
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      )}

      {state.status === 'loaded' && alreadyReleased.length > 0 ? (
        <p className="text-xs text-muted-foreground">Already released as {alreadyReleased.join(', ')}</p>
      ) : null}

      <Button
        type="button"
        variant="link"
        className="h-auto w-fit p-0 text-xs"
        onClick={() => {
          setMode('manual');
          setManualValue('');
        }}
      >
        Enter commit SHA manually
      </Button>
    </div>
  );
});
