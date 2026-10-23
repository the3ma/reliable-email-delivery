// Templates are imported as strings: esbuild `text` loader in bundles, a Vite plugin in tests,
// and scripts/register-text-loader.mjs under tsx.
declare module '*.txt' {
  const content: string;
  export default content;
}

declare module '*.html' {
  const content: string;
  export default content;
}
