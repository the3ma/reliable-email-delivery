import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { ToggleSource } from '../toggles.js';

export class SsmToggleSource implements ToggleSource {
  private readonly prefix: string;

  constructor(
    private readonly client: SSMClient,
    prefix: string,
  ) {
    this.prefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  async fetch(): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new GetParametersByPathCommand({
          Path: this.prefix.slice(0, -1),
          Recursive: false,
          WithDecryption: false,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      );
      for (const parameter of page.Parameters ?? []) {
        if (parameter.Name?.startsWith(this.prefix) && parameter.Value !== undefined) {
          values[parameter.Name.slice(this.prefix.length)] = parameter.Value;
        }
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return values;
  }
}
