// `tsx --import ./scripts/register-text-loader.mjs ...`: lets local CLIs import templates as
// strings, the way the esbuild `text` loader does in the bundles.
import { register } from 'node:module';

register('./text-loader-hooks.mjs', import.meta.url);
