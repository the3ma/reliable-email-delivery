import { GetSuppressedDestinationCommand, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { AccountSuppressionList } from '../suppression.js';
import type { MailTransport, OutgoingEmail, SendResult } from '../transport.js';

export class SesTransport implements MailTransport {
  readonly name = 'ses' as const;

  constructor(
    private readonly client: SESv2Client,
    private readonly configurationSetName: string | undefined,
  ) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: email.from,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: email.text, Charset: 'UTF-8' },
              Html: { Data: email.html, Charset: 'UTF-8' },
            },
          },
        },
        EmailTags: Object.entries(email.tags).map(([Name, Value]) => ({ Name, Value })),
        ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
      }),
    );
    if (!result.MessageId) throw new Error('SES accepted the request without a MessageId');
    return { messageId: result.MessageId };
  }
}

/** The SES account-level suppression list; complements the application's own table. */
export class SesAccountSuppressionList implements AccountSuppressionList {
  constructor(private readonly client: SESv2Client) {}

  async isSuppressed(address: string): Promise<boolean> {
    try {
      await this.client.send(new GetSuppressedDestinationCommand({ EmailAddress: address }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundException') return false;
      throw error;
    }
  }
}
