---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add one command system for shortcuts, a command palette and agent tools.

- **Core (`@pixerate/editor/commands`, new subpath with no third-party imports)**:
  - `CommandRegistry`: commands have `enabled(ctx, params)` that returns `true` or a reason, JSON Schema `params` (unknown keys are rejected with a message naming the accepted ones), `undoable` (runs inside `history.batch`, so a failure rolls back its partial changes), and structured `execute` / `executeAsync` results. It also provides `list({ scope, enabledOnly })` and `subscribe` / `invalidate`.
  - `ShortcutMap`: platform-neutral chords (`Mod` is ⌘ on macOS and Ctrl elsewhere) matched on `event.code`, scoped bindings that win over global ones, a guard against firing in text inputs, user overrides, `findConflicts(platform)` and `formatShortcut`.
  - Palette helpers: `rankCommands`, `fuzzyMatch` and `pushRecent`, plus `createCommandPaletteController`.
  - `createCommandToolProvider`: exposes `list_commands`, `run_command` and `run_commands` (ordered, not atomic) to a `ToolRegistry`.
  - Built-in command helpers: `createHistoryCommands`, `createArrangeCommands` and `createSpreadsheetCommands`.
- **Core (agent)**: every built-in agent tool (rich text, spreadsheet and the static editor tools) now has a `title` and the complete set of MCP annotation hints.
- **Core (canvas)**: `matchArrangeShortcut` now uses `ShortcutMap`. Its exports are unchanged and `Mod` still matches ⌘ or Ctrl. Without Alt, a letter key that produces a different Latin letter (AZERTY, QWERTZ, Dvorak) now matches that letter instead of its physical position.
- **React** (`@pixerate/editor-react/commands`, also exported from the root entry): adds `CommandPalette`, `useCommandPalette` (optional `hotkey`, e.g. `Mod+K`), `useCommandShortcuts` and `useRegisterCommands`.
- **Svelte** (`@pixerate/editor-svelte/commands`, also exported from the root entry): adds `CommandPalette`, `createCommandPalette`, `createCommandShortcuts` and `useRegisterCommands`.
- **History shortcuts**: `useHistoryShortcuts` and `createHistoryShortcuts` now use the shared history keymap and match `event.code`. Mod+Z, Mod+Shift+Z and Mod+Y (off macOS) work as before. Chords with extra modifiers, such as Mod+Alt+Z, no longer trigger undo.
