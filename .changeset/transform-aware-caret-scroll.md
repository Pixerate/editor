---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Transform-aware caret scrolling: the caret now stays in view while typing when the editor's scroll container is drawn scaled (a pan/zoom canvas, a SvelteFlow node, a diagram card), where ProseMirror's own scrolling over- or under-shoots by the scale. `TransformAwareScroll` (with `createTransformAwareScrollPlugin`, `scrollCaretIntoView` and `calculateTransformScrollAdjustment`) is in `@pixerate/editor` and on by default in `createRichTextPreset`, so React and Svelte editors get it too; it only acts when the scroll container is scaled and otherwise leaves scrolling to ProseMirror. Turn it off with `transformAwareScroll: false` (a preset option, and a shorthand on Svelte's `initiateEditor` and `EditableTextNodeEditor`).
