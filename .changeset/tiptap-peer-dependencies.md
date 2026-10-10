---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

**Breaking:** TipTap's core packages are now peer dependencies, so your app and these packages share a single TipTap/ProseMirror instance. Install them alongside the editor packages (npm 7+ and pnpm install peer dependencies automatically):

```bash
# core / Svelte
npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5
# React
npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5 @tiptap/react@^2.11.5
```

Previously each package pulled in its own `@tiptap/core` and `@tiptap/pm`, and `@pixerate/editor-react` allowed TipTap v3 while core required v2. That could install two ProseMirror copies, which breaks `instanceof` checks and loads v2 extensions into a v3 editor. The untested `^3.0.0` range has been removed from `@pixerate/editor-react`; all packages now target TipTap `^2.11.5`.
