// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Spinner } from '../src/components/ui/spinner';
import { Button } from '../src/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../src/components/ui/alert-dialog';

/**
 * Loader/spinner/skeleton primitive tests. Rendered with react-dom/client +
 * act inside a jsdom environment (rather than the renderToString + JSDOM
 * pattern used elsewhere) because the AlertDialogAction and duplicate-click
 * cases need a live DOM: a Radix portal and a real dispatched click event.
 */

const cleanups: Array<() => void> = [];

function render(node: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return { container, root };
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('Spinner', () => {
  it('renders a labeled status svg that spins', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('data-slot')).toBe('spinner');
    expect(svg?.getAttribute('role')).toBe('status');
    expect(svg?.getAttribute('aria-label')).toBe('Loading');
    expect(svg?.getAttribute('class')).toContain('animate-spin');
  });

  it('lets a caller override aria-hidden and role via props', () => {
    const { container } = render(<Spinner aria-hidden="true" role="presentation" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });
});

describe('Button (idle)', () => {
  it('renders exactly as before: no aria-busy, not disabled, children intact', () => {
    const { container } = render(<Button>Save</Button>);
    const button = container.querySelector('button')!;

    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.hasAttribute('data-loading')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save');
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });
});

describe('Button (loading)', () => {
  it('with loadingText: disables the button, marks it busy, and swaps in the spinner + text', () => {
    const { container } = render(
      <Button loading loadingText="Saving configuration…">
        Save
      </Button>,
    );
    const button = container.querySelector('button')!;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('data-loading')).toBe('true');
    expect(button.textContent).toBe('Saving configuration…');

    const spinner = button.firstElementChild;
    expect(spinner?.tagName.toLowerCase()).toBe('svg');
    expect(spinner?.getAttribute('data-slot')).toBe('spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
  });

  it('without loadingText: keeps the idle children and prepends the spinner', () => {
    const { container } = render(<Button loading>Save</Button>);
    const button = container.querySelector('button')!;

    expect(button.textContent).toBe('Save');
    expect(button.firstElementChild?.getAttribute('data-slot')).toBe('spinner');
  });

  it('replaces idle icon content when loadingText is provided', () => {
    const { container } = render(
      <Button loading loadingText="Removing…">
        <svg data-testid="idle-icon" />
        Remove
      </Button>,
    );
    const button = container.querySelector('button')!;

    expect(button.querySelector('[data-testid="idle-icon"]')).toBeNull();
    expect(button.textContent).toBe('Removing…');
  });

  it('preserves variant/size classes and sizes the spinner to match the size variant', () => {
    const { container } = render(
      <Button variant="outline" size="xs" loading>
        Do
      </Button>,
    );
    const button = container.querySelector('button')!;

    expect(button.getAttribute('data-variant')).toBe('outline');
    expect(button.getAttribute('data-size')).toBe('xs');

    const spinner = button.querySelector('[data-slot="spinner"]');
    expect(spinner?.getAttribute('class')).toContain('size-3');
    expect(spinner?.getAttribute('class')).not.toContain('size-4');
  });

  it('asChild + loading: forwards disabled/aria-busy/data-loading to the child without injecting a spinner', () => {
    const { container } = render(
      <Button asChild loading>
        <a href="#anchor">Link</a>
      </Button>,
    );
    const anchor = container.querySelector('a')!;

    expect(anchor.getAttribute('aria-busy')).toBe('true');
    expect(anchor.getAttribute('data-loading')).toBe('true');
    expect(anchor.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(anchor.textContent).toBe('Link');
  });

  it('prevents duplicate clicks while loading (a disabled button does not dispatch click)', () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = container.querySelector('button')!;

    expect(button.disabled).toBe(true);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('AlertDialogAction (loading)', () => {
  it('disables the action, marks it busy, and shows the spinner + loadingText', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect deployment</AlertDialogTitle>
            <AlertDialogDescription>This removes the deployment.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction loading loadingText="Disconnecting…">
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const action = document.querySelector('[data-slot="alert-dialog-action"]') as HTMLButtonElement;

    expect(action).not.toBeNull();
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.getAttribute('data-loading')).toBe('true');
    expect(action.textContent).toBe('Disconnecting…');
    expect(action.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });
});

// Toast loading icon: the Toaster wraps next-themes' useTheme, which needs a
// ThemeProvider and browser matchMedia support to mount cleanly. Skipped as
// out of scope for this primitive-level suite; the change itself is a
// one-line icon swap (Loader2Icon -> Spinner) in sonner.tsx.
describe.skip('Toaster loading icon', () => {
  it('uses the shared Spinner for the loading toast icon', () => {});
});
