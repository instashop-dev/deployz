import type { ReactNode } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

// §45 "infrastructure diagram" — a clean semantic diagram (not an image file)
// of the §11 standard customer architecture. Plain divs + Tailwind so it
// follows the app's existing light/dark theme tokens automatically. The
// optional services (Database, Cache, Storage) render only when the
// deployment's plan includes them — the diagram never guesses infrastructure
// the manifest doesn't ask for.
export function ArchitectureDiagram({ plan }: { plan: DeploymentPlan }) {
  const includes = (kind: 'database' | 'cache' | 'storage'): boolean =>
    plan.components.some((component) => component.kind === kind) ||
    plan.awsResources.some((resource) => resource.id === kind);

  return (
    <figure aria-label="Deployz standard customer architecture diagram" className="not-prose">
      <div className="rounded-xl border-2 border-dashed p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your AWS account
        </p>
        <div className="mt-3 flex flex-col items-center gap-2">
          <DiagramBox>Load Balancer</DiagramBox>
          <Arrow />
          <DiagramBox>Application container</DiagramBox>
          <Arrow />
          <div className="flex flex-wrap items-center justify-center gap-3">
            {includes('database') ? <DiagramBox small>Database</DiagramBox> : null}
            {includes('cache') ? <DiagramBox small>Cache</DiagramBox> : null}
            {includes('storage') ? <DiagramBox small>Storage</DiagramBox> : null}
            <DiagramBox small>Secrets</DiagramBox>
            <DiagramBox small>Monitoring</DiagramBox>
          </div>
          <Arrow />
          <DiagramBox emphasis>Deployz Relay</DiagramBox>
        </div>
      </div>
      <div className="mt-2 flex flex-col items-center gap-1 text-center">
        <p className="text-xs text-muted-foreground">HTTPS outbound only — nothing calls in</p>
        <Arrow />
        <DiagramBox emphasis>Deployz Control Plane</DiagramBox>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        The relay only calls out. Nothing — including Deployz — connects inward.
      </figcaption>
    </figure>
  );
}

function DiagramBox({
  children,
  small,
  emphasis,
}: {
  children: ReactNode;
  small?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-center font-medium ${
        small ? 'text-xs' : 'text-sm'
      } ${emphasis ? 'border-primary bg-primary/5' : 'bg-muted'}`}
    >
      {children}
    </div>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="text-muted-foreground">
      ↓
    </span>
  );
}
