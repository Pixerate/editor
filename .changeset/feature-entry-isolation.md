---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Per-feature entries so a spreadsheet- or image-only app does not take canvas dependencies.

- **`@dagrejs/dagre` is now an optional peer dependency** of all three packages instead of a hard dependency of `@pixerate/editor` and `@pixerate/editor-svelte`. It is only used by the canvas entries; if you use `@pixerate/editor/canvas`, `@pixerate/editor-react/canvas`, `@pixerate/editor-svelte/canvas` or the agent canvas planner, add it to your app: `npm install @dagrejs/dagre`.
- **New `./spreadsheet` subpath** in `@pixerate/editor-react` and `@pixerate/editor-svelte`. It imports only the framework and `@pixerate/editor/spreadsheet`, so it bundles no TipTap, markdown or dagre code. The root entries still re-export the spreadsheet components.
- The React and Svelte spreadsheet and history bindings now import from the narrow `@pixerate/editor/spreadsheet` and `@pixerate/editor/history` subpaths instead of the root entry.
- `@pixerate/editor` and `@pixerate/editor-react` are marked `sideEffects: false` so bundlers can drop unused root exports.
- `tiptap-markdown` (already bundled into `@pixerate/editor`) moved to `devDependencies`, so it is no longer installed separately.
