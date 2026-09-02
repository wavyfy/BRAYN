import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app's tsconfig.json sets `jsx: "preserve"` for Next's own SWC
  // compiler — override it here so the test transform actually compiles JSX
  // instead of leaving it raw (see https://oxc.rs/docs/guide/usage/transformer/jsx).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
  },
});
