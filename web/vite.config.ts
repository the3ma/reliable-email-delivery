import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies /api to a running console-api; `npm run dev:mock` serves the MSW worker
// from mock-public/ so the app runs with no backend at all (and the worker never ships in a build).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  publicDir: mode === 'mock' ? 'mock-public' : 'public',
  server: {
    port: 5173,
    proxy:
      mode === 'mock'
        ? {}
        : {
            '/api': {
              target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
              changeOrigin: true,
            },
          },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    restoreMocks: true,
  },
}));
