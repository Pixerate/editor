---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

`LoadingNode` no longer renders the ⏳ emoji. Its placeholder is now an accessible `<span role="status" aria-label="Loading…">` around an SVG spinner drawn in `currentColor` (so text colour utilities tint it), and it no longer uses `animate-pulse`. Configure it with `LoadingNode.configure({ label, HTMLAttributes, renderIndicator, nodeView })`; `loadingSpinnerSpec()` is the default indicator. React adds `usePromptEditor({ loadingIndicator, loadingLabel })` and `createReactLoadingNodeView(Component)`; Svelte adds `createSvelteLoadingNodeView(Component)` for a design-system loader inside the placeholder.
