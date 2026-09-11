# @pixerate/editor-svelte

## 0.5.0

### Minor Changes

- 0c99010: Add canvas node explosion and collapse capabilities to `@pixerate/editor-svelte/canvas`:
  - `createCanvasExplosion` rune managing node expansion lifecycle, snapshots, and reversibility.
  - Spatial layout displacement solvers: `calculateDirectionalDisplacement` and `calculateReflowDisplacement` (Dagre-based).
  - Parametric trajectory path generators: `createFanOutTrajectory`, `linearTrajectory`, and `createBezierTrajectory`.
  - Multi-node coordinated transition runner `runMultiNodeTransition` with zero per-frame array allocations.

## 0.4.0

### Minor Changes

- 1412e85: Add headless Svelte 5 runes canvas toolkit under `@pixerate/editor-svelte/canvas`. Includes `createCanvasGraph`, `createCanvasClipboard`, `createCanvasDocking`, `createCanvasShortcuts`, `createCanvasInteractions`, and Dagre hierarchical layout utilities.

## 0.3.12

### Patch Changes

- e556a34: Configure placeholder extension via richTextOptions in initiateEditor to prevent duplicate extension warning in TipTap.

## 0.3.11

### Patch Changes

- 0557d6b: Support double-clicking column header edge to size to fit in spreadsheet view
- Updated dependencies [0557d6b]
  - @pixerate/editor@0.4.5

## 0.3.10

### Patch Changes

- aa0d0e4: Add dark:prose-invert, dark placeholder styling, and editorClass prop to EditableTextNodeEditor

## 0.3.9

### Patch Changes

- 878ae7a: Ensure spreadsheet columns can be reduced and collapsed with explicit inline styles and style block rules on table cells, and align controller min width constraint to 30px
- Updated dependencies [878ae7a]
  - @pixerate/editor@0.4.4

## 0.3.8

### Patch Changes

- d848090: Allow spreadsheet columns to collapse below text natural width with text truncation and max-w-0 on table cells

## 0.3.7

### Patch Changes

- 7c71228: Optimize spreadsheet column resize performance with requestAnimationFrame and transition-colors, and improve column header hover cursor and divider visual indicator

## 0.3.6

### Patch Changes

- 3d69855: Fix column resize handle positioning and hit area centering over column borders across Tailwind environments.

## 0.3.5

### Patch Changes

- Updated dependencies [5faaf5d]
  - @pixerate/editor@0.4.3

## 0.3.4

### Patch Changes

- 336456c: Add onColumnResize to SpreadsheetEditorProps in TypeScript definitions and React implementation.

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
