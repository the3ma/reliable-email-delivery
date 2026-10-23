// Bundles the Lambda handlers (CJS, like CDK NodejsFunction) and the local CLIs (ESM) with
// esbuild, and writes dist/image/package.json so the container can `npm run <cli>`.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages', 'functions', 'src');
const dist = join(root, 'dist');

const HANDLERS = ['notifier-immediate', 'notifier-digest', 'processor', 'feedback'];
const CLIS = ['worker-immediate', 'worker-processor', 'digest', 'seed', 'publish', 'feedback'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  loader: { '.txt': 'text', '.html': 'text' },
  logLevel: 'warning',
};

await rm(dist, { recursive: true, force: true });

await build({
  ...common,
  entryPoints: Object.fromEntries(
    HANDLERS.map((name) => [name, join(src, 'handlers', `${name}.ts`)]),
  ),
  outdir: join(dist, 'lambda'),
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});

await build({
  ...common,
  entryPoints: Object.fromEntries(CLIS.map((name) => [name, join(src, 'cli', `${name}.ts`)])),
  outdir: join(dist, 'image', 'cli'),
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // Bundled CJS dependencies (nodemailer) still call require() for Node built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const scripts = Object.fromEntries(
  CLIS.map((name) => [name, `exec node --enable-source-maps cli/${name}.mjs`]),
);
await mkdir(join(dist, 'image'), { recursive: true });
await writeFile(
  join(dist, 'image', 'package.json'),
  `${JSON.stringify({ name: 'email-delivery-runtime', private: true, type: 'module', scripts }, null, 2)}\n`,
);

console.log(`built ${HANDLERS.length} handlers -> dist/lambda, ${CLIS.length} CLIs -> dist/image`);
