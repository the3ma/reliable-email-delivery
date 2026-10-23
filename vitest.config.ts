import { defineConfig } from 'vitest/config';
import { textTemplates } from './vitest.shared.js';

export default defineConfig({
  plugins: [textTemplates()],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    environment: 'node',
    restoreMocks: true,
    // Handlers read config from the environment; keep tests independent of the caller's shell.
    env: {
      AWS_REGION: 'us-east-1',
      POWERTOOLS_SERVICE_NAME: 'email-delivery-test',
      POWERTOOLS_METRICS_NAMESPACE: 'EmailDelivery',
      POWERTOOLS_DEV: 'false',
      POWERTOOLS_TRACE_ENABLED: 'false',
      LOG_LEVEL: 'DEBUG',
    },
  },
});
