import { setupWorker } from 'msw/browser';
import { db } from './db';
import { handlers } from './handlers';

/** dev:mock backend: seeded history; scenario effects arrive over a few seconds. */
export async function startMockWorker(): Promise<void> {
  db.reset({ seed: true, stepMs: 600 });
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledFrame: 'bypass', quiet: false });
  console.info('[mock] MSW active: /api/v1 is served from memory (no backend required).');
}
