// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ListSearchInput, NoMatchesState, SortableHead } from '../src/components/list-controls';
import { Table, TableHeader, TableRow } from '../src/components/ui/table';

const cleanups: Array<() => void> = [];

function render(node: React.ReactElement): { container: HTMLElement; rerender: (n: React.ReactElement) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, rerender: (next) => act(() => root.render(next)) };
}

// React tracks an input's value itself, so a plain `input.value = …` is
// ignored; the native setter plus an `input` event is what a keystroke does.
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('ListSearchInput', () => {
  const search = (container: HTMLElement) => container.querySelector('input') as HTMLInputElement;

  it('shows typing at once but writes to the URL only after a pause', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <ListSearchInput value="" onCommit={onCommit} placeholder="Search" label="Search things" />,
    );
    type(search(container), 'acme');
    expect(search(container).value).toBe('acme');
    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('acme');
  });

  it('commits only the last value of a burst of keystrokes', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <ListSearchInput value="" onCommit={onCommit} placeholder="Search" label="Search things" />,
    );
    type(search(container), 'a');
    act(() => vi.advanceTimersByTime(100));
    type(search(container), 'ac');
    act(() => vi.advanceTimersByTime(100));
    type(search(container), 'acm');
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('acm');
  });

  it('does not overwrite text typed while the URL catches up to an earlier keystroke', () => {
    const onCommit = vi.fn();
    const ui = (value: string) => (
      <ListSearchInput value={value} onCommit={onCommit} placeholder="Search" label="Search things" />
    );
    const { container, rerender } = render(ui(''));
    type(search(container), 'a');
    act(() => vi.advanceTimersByTime(300));
    type(search(container), 'ab');
    // The URL now reports the first commit while "ab" is still pending.
    rerender(ui('a'));
    expect(search(container).value).toBe('ab');
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenLastCalledWith('ab');
  });

  it('follows a change that did not come from typing, such as Clear filters or Back', () => {
    const onCommit = vi.fn();
    const ui = (value: string) => (
      <ListSearchInput value={value} onCommit={onCommit} placeholder="Search" label="Search things" />
    );
    const { container, rerender } = render(ui('acme'));
    expect(search(container).value).toBe('acme');
    rerender(ui(''));
    expect(search(container).value).toBe('');
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('is labelled for assistive technology', () => {
    const { container } = render(
      <ListSearchInput value="" onCommit={() => {}} placeholder="Search" label="Search things" />,
    );
    expect(container.querySelector('input[aria-label="Search things"]')).not.toBeNull();
  });
});

describe('SortableHead', () => {
  function header(direction: 'asc' | 'desc' | null, onSort = vi.fn()) {
    return render(
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Customer" direction={direction} onSort={onSort} />
          </TableRow>
        </TableHeader>
      </Table>,
    );
  }

  it.each([
    ['asc', 'ascending'],
    ['desc', 'descending'],
  ] as const)('announces %s as aria-sort="%s"', (direction, expected) => {
    const { container } = header(direction);
    expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe(expected);
  });

  it('announces nothing for a column that is not the sort', () => {
    const { container } = header(null);
    expect(container.querySelector('th')?.hasAttribute('aria-sort')).toBe(false);
  });

  it('sorts when its button is activated', () => {
    const onSort = vi.fn();
    const { container } = header(null, onSort);
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Customer');
    act(() => button.click());
    expect(onSort).toHaveBeenCalledOnce();
  });
});

describe('NoMatchesState', () => {
  it('explains the empty result and offers to clear the filters', () => {
    const onClear = vi.fn();
    const { container } = render(<NoMatchesState heading="No deployments match these filters." onClear={onClear} />);
    expect(container.querySelector('h2')?.textContent).toBe('No deployments match these filters.');
    expect(container.textContent).toContain('Try changing your search or clearing the filters.');
    act(() => container.querySelector('button')!.click());
    expect(onClear).toHaveBeenCalledOnce();
  });
});
