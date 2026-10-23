// Runs every built bundle the way the image does and checks it gets past module loading and client
// construction: with AWS pointed at a closed port, each CLI must fail on the network (or on usage),
// never on an interop error such as "SQSClient is not a constructor".
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const image = join(root, 'dist', 'image');
const lambda = join(root, 'dist', 'lambda');

const INTEROP =
  /is not a constructor|is not a function|Cannot find (module|package)|SyntaxError|ReferenceError|ERR_REQUIRE|ERR_MODULE|Dynamic require/;
const NETWORK =
  /ECONNREFUSED|connect|socket|timed? ?out|timeout|getaddrinfo|EHOSTUNREACH|credential/i;

const env = {
  ...process.env,
  AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'smoke',
  AWS_SECRET_ACCESS_KEY: 'smoke',
  AWS_MAX_ATTEMPTS: '1',
  SENDING_HARD_DISABLED: 'false',
  POWERTOOLS_TRACE_ENABLED: 'false',
};
delete env.AWS_PROFILE;
delete env.INTAKE_QUEUE_URL;
delete env.EMAIL_QUEUE_URL;

/** [cli, args, expected output, run time before SIGTERM (long-running workers only)] */
const CASES = [
  ['digest', ['--all', '--ignore-window'], NETWORK],
  ['digest', ['--segment', '3'], NETWORK],
  ['digest', [], /usage: digest/],
  ['feedback', ['--type', 'complaint', '--email', 'smoke@example.test'], NETWORK],
  ['seed', ['--users', '1'], NETWORK],
  ['publish', ['--count', '2'], NETWORK],
  ['publish', ['--count', '2', '--direct'], NETWORK],
  ['worker-immediate', [], NETWORK, 4_000],
  ['worker-processor', [], NETWORK, 4_000],
];

function run(cli, args, stopAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(image, 'cli', `${cli}.mjs`), ...args], {
      cwd: image,
      env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), stopAfterMs ?? 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

let failures = 0;
for (const [cli, args, expected, stopAfterMs] of CASES) {
  const { code, signal, output } = await run(cli, args, stopAfterMs);
  const label = `${cli} ${args.join(' ')}`.trim();
  const interop = INTEROP.exec(output);
  const problems = [];
  if (interop) problems.push(`interop/load error: ${interop[0]}`);
  if (!expected.test(output)) problems.push(`expected output matching ${expected}`);
  if (stopAfterMs === undefined && code === 0)
    problems.push('exited 0 although AWS is unreachable');
  if (stopAfterMs === undefined && signal) problems.push(`did not finish (killed by ${signal})`);
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL ${label}: ${problems.join('; ')}\n${output.slice(-1500)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// console-api: refuses to start without AWS_ENDPOINT_URL; with it, serves /health (503: nothing is up).
{
  const noEndpoint = { ...env };
  delete noEndpoint.AWS_ENDPOINT_URL;
  const refused = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(image, 'cli', 'console-api.mjs')], {
      cwd: image,
      env: noEndpoint,
    });
    let output = '';
    child.stderr.on('data', (chunk) => (output += chunk));
    child.stdout.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  if (
    refused.code !== 0 &&
    /AWS_ENDPOINT_URL is not set/.test(refused.output) &&
    !INTEROP.test(refused.output)
  ) {
    console.log('ok   console-api refuses to start without AWS_ENDPOINT_URL');
  } else {
    failures += 1;
    console.error(`FAIL console-api without AWS_ENDPOINT_URL: exit ${refused.code}
${refused.output.slice(-1500)}`);
  }

  const port = 39_000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [join(image, 'cli', 'console-api.mjs')], {
    cwd: image,
    env: { ...env, PORT: String(port), HOST: '127.0.0.1', MAILPIT_URL: 'http://127.0.0.1:9' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let health;
  for (let attempt = 0; attempt < 60 && !health; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      health = { status: response.status, body: await response.json() };
    } catch {
      // not listening yet
    }
  }
  child.kill('SIGTERM');
  if (health?.status === 503 && health.body?.checks?.mailpit === 'down' && !INTEROP.test(output)) {
    console.log('ok   console-api serves /api/v1/health');
  } else {
    failures += 1;
    console.error(`FAIL console-api health: ${JSON.stringify(health)}
${output.slice(-1500)}`);
  }
}

// Lambda bundles: load like the Lambda runtime (CommonJS) and invoke with a record that needs no AWS.
const require = createRequire(import.meta.url);
Object.assign(process.env, env, {
  TABLE_SUBSCRIPTIONS: 's',
  TABLE_PENDING_DIGEST: 'p',
  TABLE_DELIVERIES: 'd',
  TABLE_DELIVERY_LOG: 'l',
  TABLE_SUPPRESSIONS: 'x',
  EMAIL_QUEUE_URL: 'http://127.0.0.1:9/000000000000/email',
  APP_BASE_URL: 'http://localhost:8080',
  FROM_ADDRESS: 'notifications@example.test',
  MAIL_TRANSPORT: 'smtp',
  SSM_PREFIX: '/smoke/email/',
});
const context = {
  awsRequestId: 'smoke',
  functionName: 'smoke',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:smoke',
  memoryLimitInMB: '128',
  logGroupName: 'smoke',
  logStreamName: 'smoke',
  getRemainingTimeInMillis: () => 60_000,
};
const silence = process.stdout.write.bind(process.stdout);
for (const name of ['processor', 'notifier-immediate']) {
  try {
    const { handler } = require(join(lambda, `${name}.cjs`));
    process.stdout.write = () => true;
    const result = await handler({ Records: [{ messageId: 'm1', body: '{not json' }] }, context);
    process.stdout.write = silence;
    if (result?.batchItemFailures?.length !== 0)
      throw new Error(`unexpected ${JSON.stringify(result)}`);
    console.log(`ok   lambda ${name}`);
  } catch (error) {
    process.stdout.write = silence;
    failures += 1;
    console.error(`FAIL lambda ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const name of ['notifier-digest', 'feedback']) {
  const { handler } = require(join(lambda, `${name}.cjs`));
  if (typeof handler === 'function') console.log(`ok   lambda ${name}`);
  else {
    failures += 1;
    console.error(`FAIL lambda ${name}: no handler export`);
  }
}

if (failures > 0) {
  console.error(`${failures} bundle smoke check(s) failed`);
  process.exit(1);
}
console.log('all bundles load and construct their clients');
