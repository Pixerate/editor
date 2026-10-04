import { defineConfig } from "tsup";
import esbuildSvelte from "esbuild-svelte";

export default defineConfig({
  entry: ["src/index.ts", "src/canvas/index.ts", "src/image-editor/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: [
    "svelte",
    "svelte/internal",
    "svelte/store",
    "svelte/easing",
    "@xyflow/svelte",
    "@dagrejs/dagre",
  ],
  esbuildPlugins: [esbuildSvelte() as any],
  onSuccess: "mkdir -p dist/canvas dist/image-editor && cp src/index.d.ts dist/index.d.ts && cp src/canvas/index.d.ts dist/canvas/index.d.ts && cp src/image-editor/index.d.ts dist/image-editor/index.d.ts",
});
