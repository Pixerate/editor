import { defineConfig } from "tsup";
import esbuildSvelte from "esbuild-svelte";

export default defineConfig({
  entry: ["src/index.ts", "src/canvas/index.ts"],
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
  onSuccess: "mkdir -p dist/canvas && cp src/index.d.ts dist/index.d.ts && cp src/canvas/index.d.ts dist/canvas/index.d.ts",
});
