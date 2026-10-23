import type { DigestRunResult } from '../app/notifier-digest.js';
import { localContext } from '../cli/local.js';

export type DigestRunner = (
  event: unknown,
  context: { getRemainingTimeInMillis(): number },
) => Promise<DigestRunResult>;

export interface DigestSummary {
  results: DigestRunResult[];
  failures: { segment: number; message: string }[];
  totals: Omit<DigestRunResult, 'segment'>;
}

/** Runs segments one after another, each with its own 5-minute budget, and adds up the results. */
export async function runDigestSegments(
  runner: DigestRunner,
  segments: readonly number[],
  timeoutMs = 5 * 60_000,
): Promise<DigestSummary> {
  const results: DigestRunResult[] = [];
  const failures: DigestSummary['failures'] = [];
  for (const segment of segments) {
    try {
      results.push(await runner({ segment }, localContext('notifier-digest', timeoutMs)));
    } catch (error) {
      failures.push({ segment, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const totals: DigestSummary['totals'] = {
    users: 0,
    due: 0,
    queued: 0,
    alreadyDelivered: 0,
    nothingPending: 0,
    failed: 0,
    remaining: 0,
    invalidSubscriptions: 0,
    messages: 0,
  };
  for (const result of results) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];
  }
  return { results, failures, totals };
}
