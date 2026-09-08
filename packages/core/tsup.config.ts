import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "grammar/index": "src/grammar/index.ts",
    "extensions/index": "src/extensions/index.ts",
    "serializers/index": "src/serializers/index.ts",
    "spreadsheet/index": "src/spreadsheet/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
