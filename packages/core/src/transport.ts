export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Echoed back by SES in delivery/bounce events; values must match [A-Za-z0-9_-]. */
  tags: Record<string, string>;
}

export interface SendResult {
  messageId: string;
}

export interface MailTransport {
  readonly name: 'ses' | 'smtp' | 'memory';
  send(email: OutgoingEmail): Promise<SendResult>;
}
