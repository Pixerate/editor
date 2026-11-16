import { defineConfig } from 'vitest/config';

// The harness's own tests: no model calls. The eval itself runs with `node src/cli.ts`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
