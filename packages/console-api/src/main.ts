import { serve } from '@hono/node-server';
import { scrubAddresses } from '@mail/core';
import { createApp } from './app.js';
import { awsDeps } from './aws/deps.js';
import { ConfigError, loadConfig } from './config.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  // Refusing to start is the feature here (local only), so say why and exit non-zero.
  console.error(`console-api: ${error instanceof ConfigError ? error.message : String(error)}`);
  process.exit(1);
}

process.env.POWERTOOLS_TRACE_ENABLED ??= 'false';
const deps = awsDeps(config);
const { app } = createApp(deps);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  deps.log.info('console-api listening', {
    port: info.port,
    awsEndpointUrl: config.awsEndpointUrl,
    mailpitUrl: config.mailpitUrl,
    webOrigin: config.webOrigin,
  });
});

const stop = (signal: string): void => {
  deps.log.info(`received ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.once('SIGTERM', () => {
  stop('SIGTERM');
});
process.once('SIGINT', () => {
  stop('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  console.error(`console-api: unhandled rejection: ${scrubAddresses(String(reason))}`);
});
