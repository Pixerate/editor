---
'@pixerate/editor': minor
'@pixerate/editor-react': patch
'@pixerate/editor-svelte': minor
---

Add `usePromptEditor` (and alias `createPromptEditor`) to `@pixerate/editor-svelte`: the Svelte 5 counterpart of React's `usePromptEditor`, with the same options, milestones, slash-command keys, plain-text clipboard handling, `loadingIndicator` and echo-safe controlled `content` (#500).

The prompt editor itself now lives in `@pixerate/editor` (`createPromptEditorOptions`, `syncPromptEditor`, `promptEditorConfigKey`, `promptMilestones`, `resolvePromptTemplateColorMap`, `PromptEditorConfig`), and both framework hooks are thin wrappers over it. React's `usePromptEditor` behaves as before.
