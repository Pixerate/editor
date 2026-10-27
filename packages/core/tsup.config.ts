import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "grammar/index": "src/grammar/index.ts",
    "extensions/index": "src/extensions/index.ts",
    "serializers/index": "src/serializers/index.ts",
    "spreadsheet/index": "src/spreadsheet/index.ts",
    "history/index": "src/history/index.ts",
    "animation/index": "src/animation/index.ts",
    "animation-editor/index": "src/animation-editor/index.ts",
    "video-editor/index": "src/video-editor/index.ts",
    "canvas/index": "src/canvas/index.ts",
    "agent/index": "src/agent/index.ts",
    "tools/index": "src/tools/index.ts",
    "raster/index": "src/raster/index.ts",
    "paint/index": "src/paint/index.ts",
    "cms/index": "src/cms/index.ts",
    "image-editor/index": "src/image-editor/index.ts",
    "paint-editor/index": "src/paint-editor/index.ts",
    "commands/index": "src/commands/index.ts",
    "persistence/index": "src/persistence/index.ts",
    "generation/index": "src/generation/index.ts",
    "compare/index": "src/compare/index.ts",
    "tokens/index": "src/tokens/index.ts",
    "color/index": "src/color/index.ts",
    "typography/index": "src/typography/index.ts",
    "gradient/index": "src/gradient/index.ts",
    "export/index": "src/export/index.ts",
    "parameters/index": "src/parameters/index.ts",
    "vector/index": "src/vector/index.ts",
    "chart/index": "src/chart/index.ts",
    "chart-maps/index": "src/chart-maps/index.ts",
    "diagram/index": "src/diagram/index.ts",
    "effects/index": "src/effects/index.ts",
    "bridge/index": "src/bridge/index.ts",
    "bridge/cli": "src/bridge/cli.ts",
  },
  format: ["esm", "cjs"],
  // Declarations come from `tsc -p tsconfig.build.json` (see the build script): tsup's bundled DTS worker ran out of memory.
  dts: false,
  clean: true,
  // No source maps in the published package: see GOTCHAS "[monorepo/build] Declarations Come From `tsc`".
  sourcemap: false,
  splitting: true,
  // `import.meta` is a syntax error in CommonJS. The one use (the bridge's skills lookup) takes
  // `__dirname` there, so the CJS build only needs it to parse. tsup's `shims` would add Node
  // imports to chunks the browser entries share.
  esbuildOptions(options, { format }) {
    if (format === "cjs") options.define = { ...options.define, "import.meta.url": "undefined" };
  },
  noExternal: ["tiptap-markdown"],
});
