import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TEXT = /\.(txt|html)$/;

export async function load(url, context, nextLoad) {
  if (!TEXT.test(new URL(url).pathname)) return nextLoad(url, context);
  const content = await readFile(fileURLToPath(url), 'utf8');
  return {
    format: 'module',
    source: `export default ${JSON.stringify(content)};`,
    shortCircuit: true,
  };
}
