import { defineConfig } from "tsup";
import esbuildSvelte from "esbuild-svelte";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ["svelte", "svelte/internal", "svelte/store"],
  esbuildPlugins: [esbuildSvelte() as any],
  onSuccess: "cp src/index.d.ts dist/index.d.ts",
});
