# @pixerate/editor-svelte

## 0.3.3

### Patch Changes

- efe499a: Enhance SpreadsheetEditor column resizing with enlarged hit target, visual hover and active indicator guidelines, global drag cursor styles, trailing spacer column to avoid automatic full-width stretching, and onColumnResize callback.
- Updated dependencies [73a0740]
  - @pixerate/editor@0.4.2

## 0.3.2

### Patch Changes

- 3fa68c9: Add `loadDocument` and `syncWithDataSource` methods to `SpreadsheetController`, `createReactiveSpreadsheet`, and `useSpreadsheetEditor`. Deep clones loaded documents to prevent reactive proxy mutation cascades.
- Updated dependencies [3fa68c9]
  - @pixerate/editor@0.4.1

## 0.3.1

### Patch Changes

- 692082a: Fix FormulaBar sheetState binding and add showFormulaBar/class props to SpreadsheetEditor
- 86a3944: Fix SpreadsheetEditor customCellRenderer snippet argument passing to support both positional and object destructuring, and add readonly prop alias.

## 0.3.0

### Minor Changes

- 3edfea4: Add generic spreadsheet editor with pure TypeScript formula engine, reactive dependency graph, data source two-way binding, and cross-framework Svelte 5 and React components.

### Patch Changes

- Updated dependencies [3edfea4]
  - @pixerate/editor@0.4.0

## 0.2.5

### Patch Changes

- c0348c6: Add native Mention extension with atomic inline node, extraction, and serializers; add Notion markdown input rules for TaskItem and Link; fix BubbleMenu plugin registration and sizing.
- Updated dependencies [c0348c6]
  - @pixerate/editor@0.3.0

## 0.2.4

### Patch Changes

- 470bd25: Point svelte entry and export condition to pre-bundled dist/index.js instead of raw TypeScript src/index.ts to ensure compatibility with Vite optimize-svelte and Storybook Svelte bundler.

## 0.2.3

### Patch Changes

- Updated dependencies [fac79d3]
  - @pixerate/editor@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [c1113ed]
  - @pixerate/editor@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [169b363]
  - @pixerate/editor@0.2.1

## 0.2.0

### Minor Changes

- 654701d: Initial release of the UI-agnostic rich text and prompt media editing engine with JavaScript, React, and Svelte packages.

### Patch Changes

- Updated dependencies [654701d]
  - @pixerate/editor@0.2.0
