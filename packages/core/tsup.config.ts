import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "grammar/index": "src/grammar/index.ts",
    "extensions/index": "src/extensions/index.ts",
    "serializers/index": "src/serializers/index.ts",
    "spreadsheet/index": "src/spreadsheet/index.ts",
    "history/index": "src/history/index.ts",
    "canvas/index": "src/canvas/index.ts",
    "agent/index": "src/agent/index.ts",
    "image-editor/index": "src/image-editor/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["tiptap-markdown"],
});
