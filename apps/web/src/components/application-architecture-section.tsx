'use client';

import { TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PLAN_COMPONENT_GROUP_DISPLAY } from '@deployz/contracts';

import type {
  ApplicationArchitecture,
  ArchitectureNode,
  ArchitectureUnresolved,
  EditableReadinessField,
} from '@/lib/readiness';

const STATE_COPY: Record<ArchitectureNode['state'], string> = {
  detected: 'Detected automatically',
  confirmed: 'Confirmed',
};

interface ApplicationArchitectureSectionProps {
  architecture: ApplicationArchitecture;
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}

/**
 * Configuration tab section for the detected application architecture — one
 * card under the Services heading (ux-guidelines §8): unresolved questions
 * first, as action rows, then the detected/confirmed components. Reuses the
 * same edit/fix affordances as the deployment-configuration table.
 */
export function ApplicationArchitectureSection({
  architecture,
  onEdit,
  onShowFix,
}: ApplicationArchitectureSectionProps) {
  const hasContent =
    architecture.groups.length > 0 ||
    architecture.unresolved.length > 0 ||
    architecture.externalServices.length > 0;
  if (!hasContent) return null;

  return (
    <Card data-testid="application-architecture-section">
      <CardContent className="flex flex-col gap-4 py-4">
        {architecture.unresolved.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="architecture-config-unresolved">
            <ul className="flex flex-col gap-2">
              {architecture.unresolved.map((item, index) => (
                <UnresolvedQuestionCard
                  key={`${item.kind}-${index}`}
                  item={item}
                  index={index}
                  onEdit={onEdit}
                  onShowFix={onShowFix}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {architecture.groups.length > 0 ? (
          <ul className="flex flex-col gap-3" data-testid="architecture-config-groups">
            {architecture.groups.map((group) => (
              <li key={group.group} data-testid={`architecture-config-group-${group.group}`}>
                <p className="text-sm font-medium">
                  {PLAN_COMPONENT_GROUP_DISPLAY[group.group]}
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {group.nodes.map((node) => (
                    <li
                      key={`${group.group}-${node.label}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                      data-testid={`architecture-config-node-${group.group}-${node.label}`}
                    >
                      <span className="text-sm">{node.label}</span>
                      <Badge
                        variant={node.state === 'confirmed' ? 'success' : 'secondary'}
                        className="text-[10px]"
                      >
                        {STATE_COPY[node.state]}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}

        {architecture.externalServices.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="architecture-external-services">
            <p className="text-sm font-medium">External services</p>
            <p className="text-sm text-muted-foreground">
              {architecture.externalServices.join(', ')}. Your application connects to these directly. If it
              uses them, choose who provides their keys (you or your customer) under Environment variables.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UnresolvedQuestionCard({
  item,
  index,
  onEdit,
  onShowFix,
}: {
  item: ArchitectureUnresolved;
  index: number;
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}) {
  const action = unresolvedAction(item.kind);

  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
      data-testid={`architecture-unresolved-card-${item.kind}-${index}`}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="destructive" className="text-[10px]">
              Needs input
            </Badge>
            {item.blocking ? (
              <Badge variant="outline" className="text-[10px]">
                Blocking
              </Badge>
            ) : null}
          </div>
          <p className="text-sm">{item.question}</p>
        </div>
      </div>
      {action.kind === 'edit' ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onEdit(action.field)}
          data-testid={`architecture-unresolved-edit-${item.kind}-${index}`}
        >
          Edit
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onShowFix}
          data-testid={`architecture-unresolved-fix-${item.kind}-${index}`}
        >
          Get fix instructions
        </Button>
      )}
    </li>
  );
}

function unresolvedAction(
  kind: string,
): { kind: 'edit'; field: EditableReadinessField } | { kind: 'fix' } {
  if (kind === 'port') return { kind: 'edit', field: 'containerPort' };
  return { kind: 'fix' };
}
