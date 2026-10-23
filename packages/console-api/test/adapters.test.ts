import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDeliveriesAdmin, DynamoSuppressionsAdmin } from '../src/aws/dynamo-admin.js';
import { MailpitClient, header } from '../src/aws/mailpit.js';

function fakeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string }[] = [];
  const impl = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method });
    const path = input.replace('http://mailpit:8025', '');
    const key = `${method} ${path}`;
    if (!(key in routes)) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(routes[key] ?? {}), { status: 200 }));
  };
  return { impl, calls };
}

describe('MailpitClient', () => {
  const summary = {
    ID: 'abc',
    MessageID: 'm-1@local.test',
    To: [{ Name: '', Address: 'user-001@example.test' }],
    Subject: 'Hi',
    Created: '2026-10-23T07:30:00Z',
    Size: 123,
  };

  it('maps the list and message endpoints', async () => {
    const { impl } = fakeFetch({
      'GET /api/v1/messages?start=0&limit=2': { total: 1, messages: [summary] },
      'GET /api/v1/message/abc': {
        ...summary,
        From: { Address: 'n@example.test' },
        Date: 'd',
        Text: 't',
        HTML: '<p>h</p>',
      },
    });
    const client = new MailpitClient('http://mailpit:8025', impl);
    expect(await client.list(0, 2)).toEqual({
      total: 1,
      messages: [
        {
          id: 'abc',
          messageId: 'm-1@local.test',
          to: ['user-001@example.test'],
          subject: 'Hi',
          createdAt: '2026-10-23T07:30:00Z',
          size: 123,
        },
      ],
    });
    expect(await client.get('abc')).toMatchObject({
      from: 'n@example.test',
      text: 't',
      html: '<p>h</p>',
    });
    expect(await client.get('missing')).toBeUndefined();
  });

  it('caches headers per message', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/v1/message/abc/headers': { 'X-Tag-Deliveryid': ['d1'] },
    });
    const client = new MailpitClient('http://mailpit:8025', impl);
    await client.headers('abc');
    await client.headers('abc');
    expect(calls).toHaveLength(1);
  });

  it('finds a message by Message-ID via search', async () => {
    const query = encodeURIComponent('message-id:"m-1@local.test"');
    const { impl } = fakeFetch({
      [`GET /api/v1/search?query=${query}&limit=5`]: { total: 1, messages: [summary] },
    });
    const client = new MailpitClient('http://mailpit:8025', impl);
    expect(await client.findByMessageId('m-1@local.test')).toBe('abc');
    expect(await client.findByMessageId('other@local.test')).toBeUndefined();
  });

  it('deleteAll uses DELETE /api/v1/messages; ping reports reachability', async () => {
    const { impl, calls } = fakeFetch({ 'DELETE /api/v1/messages': {}, 'GET /api/v1/info': {} });
    const client = new MailpitClient('http://mailpit:8025', impl);
    await client.deleteAll();
    expect(calls[0]).toEqual({ url: 'http://mailpit:8025/api/v1/messages', method: 'DELETE' });
    expect(await client.ping()).toBe(true);
    const down = new MailpitClient('http://mailpit:8025', () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    expect(await down.ping()).toBe(false);
  });

  it('header() is case-insensitive (Mailpit canonicalises names)', () => {
    expect(header({ 'X-Tag-Deliveryid': ['abc'] }, 'X-Tag-deliveryId')).toBe('abc');
    expect(header(undefined, 'x')).toBeUndefined();
  });
});

function fakeDynamo(pages: Record<string, unknown>[][]) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ScanCommand') {
        const items = pages.shift() ?? [];
        return Promise.resolve({
          Items: items,
          ...(pages.length > 0 ? { LastEvaluatedKey: { k: 1 } } : {}),
        });
      }
      return Promise.resolve({});
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

describe('Dynamo admin adapters', () => {
  it('scans every page and drops malformed items', async () => {
    const { client } = fakeDynamo([
      [
        {
          deliveryId: 'a',
          status: 'SENT',
          attempts: 0,
          updatedAt: 'x',
          expiresAt: 1,
          userId: 'u-1',
          kind: 'immediate',
        },
      ],
      [{ deliveryId: 'b', status: 'BOGUS' }, { nope: true }],
    ]);
    const records = await new DynamoDeliveriesAdmin(client, 'deliveries').list();
    expect(records).toEqual([
      {
        deliveryId: 'a',
        status: 'SENT',
        attempts: 0,
        updatedAt: 'x',
        expiresAt: 1,
        userId: 'u-1',
        kind: 'immediate',
      },
    ]);
  });

  it('suppression clear keeps what the predicate keeps and deletes by key', async () => {
    const { client, sent } = fakeDynamo([
      [
        { emailHash: 'h1', reason: 'manual', source: 'seed', createdAt: '', lastEventAt: '' },
        {
          emailHash: 'h2',
          reason: 'complaint',
          source: 'ses-complaint',
          createdAt: '',
          lastEventAt: '',
        },
      ],
    ]);
    const n = await new DynamoSuppressionsAdmin(client, 'suppressions').clear(
      (r) => r.source === 'seed',
    );
    expect(n).toBe(1);
    const write = sent.find((s) => s.name === 'BatchWriteCommand');
    expect(write?.input).toEqual({
      RequestItems: { suppressions: [{ DeleteRequest: { Key: { emailHash: 'h2' } } }] },
    });
  });
});
