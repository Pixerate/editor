import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "spreadsheet/index": "src/spreadsheet/index.ts",
    "canvas/index": "src/canvas/index.ts",
    "image-editor/index": "src/image-editor/index.ts",
    "commands/index": "src/commands/index.ts",
    "persistence/index": "src/persistence/index.ts",
    "generation/index": "src/generation/index.ts",
    "tokens/index": "src/tokens/index.ts",
    "parameters/index": "src/parameters/index.ts",
    "vector/index": "src/vector/index.ts",
    "animation-editor/index": "src/animation-editor/index.ts",
    "chart/index": "src/chart/index.ts",
    "video-editor/index": "src/video-editor/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["react", "react-dom", "@xyflow/react"],
});
