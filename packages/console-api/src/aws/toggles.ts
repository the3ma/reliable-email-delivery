import { PutParameterCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { SsmToggleSource } from '@mail/core';
import type { ToggleValue, TogglesAdmin } from '../ports.js';

/** Reads straight from SSM (no cache): the console shows what the workers will pick up next. */
export class SsmTogglesAdmin implements TogglesAdmin {
  private readonly source: SsmToggleSource;

  constructor(
    private readonly ssm: SSMClient,
    private readonly prefix: string,
  ) {
    this.source = new SsmToggleSource(ssm, prefix);
  }

  async get(): Promise<{ sendEmails: ToggleValue; recordDeliveries: ToggleValue }> {
    const values = await this.source.fetch();
    // Same interpretation as the processor: only the exact value enables.
    const as = (value: string | undefined): ToggleValue =>
      value === 'enabled' ? 'enabled' : 'disabled';
    return {
      sendEmails: as(values['send-emails']),
      recordDeliveries: as(values['record-deliveries']),
    };
  }

  async setSendEmails(value: ToggleValue): Promise<void> {
    await this.ssm.send(
      new PutParameterCommand({
        Name: `${this.prefix}send-emails`,
        Value: value,
        Type: 'String',
        Overwrite: true,
      }),
    );
  }
}
