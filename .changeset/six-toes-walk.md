---
"@pixerate/editor-svelte": patch
---

Point svelte entry and export condition to pre-bundled dist/index.js instead of raw TypeScript src/index.ts to ensure compatibility with Vite optimize-svelte and Storybook Svelte bundler.
