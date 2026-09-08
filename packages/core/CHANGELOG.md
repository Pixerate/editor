# @pixerate/editor

## 0.4.2

### Patch Changes

- 73a0740: Add inline standard linear-gradient and background-clip styles to GradientText decoration for framework and CSS version resilience

## 0.4.1

### Patch Changes

- 3fa68c9: Add `loadDocument` and `syncWithDataSource` methods to `SpreadsheetController`, `createReactiveSpreadsheet`, and `useSpreadsheetEditor`. Deep clones loaded documents to prevent reactive proxy mutation cascades.

## 0.4.0

### Minor Changes

- 3edfea4: Add generic spreadsheet editor with pure TypeScript formula engine, reactive dependency graph, data source two-way binding, and cross-framework Svelte 5 and React components.

## 0.3.0

### Minor Changes

- c0348c6: Add native Mention extension with atomic inline node, extraction, and serializers; add Notion markdown input rules for TaskItem and Link; fix BubbleMenu plugin registration and sizing.

## 0.2.3

### Patch Changes

- fac79d3: Align TipTap dependencies to ^2.11.5 to prevent npm peer dependency resolution conflicts with @pixerate/editor-svelte

## 0.2.2

### Patch Changes

- c1113ed: Fix TextStyle interop import across TipTap v2 and v3

## 0.2.1

### Patch Changes

- 169b363: - Fix CJS/ESM interop for StarterKit and Placeholder
  - Support resilient Suggestion unwrapping
  - Implement slash command keyboard navigation and paste handling
  - Implement native BubbleMenu using BubbleMenuPlugin for TipTap v2 and v3 compatibility
  - Support number and string version values in Template types
  - Widen @tiptap/* dependencies to support ^2.11.5 || ^3.0.0

## 0.2.0

### Minor Changes

- 654701d: Initial release of the UI-agnostic rich text and prompt media editing engine with JavaScript, React, and Svelte packages.
