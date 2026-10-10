---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

**Breaking (core):** the root `@pixerate/editor` entry no longer re-exports the canvas, agent or image editor modules. Import them from their subpaths:

```diff
- import { ensureLayout, ImageEditorController, planAgentCommand } from "@pixerate/editor";
+ import { ensureLayout } from "@pixerate/editor/canvas";
+ import { ImageEditorController } from "@pixerate/editor/image-editor";
+ import { planAgentCommand } from "@pixerate/editor/agent";
```

The root entry therefore no longer loads `@dagrejs/dagre` or the Canvas 2D image renderer. The core build now uses code splitting, so subpath entries share a single copy of common modules. Previously each entry bundled its own copy, which created duplicate singletons such as `globalImageCache` and broke `instanceof` checks across entries. The React and Svelte image editors now import from `@pixerate/editor/image-editor`.
