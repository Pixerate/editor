import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // On CI, also warn about tests that use a large part of their timeout (never fails the run).
    reporters: process.env.GITHUB_ACTIONS ? ['default', './vitest.slow-tests.ts'] : ['default'],
  },
});
