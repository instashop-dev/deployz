import { ArrowDown, ArrowRight } from 'lucide-react';
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
        // diagram itself — the application caption and the account boundary.
        .filter((resource) => resource.category !== 'network')
        .map((resource) => ({ id: resource.id, label: resource.label }))
    : legacyResourceBoxes(plan);

  return (
    <figure aria-label="Deployz architecture diagram" className="not-prose flex flex-col gap-3">
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        <div className="flex flex-1 flex-col gap-4 rounded-xl border border-dashed p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your AWS account
          </p>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">Your application, behind a load balancer</p>
            <div className="flex flex-wrap gap-2" data-testid="diagram-workloads">
              {workloads ? (
                workloads.map((workload) => <WorkloadBox key={workload.id} workload={workload} />)
              ) : (
                <DiagramBox>Application container</DiagramBox>
              )}
            </div>
            <div className="flex flex-wrap gap-2" data-testid="diagram-resources">
              {resourceBoxes.map((box) => (
                <DiagramBox key={box.id} small>
                  {box.label}
                </DiagramBox>
              ))}
              <DiagramBox small>Secrets</DiagramBox>
              <DiagramBox small>Monitoring</DiagramBox>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            <p className="text-xs text-muted-foreground">Applies changes to your application</p>
            <div className="flex">
              <DiagramBox emphasis detail="Runs every minute">
                Deployz connector
              </DiagramBox>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-1 px-2 text-xs text-muted-foreground md:flex-col">
          <ArrowDown aria-hidden className="size-4 md:hidden" />
          <ArrowRight aria-hidden className="hidden size-4 md:block" />
          <span>Outbound HTTPS</span>
        </div>
        <div className="flex justify-center md:w-48">
          <DiagramBox emphasis detail="Sends commands when the connector asks">
            Deployz control plane
          </DiagramBox>
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">
        The connector starts every connection. Deployz cannot connect into your account.
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
