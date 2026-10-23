import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { MailTransport, OutgoingEmail, SendResult } from './transport.js';

export interface SmtpOptions {
  host: string;
  port: number;
}

/** Local transport (Mailpit). Tags become X-Tag-* headers so the local inbox shows them. */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp' as const;
  private readonly transporter: Transporter;

  constructor(options: SmtpOptions) {
    this.transporter = createTransport({
      host: options.host,
      port: options.port,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(email.tags)) headers[`X-Tag-${name}`] = value;
    const info = (await this.transporter.sendMail({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers,
    })) as { messageId?: unknown };
    if (typeof info.messageId !== 'string') throw new Error('SMTP server returned no message id');
    return { messageId: info.messageId };
  }
}
