---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add dirty state tracking and navigation guards across Core, React, and Svelte packages:

- **Core (`@pixerate/editor`)**:
  - Add `DirtyTracker` and `createDirtyTracker` utilities for baseline tracking and structural equality comparison (`defaultIsEqual`).
  - Add `isDirty()`, `setCheckpoint()`, `resetDirty()`, and `getBaselineContent()` to `EditorController`.
- **React (`@pixerate/editor-react`)**:
  - Add `useNavigationGuard` hook to guard against tab close/external unloads (`beforeunload`) and intercept internal link clicks with confirmation dialog support.
  - Add `useDismissGuard` hook to guard modal dialogs and edit sessions on `Escape` key or explicit dismissal triggers.
  - Re-export dirty tracking utilities from core.
- **Svelte (`@pixerate/editor-svelte`)**:
  - Add `navigationGuard` Svelte action (`use:navigationGuard`) intercepting internal link clicks and external unloads.
  - Add `createNavigationGuard` Svelte 5 rune state manager for programmatic navigation interception.
  - Re-export dirty tracking utilities from core and provide complete TypeScript typings.
