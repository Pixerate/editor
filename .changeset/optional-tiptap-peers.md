---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

**Breaking for rich-text users:** TipTap, ProseMirror and markdown-it are now optional peer dependencies instead of dependencies, so apps that only use charts, spreadsheets, canvases, images or the other subpath entries no longer install them. Apps that use rich text or prompts (the root entries, and core's `/extensions`, `/serializers`, `/agent` and `/compare`) must install them; each package README has the install line. `@tiptap/core`, `@tiptap/pm` and `@tiptap/react` are optional peers too.
