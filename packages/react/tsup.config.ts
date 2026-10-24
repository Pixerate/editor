import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "spreadsheet/index": "src/spreadsheet/index.ts",
    "canvas/index": "src/canvas/index.ts",
    "image-editor/index": "src/image-editor/index.ts",
    "paint-editor/index": "src/paint-editor/index.ts",
    "commands/index": "src/commands/index.ts",
    "persistence/index": "src/persistence/index.ts",
    "generation/index": "src/generation/index.ts",
    "tokens/index": "src/tokens/index.ts",
    "parameters/index": "src/parameters/index.ts",
    "vector/index": "src/vector/index.ts",
    "animation-editor/index": "src/animation-editor/index.ts",
    "chart/index": "src/chart/index.ts",
    "video-editor/index": "src/video-editor/index.ts",
    "effects/index": "src/effects/index.ts",
    "color/index": "src/color/index.ts",
    "gradient/index": "src/gradient/index.ts"
  },
  format: ["esm", "cjs"],
  // Declarations come from `tsc -p tsconfig.build.json` (see the build script): tsup's bundled DTS worker ran out of memory.
  dts: false,
  clean: true,
  // No source maps in the published package: see GOTCHAS "[monorepo/build] Declarations Come From `tsc`".
  sourcemap: false,
  external: ["react", "react-dom", "@xyflow/react"],
});
