import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const corePackage = JSON.parse(readFileSync(new URL("../../packages/core/package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // GitHub Pages serves the demo from /<repo>/, so the deploy workflow sets DEMO_BASE=/editor/.
  base: process.env.DEMO_BASE ?? "/",
  define: {
    __PIXERATE_VERSION__: JSON.stringify(corePackage.version),
  },
  plugins: [react()],
  server: {
    port: 3000,
    // Cross-origin isolation, so wet paint runs in Web Workers on shared memory (see GOTCHAS).
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
  },
  preview: {
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
  },
});
