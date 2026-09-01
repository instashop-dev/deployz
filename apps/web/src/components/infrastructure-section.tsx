'use client';

import { AlertTriangle, ChevronDown } from 'lucide-react';
import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { InfrastructureComponent, InfrastructureResponse } from '@/lib/deployments';
import {
  INFRASTRUCTURE_COMPONENT_NAME,
  INFRASTRUCTURE_COMPONENT_PURPOSE,
  INFRASTRUCTURE_LIFECYCLE_LABEL,
  INFRASTRUCTURE_STATUS_BADGE,
  INFRASTRUCTURE_STATUS_LABEL,
  INFRASTRUCTURE_SUMMARY_STATUS_BADGE,
  INFRASTRUCTURE_SUMMARY_STATUS_LABEL,
} from '@/lib/deployment-vocabulary';

interface InfrastructureSectionProps {
  data: InfrastructureResponse | null;
  deploymentId: string;
  deploymentState?: string;
}

export function InfrastructureSection({
  data,
  deploymentId,
  deploymentState,
}: InfrastructureSectionProps) {
  if (data === null) {
    return <InfrastructureSkeleton />;
  }

  const headerTitle = deploymentState === 'DELETED' ? 'Deployment removed' : `AWS · ${data.region}`;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{headerTitle}</CardTitle>
            <CardDescription>
              {data.summary.componentCount} component{data.summary.componentCount === 1 ? '' : 's'}
            </CardDescription>
          </div>
          {data.stackStatus ? (
            <span className="text-xs text-muted-foreground">
              Stack status: {data.stackStatus}
            </span>
          ) : null}
        </div>
        <Badge variant={INFRASTRUCTURE_SUMMARY_STATUS_BADGE[data.summary.status]}>
          {INFRASTRUCTURE_SUMMARY_STATUS_LABEL[data.summary.status]}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.snapshotState === 'none' ? (
          <p className="text-sm text-muted-foreground">
            Infrastructure details will appear as AWS resources are created.
          </p>
        ) : (
          <>
            {data.connectionState === 'disconnected' ? (
              <Alert>
                <AlertTriangle aria-hidden />
                <AlertTitle>AWS connection unavailable</AlertTitle>
                <AlertDescription>
                  Showing infrastructure last verified at{' '}
                  {data.disconnectWarning?.lastVerifiedAt
                    ? new Date(data.disconnectWarning.lastVerifiedAt).toLocaleString('en-US')
                    : 'an unknown time'}
                  .
                </AlertDescription>
              </Alert>
            ) : null}
            <ul className="flex flex-col gap-3">
              {data.components.map((component) => (
                <ComponentRow
                  key={component.kind}
                  component={component}
                  deploymentId={deploymentId}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ComponentRow({
  component,
  deploymentId,
}: {
  component: InfrastructureComponent;
  deploymentId: string;
}) {
  const failingReason = firstFailingReason(component);

  return (
    <li className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            {INFRASTRUCTURE_COMPONENT_NAME[component.kind] ?? component.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {INFRASTRUCTURE_COMPONENT_PURPOSE[component.kind] ?? component.purpose}
          </span>
        </div>
        <Badge variant={INFRASTRUCTURE_STATUS_BADGE[component.status]}>
          {INFRASTRUCTURE_STATUS_LABEL[component.status]}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{component.awsService}</span>
        <span>{component.region}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {INFRASTRUCTURE_LIFECYCLE_LABEL[component.lifecycle]}
      </p>
      {component.status === 'failed' ? (
        <div className="flex flex-col gap-2">
          {failingReason ? (
            <p className="text-xs text-destructive">{failingReason}</p>
          ) : null}
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href={`/dashboard/deployments/${deploymentId}/diagnostics`}>
              View diagnostics
            </Link>
          </Button>
        </div>
      ) : null}
      {component.resources.length > 0 ? (
        <TechnicalDisclosure component={component} />
      ) : null}
    </li>
  );
}

function TechnicalDisclosure({ component }: { component: InfrastructureComponent }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground">
        View {component.resources.length} technical AWS resource
        {component.resources.length === 1 ? '' : 's'}
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col gap-2">
          {component.resources.map((resource) => (
            <li
              key={resource.logicalId}
              className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{resource.logicalId}</span>
                <Badge variant="secondary">{resource.status}</Badge>
              </div>
              <span className="text-muted-foreground">{resource.type}</span>
              {resource.physicalId ? (
                <span className="truncate text-muted-foreground">{resource.physicalId}</span>
              ) : null}
              {resource.statusReason ? (
                <span className="text-destructive">{resource.statusReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InfrastructureSkeleton() {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

function firstFailingReason(component: InfrastructureComponent): string | null {
  const failing = component.resources.find((resource) => resource.statusReason !== null);
  return failing?.statusReason ?? null;
}
