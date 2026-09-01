'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { generateFixInstructions, type FixInstructions } from '@/lib/readiness';

// Fix-instructions dialog — generates the consolidated coding-agent prompt
// for the unresolved readiness findings and hands it to the vendor to paste
// into their own coding agent. Deployz never changes the repository: the
// dialog says so, and the only follow-up action is re-running the analysis
// once the agent's changes are pushed. Generation failures are retryable and
// never affect the readiness result behind the dialog.

type GenerationState =
  | { status: 'generating' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: FixInstructions };

export function FixInstructionsDialog({
  open,
  applicationId,
  onClose,
  onReanalyse,
}: {
  open: boolean;
  applicationId: string;
  onClose: () => void;
  /** Triggers a re-analysis (same action as the Re-analyse button). */
  onReanalyse: () => void;
}) {
  const [state, setState] = useState<GenerationState>({ status: 'generating' });

  const generate = useCallback(() => {
    setState({ status: 'generating' });
    generateFixInstructions(applicationId)
      .then((result) => setState({ status: 'done', result }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : "We couldn't generate the instructions right now. Try again in a moment.",
        }),
      );
  }, [applicationId]);

  // Generate on open; regenerate starts fresh each time the dialog reopens so
  // the instructions always reflect the current analysis.
  useEffect(() => {
    if (open) generate();
  }, [open, generate]);

  async function handleCopy(): Promise<void> {
    if (state.status !== 'done') return;
    try {
      await navigator.clipboard.writeText(state.result.instructions);
      toast.success('Instructions copied. Paste them into your coding agent.');
    } catch {
      toast.error("We couldn't copy automatically — select the text and copy it manually.");
    }
  }

  function handleReanalyse(): void {
    onReanalyse();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent data-testid="fix-instructions-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fix instructions for your coding agent</DialogTitle>
          <DialogDescription>
            Paste these instructions into your coding agent — Claude Code, Cursor, Codex, OpenCode,
            or similar. Deployz doesn&apos;t change your repository; your agent makes the changes.
          </DialogDescription>
        </DialogHeader>

        {state.status === 'generating' ? (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            Generating instructions from the analysis…
          </p>
        ) : null}

        {state.status === 'error' ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p role="alert" data-testid="fix-instructions-error" className="text-sm text-destructive">
              {state.message}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="fix-instructions-retry"
              onClick={generate}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {state.status === 'done' ? (
          <div className="flex min-h-0 flex-col gap-3">
            <pre
              data-testid="fix-instructions-content"
              className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted px-3 py-2.5 font-mono text-xs"
            >
              {state.result.instructions}
            </pre>
            <p className="text-sm text-muted-foreground">
              After your coding agent has made and pushed the changes, re-run the analysis —
              Deployz verifies the repository itself and never takes the agent&apos;s word for it.
            </p>
          </div>
        ) : null}

        {state.status === 'done' ? (
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fix-instructions-regenerate"
                onClick={generate}
              >
                Regenerate
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="fix-instructions-reanalyse"
                onClick={handleReanalyse}
              >
                Re-analyse application
              </Button>
            </div>
            <Button type="button" data-testid="fix-instructions-copy" onClick={handleCopy}>
              Copy instructions
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
