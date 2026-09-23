// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentSettingsResponse } from '../src/lib/environment-settings';
import type { MaskedConfigEntry } from '../src/lib/config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select/Collapsible measure and scroll elements jsdom does not
// implement; none of that matters for these assertions.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// The Configuration page's "Environment variables" section (docs/environment-variables.md):
// summary counts, sort order, search/collapse, bulk classification, the
// provider-select constraints (customer disallowed at build stage, Deployz
// only for a providable key), the vendor runtime-secret warning, the
// customer-facing preview, the needsReentry warning, and the save order
// (settings, then values — never analysis).

const mocks = vi.hoisted(() => ({
  fetchEnvironmentSettings: vi.fn(),
  saveEnvironmentSettings: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../src/lib/environment-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/environment-settings')>();
  return {
    ...actual,
    fetchEnvironmentSettings: mocks.fetchEnvironmentSettings,
    saveEnvironmentSettings: mocks.saveEnvironmentSettings,
  };
});

vi.mock('../src/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config')>();
  return { ...actual, saveConfig: mocks.saveConfig };
});

const { EnvironmentVariablesSection } = await import(
  '../src/app/dashboard/applications/[id]/config/environment-variables-section'
);

function response(overrides: Partial<EnvironmentSettingsResponse> = {}): EnvironmentSettingsResponse {
  return {
    settings: null,
    variables: [
      {
        key: 'DATABASE_URL',
        required: true,
        secret: false,
        source: ['read in app.py'],
        classification: 'customer_required',
      },
      {
        key: 'API_KEY',
        required: true,
        secret: true,
        source: ['read in app.py'],
      },
      {
        key: 'LOG_LEVEL',
        required: false,
        secret: false,
        source: ['read with a default'],
        classification: 'optional',
      },
      {
        key: 'INTERNAL_SECRET',
        required: true,
        secret: true,
        source: ['generated'],
        classification: 'deployz_generated',
      },
      {
        key: 'NEXT_PUBLIC_ANALYTICS_ID',
        required: false,
        secret: false,
        source: ['.env.example'],
        classification: 'optional',
      },
    ],
    deployzKeys: ['INTERNAL_SECRET'],
    vendorValueKeys: [],
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

function byTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('element not found');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
  });
}

async function setValue(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('element not found');
  // React tracks <input> value through the native setter, not a plain
  // property assignment — bypass its tracking so the dispatched 'input'
  // event is seen as a real change (same trick create-deployment-page.test
  // and friends do not need because they type via user-event; here there is
  // no such helper, so this replicates it directly).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchEnvironmentSettings.mockResolvedValue(response());
  mocks.saveEnvironmentSettings.mockImplementation(async (_id, settings) => response({ settings }));
  mocks.saveConfig.mockResolvedValue({
    applicationId: 'app-1',
    customerId: null,
    customerName: null,
    vendorDefaults: [],
    customerOverrides: [],
    effective: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function renderSection(vendorDefaults: MaskedConfigEntry[] = []): Promise<void> {
  await act(async () => {
    root.render(
      <EnvironmentVariablesSection
        applicationId="app-1"
        vendorDefaults={vendorDefaults}
        onValuesSaved={() => {}}
      />,
    );
  });
  // Flush the fetch effect.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Environment variables section', () => {
  it('shows the summary counts and lists unresolved required rows first', async () => {
    await renderSection();

    const summary = byTestId('environment-variables-summary')?.textContent ?? '';
    expect(summary).toContain('2 need');
    expect(summary).toContain('decision');
    expect(summary).toContain('managed by Deployz');

    const rows = Array.from(document.querySelectorAll('[data-testid^="environment-variable-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // DATABASE_URL and API_KEY (needs-decision) come before INTERNAL_SECRET (ready).
    expect(rows.indexOf('environment-variable-row-DATABASE_URL')).toBeLessThan(
      rows.indexOf('environment-variable-row-INTERNAL_SECRET'),
    );
    expect(rows.indexOf('environment-variable-row-API_KEY')).toBeLessThan(
      rows.indexOf('environment-variable-row-INTERNAL_SECRET'),
    );
  });

  it('collapses optional rows by default and search filters by key', async () => {
    await renderSection();

    expect(byTestId('environment-variable-row-LOG_LEVEL')).toBeNull();
    await click(byTestId('environment-variables-optional')?.querySelector('[data-slot="collapsible-trigger"]') ?? null);
    expect(byTestId('environment-variable-row-LOG_LEVEL')).not.toBeNull();

    const search = byTestId('environment-variables-search');
    await setValue(search, 'DATABASE');
    expect(byTestId('environment-variable-row-DATABASE_URL')).not.toBeNull();
    expect(byTestId('environment-variable-row-API_KEY')).toBeNull();
  });

  it('bulk-marks selected rows optional and saves them with provider none', async () => {
    await renderSection();

    const checkbox = byTestId('environment-variable-row-DATABASE_URL')?.querySelector('input[type="checkbox"]');
    await click(checkbox ?? null);
    await click(byTestId('environment-variables-bulk-optional'));

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    expect(mocks.saveEnvironmentSettings).toHaveBeenCalledTimes(1);
    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [
      string,
      { key: string; provider: string; required: boolean }[],
    ];
    const saved = settings.find((s) => s.key === 'DATABASE_URL');
    expect(saved?.provider).toBe('none');
    expect(saved?.required).toBe(false);
  });

  it('never triggers analysis and saves settings before values', async () => {
    await renderSection();

    const checkbox = byTestId('environment-variable-row-DATABASE_URL')?.querySelector('input[type="checkbox"]');
    await click(checkbox ?? null);
    await click(byTestId('environment-variables-bulk-optional'));

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    expect(mocks.saveEnvironmentSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveConfig.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('disables the customer provider option for a build-stage variable', async () => {
    await renderSection();
    await click(byTestId('environment-variables-optional')?.querySelector('[data-slot="collapsible-trigger"]') ?? null);

    const trigger = byTestId('environment-variable-NEXT_PUBLIC_ANALYTICS_ID-provider');
    await click(trigger);
    const customerItem = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === 'Set by customer',
    );
    expect(customerItem?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('disables the Deployz provider option for a key Deployz cannot provide', async () => {
    await renderSection();

    const trigger = byTestId('environment-variable-DATABASE_URL-provider');
    await click(trigger);
    const deployzItem = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === 'Managed by Deployz',
    );
    expect(deployzItem?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('shows the vendor runtime-secret warning for a vendor-provided runtime secret', async () => {
    const withSetting = response({
      settings: [
        { key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'vendor' },
      ],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection();

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    expect(byTestId('environment-variable-runtime-warning-API_KEY')).not.toBeNull();
  });

  it('shows a label and key in the customer field preview', async () => {
    const withSetting = response({
      settings: [{ key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer', label: 'API key' }],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection();

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    const preview = byTestId('environment-variable-customer-preview-API_KEY');
    expect(preview?.textContent).toContain('API key');
    expect(preview?.textContent).toContain('API_KEY');
  });

  it('shows a re-enter warning for a vendor secret flagged needsReentry', async () => {
    const withSetting = response({
      settings: [{ key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'vendor' }],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection([{ key: 'API_KEY', isSecret: true, value: null, needsReentry: true }]);

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    expect(byTestId('environment-variable-reentry-API_KEY')).not.toBeNull();
  });
});
