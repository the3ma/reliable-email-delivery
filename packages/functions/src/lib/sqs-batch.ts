import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';

export interface DeadlineContext {
  getRemainingTimeInMillis(): number;
}

/** `retry` reports the record as a batch item failure; `done` lets SQS delete it. */
export type RecordOutcome = 'done' | 'retry';

export const DEFAULT_MIN_REMAINING_MS = 30_000;

export interface BatchOptions {
  minRemainingMs?: number;
  onDeadline?: (unprocessed: number, remainingMs: number) => void;
  onUnexpectedError?: (error: unknown, record: SQSRecord) => void;
}

/**
 * Sequential, with a deadline guard: a Lambda timeout would bypass reportBatchItemFailures and
 * redeliver the whole batch, so records we cannot finish in time are handed back explicitly.
 */
export async function processBatch(
  records: readonly SQSRecord[],
  context: DeadlineContext,
  handle: (record: SQSRecord) => Promise<RecordOutcome>,
  options: BatchOptions = {},
): Promise<SQSBatchResponse> {
  const minRemaining = options.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const [index, record] of records.entries()) {
    const remaining = context.getRemainingTimeInMillis();
    if (remaining < minRemaining) {
      const unprocessed = records.slice(index);
      options.onDeadline?.(unprocessed.length, remaining);
      for (const left of unprocessed) batchItemFailures.push({ itemIdentifier: left.messageId });
      break;
    }
    let outcome: RecordOutcome;
    try {
      outcome = await handle(record);
    } catch (error) {
      // Handlers classify their own errors; anything that escapes is treated as transient.
      options.onUnexpectedError?.(error, record);
      outcome = 'retry';
    }
    if (outcome === 'retry') batchItemFailures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures };
}
