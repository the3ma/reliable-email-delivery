import { defineConfig } from 'vitest/config';
import { textTemplates } from './vitest.shared.js';

// Runs only *.int.test.ts. Each suite skips itself (with a notice) unless AWS_ENDPOINT_URL points at
// LocalStack or DynamoDB Local.
export default defineConfig({
  plugins: [textTemplates()],
  test: {
    include: ['packages/*/test/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  },
});
