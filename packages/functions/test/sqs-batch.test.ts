import { describe, expect, it, vi } from 'vitest';
import { processBatch } from '../src/lib/sqs-batch.js';
import { context, sqsRecord } from './helpers.js';

describe('processBatch', () => {
  it('processes sequentially and reports only retries as failures', async () => {
    const records = [sqsRecord('a', 'm1'), sqsRecord('b', 'm2'), sqsRecord('c', 'm3')];
    const order: string[] = [];
    const result = await processBatch(records, context(), (record) => {
      order.push(record.messageId);
      return Promise.resolve(record.messageId === 'm2' ? 'retry' : 'done');
    });
    expect(order).toEqual(['m1', 'm2', 'm3']);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
  });

  it('stops picking up records below 30 s remaining and returns the rest as failures', async () => {
    const records = ['m1', 'm2', 'm3', 'm4'].map((id) => sqsRecord('x', id));
    let remaining = 40_000;
    const onDeadline = vi.fn();
    const handled: string[] = [];
    const result = await processBatch(
      records,
      context(() => remaining),
      (record) => {
        handled.push(record.messageId);
        remaining -= 6_000; // each record takes 6 s
        return Promise.resolve('done');
      },
      { onDeadline },
    );
    // 40 -> 34 -> 28: the third record is not started.
    expect(handled).toEqual(['m1', 'm2']);
    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['m3', 'm4']);
    expect(onDeadline).toHaveBeenCalledWith(2, 28_000);
  });

  it('treats an escaped exception as transient for that record only', async () => {
    const records = [sqsRecord('a', 'm1'), sqsRecord('b', 'm2')];
    const onUnexpectedError = vi.fn();
    const result = await processBatch(
      records,
      context(),
      (record) =>
        record.messageId === 'm1' ? Promise.reject(new Error('boom')) : Promise.resolve('done'),
      { onUnexpectedError },
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(onUnexpectedError).toHaveBeenCalledOnce();
  });

  it('a configurable threshold', async () => {
    const result = await processBatch(
      [sqsRecord('a', 'm1')],
      context(5_000),
      () => Promise.resolve('done'),
      {
        minRemainingMs: 1_000,
      },
    );
    expect(result.batchItemFailures).toEqual([]);
  });
});
