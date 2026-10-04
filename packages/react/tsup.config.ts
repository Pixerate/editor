import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "canvas/index": "src/canvas/index.ts",
    "image-editor/index": "src/image-editor/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["react", "react-dom", "@xyflow/react"],
});
