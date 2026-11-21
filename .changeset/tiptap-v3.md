---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Move to TipTap v3 (#921). Consumers must upgrade every `@tiptap/*` package to `^3.35.0` together (one ProseMirror copy).

- **Peer dependencies:** `@tiptap/*` peers are now `^3.35.0`. `@pixerate/editor` imports moved extensions from TipTap's combined packages, so `@tiptap/extensions` (Placeholder, CharacterCount) and `@tiptap/extension-list` (task lists) replace `@tiptap/extension-placeholder`, `-character-count`, `-task-list` and `-task-item`; tables come from `@tiptap/extension-table` alone, and colour from `@tiptap/extension-text-style`. `@tiptap/extension-underline`, `-color`, `-table-row`, `-table-header` and `-table-cell` are no longer peers. The React and Svelte packages no longer list `@tiptap/extension-placeholder`.
- **Bubble menus:** `BubbleMenu` and `TableBubbleMenu` (React and Svelte) take Floating UI `options` (placement, offset, flip, shift, …) and `appendTo` in place of `tippyOptions`; tippy.js is gone.
- **Behaviour kept from v2:** the rich-text preset and prompt editor turn off StarterKit v3's trailing paragraph; the preset keeps its own Link (with the `[text](url)` input rule) and takes Underline from StarterKit; the prompt editor has no Link or Underline. React's `useEditor` and `usePromptEditor` keep re-rendering on every transaction (`shouldRerenderOnTransaction: true`; pass `false` to opt out). Internal `setContent` calls pass `emitUpdate` explicitly; in your own code note that v3's `setContent` emits updates by default.
- `tiptap-markdown` is bundled at 0.9.0 (TipTap v3). `editor.storage.markdown` and `editor.storage.richClipboard` are typed through `@tiptap/core`'s `Storage`.
- Fixes for v3 copying extension options: `EditorController`'s plain-text mode now reaches `FileImport` through `editor.storage.fileImport.asPlainText`, and the prompt editor's placeholder stays live through a function. New `promptEditorPlaceholder(editor)` reads the placeholder a prompt editor shows. Editors created without an `element` (headless `EditorController`, Svelte `usePromptEditor` before `mount`) keep a detached view as in v2.
- HTML output: table cells no longer write the default `colspan="1" rowspan="1"`, and inline colours keep the value as written (`#ff0000`) instead of the browser's `rgb()`.
