import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Mirrors the esbuild `text` loader the bundles use: `.txt` / `.html` imports become strings. */
export function textTemplates(): Plugin {
  return {
    name: 'text-templates',
    enforce: 'pre',
    async load(id) {
      const path = id.split('?')[0] ?? id;
      if (!path.endsWith('.txt') && !path.endsWith('.html')) return null;
      const content = await readFile(path, 'utf8');
      return { code: `export default ${JSON.stringify(content)};`, map: null };
    },
  };
}
