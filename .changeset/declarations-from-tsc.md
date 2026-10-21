---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Smaller packages with type declarations that resolve for every consumer. Declarations are now written by `tsc`, one file per module, instead of tsup's bundler, which ran out of memory. Every `exports` entry gives `require` its own `.d.cts` types, so CommonJS projects on `moduleResolution: "node16"` no longer get TS1479 when they import a subpath. Source maps are no longer published, which shrinks `@pixerate/editor` from 52 MB to 22 MB unpacked. `@pixerate/editor-svelte/chart` exports `ChartInspectorSection` from a `.ts` module, so `node16` consumers can import it. The exported names and types are unchanged.
