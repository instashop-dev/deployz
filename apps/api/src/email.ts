import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';

import { env } from './env.js';

// Transactional email for the control plane (invitations, membership
// changes). One narrow seam so tests can assert what would be sent without
// touching the network.

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Dev/CI default: no verified sender configured, so the mail goes to the log
 *  rather than silently nowhere. Same contract as env.ts — degraded
 *  capabilities warn, they never crash a request. */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.info(`[email] (not sent — EMAIL_FROM unset) to=${message.to} subject=${message.subject}`);
  }
}

export class SesEmailSender implements EmailSender {
  private readonly client: SESClient;

  constructor(private readonly from: string, region = env.awsRegion) {
    this.client = new SESClient({ region });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
        },
      }),
    );
  }
}

export function createEmailSender(): EmailSender {
  return env.emailFrom ? new SesEmailSender(env.emailFrom) : new LogEmailSender();
}

/** Sends without ever failing the caller: an unreachable mail provider must
 *  not roll back an invitation that was already written. */
export async function sendQuietly(sender: EmailSender, message: EmailMessage): Promise<void> {
  try {
    await sender.send(message);
  } catch (error) {
    console.error(`[email] delivery failed to=${message.to}`, error);
  }
}
