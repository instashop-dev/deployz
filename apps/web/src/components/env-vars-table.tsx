import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildEnvVarRows,
  summarizeEnvVars,
  type EnvVarRow,
} from '@/lib/customer-install-resources';

/**
 * The customer-facing environment variables table. Read-only — the
 * customer does not edit env vars on the install page; values come
 * either from the deployz-managed bindings (visible as Ready) or from
 * the vendor's saved settings (also Ready). A row whose value is missing
 * renders as "Required" so the customer knows to ask the vendor.
 *
 * Secret values are never rendered. The status badge is the only signal
 * for the value's existence.
 */
export function EnvVarsTable({
  inputs,
  emptyState,
}: {
  inputs: ReadonlyArray<{
    key: string;
    required: boolean;
    secret: boolean;
    classification?: string;
    purpose?: string;
    label?: string;
  }>;
  /** Optional helper rendered when `inputs` is empty (no env vars exist). */
  emptyState?: ReactNode;
}) {
  const rows = buildEnvVarRows(inputs);
  const summary = summarizeEnvVars(rows);

  if (rows.length === 0) {
    if (!emptyState) return null;
    return (
      <section aria-labelledby="env-vars" className="flex flex-col gap-3">
        <h2 id="env-vars" className="text-base font-semibold">
          Environment variables
        </h2>
        {emptyState}
      </section>
    );
  }

  return (
    <section aria-labelledby="env-vars" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="env-vars" className="text-base font-semibold">
          Environment variables
        </h2>
        <p className="text-xs text-muted-foreground" data-testid="env-vars-summary">
          {summary.headline}
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border" data-testid="env-vars-table-wrapper">
        <Table data-testid="env-vars-table">
          <TableHeader>
            <TableRow>
              <TableHead>Variable</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <EnvVarTableRow key={row.key} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function EnvVarTableRow({ row }: { row: EnvVarRow }) {
  return (
    <TableRow data-testid={`env-var-row-${row.key}`}>
      <TableCell className="font-mono text-xs">{row.key}</TableCell>
      <TableCell className="text-muted-foreground">{row.purpose}</TableCell>
      <TableCell className="text-muted-foreground">{row.sourceLabel}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ status }: { status: EnvVarRow['status'] }) {
  switch (status) {
    case 'Required':
      return (
        <Badge variant="destructive" data-testid="env-var-status-required">
          Required
        </Badge>
      );
    case 'Ready':
      return (
        <Badge variant="secondary" data-testid="env-var-status-ready">
          Ready
        </Badge>
      );
    case 'Optional':
      return (
        <Badge variant="outline" data-testid="env-var-status-optional">
          Optional
        </Badge>
      );
  }
}