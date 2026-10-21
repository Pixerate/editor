import { defineConfig } from "vitest/config";

// Evals that call a model: run on purpose with `pnpm eval:tools`, never in `pnpm test`.
export default defineConfig({
  test: {
    include: ["tests/evals/**/*.eval.ts"],
    testTimeout: 60 * 60 * 1000,
  },
});
