import type { ReactNode } from 'react';

import type { DeploymentPlan, FootprintWorkload } from '@deployz/contracts';

// §45 "infrastructure diagram" — a clean semantic diagram (not an image file)
// of the §11 customer architecture, rendered from the plan's deployment
// footprint: one box per workload (the web workload is the only public entry
// point; every worker is internal), and a box per managed resource the plan
// includes. Plain divs + Tailwind so it follows the app's existing light/dark
// theme tokens automatically. Plans saved before footprints fell back to the
// catalog components — the diagram never guesses infrastructure the plan
// doesn't ask for.
export function ArchitectureDiagram({ plan }: { plan: DeploymentPlan }) {
  const footprint = plan.footprint ?? null;
  const workloads = footprint !== null && footprint.workloads.length > 0 ? footprint.workloads : null;
  const resourceBoxes = footprint
    ? footprint.resources
        // Networking (the load balancer, the NAT gateway) is drawn by the
        // diagram itself — the public box and the account boundary.
        .filter((resource) => resource.category !== 'network')
        .map((resource) => ({ id: resource.id, label: resource.label }))
    : legacyResourceBoxes(plan);

  return (
    <figure aria-label="Deployz standard customer architecture diagram" className="not-prose">
      <div className="rounded-xl border-2 border-dashed p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your AWS account
        </p>
        <div className="mt-3 flex flex-col items-center gap-2">
          <DiagramBox>Load Balancer</DiagramBox>
          <Arrow />
          <div className="flex flex-wrap items-stretch justify-center gap-2" data-testid="diagram-workloads">
            {workloads ? (
              workloads.map((workload) => <WorkloadBox key={workload.id} workload={workload} />)
            ) : (
              <DiagramBox>Application container</DiagramBox>
            )}
          </div>
          <Arrow />
          <div className="flex flex-wrap items-center justify-center gap-3" data-testid="diagram-resources">
            {resourceBoxes.map((box) => (
              <DiagramBox key={box.id} small>
                {box.label}
              </DiagramBox>
            ))}
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

/** One box per workload: the web workload is the deployment's only public
 *  entry point (emphasized); every other role is drawn as internal. */
function WorkloadBox({ workload }: { workload: FootprintWorkload }) {
  const detail = [
    workload.role === 'web' ? 'Public' : 'Internal',
    workload.quantity > 1 ? `${workload.quantity} × ${workload.compute.sizeLabel}` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <DiagramBox emphasis={workload.role === 'web'} detail={detail}>
      {workload.label}
    </DiagramBox>
  );
}

/** Plans saved before footprints carried catalog components only. */
function legacyResourceBoxes(plan: DeploymentPlan): { id: string; label: string }[] {
  const labels = { database: 'Database', cache: 'Cache', storage: 'Storage' } as const;
  return (Object.keys(labels) as (keyof typeof labels)[])
    .filter(
      (kind) =>
        plan.components.some((component) => component.kind === kind) ||
        plan.awsResources.some((resource) => resource.id === kind),
    )
    .map((kind) => ({ id: kind, label: labels[kind] }));
}

function DiagramBox({
  children,
  small,
  emphasis,
  detail,
}: {
  children: ReactNode;
  small?: boolean;
  emphasis?: boolean;
  detail?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-0.5 rounded-lg border px-3 py-2 text-center font-medium ${
        small ? 'text-xs' : 'text-sm'
      } ${emphasis ? 'border-primary bg-primary/5' : 'bg-muted'}`}
    >
      <span>{children}</span>
      {detail ? <span className="text-xs font-normal text-muted-foreground">{detail}</span> : null}
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
