import { InstallLaunchButton } from '@/components/install-launch-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { DeployLinkToken } from '@/lib/deploy-link-flow';
import type { ExistingStackUpdate } from '@/lib/install-data';

function Value({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <code className="block overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
        {value}
      </code>
    </li>
  );
}

// A reconnect keeps the connector stack that is already in the customer's AWS
// account, so a new Quick Create stack would fail with AlreadyExists. The
// customer updates that stack with the new credential and enrollment code.
export function ExistingConnectorUpdate({
  installLinkId,
  update,
  deployLink = null,
}: {
  installLinkId: string;
  update: ExistingStackUpdate;
  deployLink?: DeployLinkToken | null;
}) {
  return (
    <section aria-labelledby="update-connector" className="flex flex-col gap-3">
      <h2 id="update-connector" className="text-base font-semibold">
        Reconnect the existing connector
      </h2>
      <Alert>
        <AlertTitle>Update the connector stack. Do not create a new one.</AlertTitle>
        <AlertDescription>
          The connector stack <code className="font-mono text-xs">{update.stackName}</code> is
          already in your AWS account. Update it with the new values below.
        </AlertDescription>
      </Alert>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>Open the stack in the AWS console and select Update, then Replace existing template.</li>
        {update.templateUrl ? <li>Enter the Amazon S3 URL shown below.</li> : null}
        <li>Enter the new RelayCredential and EnrollmentCode. Keep every other value as it is.</li>
        <li>Submit the update. The connector reconnects and progress shows here.</li>
      </ol>
      <ul className="flex flex-col gap-3">
        {update.templateUrl ? <Value label="Template URL" value={update.templateUrl} /> : null}
        {update.relayCredential ? (
          <Value label="RelayCredential" value={update.relayCredential} />
        ) : null}
        <Value label="EnrollmentCode" value={update.enrollmentCode} />
        <Value label="ControlPlaneUrl (unchanged)" value={update.controlPlaneUrl} />
      </ul>
      <InstallLaunchButton
        installLinkId={installLinkId}
        quickCreateUrl={update.consoleUrl}
        deployLink={deployLink}
        label="Open connector stack in AWS"
      />
    </section>
  );
}
