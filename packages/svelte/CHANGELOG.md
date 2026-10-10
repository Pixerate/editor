# @pixerate/editor-svelte

## 0.17.1

### Patch Changes

- Updated dependencies [0a1a841]
  - @pixerate/editor@0.16.1

## 0.17.0

### Minor Changes

- 869b4d4: **Breaking:** TipTap's core packages are now peer dependencies, so your app and these packages share a single TipTap/ProseMirror instance. Install them alongside the editor packages (npm 7+ and pnpm install peer dependencies automatically):

  ```bash
  # core / Svelte
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5
  # React
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5 @tiptap/react@^2.11.5
  ```

  Previously each package pulled in its own `@tiptap/core` and `@tiptap/pm`, and `@pixerate/editor-react` allowed TipTap v3 while core required v2. That could install two ProseMirror copies, which breaks `instanceof` checks and loads v2 extensions into a v3 editor. The untested `^3.0.0` range has been removed from `@pixerate/editor-react`; all packages now target TipTap `^2.11.5`.

### Patch Changes

- Updated dependencies [869b4d4]
  - @pixerate/editor@0.16.0

## 0.16.2

### Patch Changes

- c949fd9: **Breaking (core):** the root `@pixerate/editor` entry no longer re-exports the canvas, agent or image editor modules. Import them from their subpaths:

  ```diff
  - import { ensureLayout, ImageEditorController, planAgentCommand } from "@pixerate/editor";
  + import { ensureLayout } from "@pixerate/editor/canvas";
  + import { ImageEditorController } from "@pixerate/editor/image-editor";
  + import { planAgentCommand } from "@pixerate/editor/agent";
  ```

  The root entry therefore no longer loads `@dagrejs/dagre` or the Canvas 2D image renderer. The core build now uses code splitting, so subpath entries share a single copy of common modules. Previously each entry bundled its own copy, which created duplicate singletons such as `globalImageCache` and broke `instanceof` checks across entries. The React and Svelte image editors now import from `@pixerate/editor/image-editor`.

- Updated dependencies [c949fd9]
  - @pixerate/editor@0.15.0

## 0.16.1

### Patch Changes

- ac4f459: Add package READMEs (installation, API overview and Tailwind styling requirements) so the npm package pages are no longer empty.
- Updated dependencies [ac4f459]
  - @pixerate/editor@0.14.3

## 0.16.0

### Minor Changes

- a91ad86: Ship Svelte components as sources built with `@sveltejs/package`, replacing the precompiled `tsup` + `esbuild-svelte` bundle.

  - **SSR works**: components are compiled by your bundler for both client and server. Previously the package shipped client-only output, so SvelteKit SSR threw `document is not defined`.
  - **Component styles are included**: scoped `<style>` blocks (editor placeholder, spreadsheet column-resize handle) were previously emitted to an unexported `dist/index.css` and silently lost.
  - **Accurate generated types**: `.d.ts` files are generated from the source instead of hand-written. This fixes unresolved `ImageOptions` / `HistoryManager` / `ReactiveImageEditor` types and adds missing declarations, including `AgentPresenceLayer`, `createStreamingCanvas`, `ensureLayout`, `placeBeside`, `ManualClock`, `DockStrategy`, the `ImageEditor` AI hook props and the `BubbleMenu` `shouldShow` / `tippyOptions` / `updateDelay` / `pluginKey` props.
  - **No longer coupled to Svelte internals**: the compiled output depended on private `svelte/internal/client` APIs from the exact Svelte version used to build it.
  - **Breaking:** the `svelte` peer dependency is now `^5.0.0`. The previous `^4.0.0 || ^5.0.0` range was inaccurate, since every component uses runes.

## 0.15.3

### Patch Changes

- Updated dependencies [ea4dd6d]
  - @pixerate/editor@0.14.2

## 0.15.2

### Patch Changes

- Updated dependencies [6a369fc]
  - @pixerate/editor@0.14.1

## 0.15.1

### Patch Changes

- Updated dependencies [743f096]
  - @pixerate/editor@0.14.0

## 0.15.0

### Minor Changes

- 47db314: Add AI inpainting and background removal hooks and tool panel support:
  - **Core Canvas 2D Engine**:
    - Add `renderMask(options)` and `toMaskDataURL(options)` to render binary black-and-white inpaint masks from active crop boxes and/or vector annotations (pen strokes dilated, rects/circles filled).
    - Add `applyInpaintedImage(newDataUrl)` and `applyBackgroundRemovedImage(newDataUrl)` on `ImageEditorController` with history tracking and auto-cleanup.
    - Define `InpaintOptions`, `RemoveBackgroundOptions`, `InpaintHook`, `RemoveBackgroundHook`, and `ImageEditorAIHooks`.
  - **Svelte 5 Support**:
    - Add `onInpaint`, `onRemoveBackground`, and `aiHooks` props to `ImageEditor.svelte`.
    - Add AI Tools sidebar panel with background removal button/spinner, inpainting prompt textarea, target mask mode switcher (drawn shapes vs crop box), inpaint trigger button, and status/error indicators.
    - Expose mask rendering and AI application methods on `createReactiveImageEditor`.
  - **React Support**:
    - Expose mask rendering and AI application methods on `useImageEditor` hook.
    - Add 1:1 matching AI Tools sidebar panel, props, and handlers to `ImageEditor.tsx`.

### Patch Changes

- Updated dependencies [47db314]
  - @pixerate/editor@0.13.0

## 0.14.0

### Minor Changes

- ce828f8: Add UI-agnostic Canvas 2D image editor engine with cross-framework parity across Vanilla JS, React, and Svelte 5:
  - **Core Canvas 2D Engine**: persistent interactive crop overlay with 8 resize handles, aspect ratio locking, geometric hit-testing, transformations (rotate, flip), color adjustments (brightness, contrast, saturation, exposure, temperature, blur, opacity), drawing and annotation vector layers with live draft camera projection (pen, rect, circle, arrow, line, text), zoom/pan viewport, live compare mode, and JSON state serialization.
  - **Gleamforge Depth Alpha Masking**: threshold and brightness depth alpha blending with softness, invert, and `removeAlpha`.
  - **React Support**: `useImageEditor` hook and `<ImageEditor />` component with interactive crop box dragging, handle resizing, live annotation preview, top toolbars, and side control panels.
  - **Svelte 5 Support**: `createReactiveImageEditor` rune helper and `<ImageEditor />` component with 1:1 functional parity.

### Patch Changes

- Updated dependencies [ce828f8]
  - @pixerate/editor@0.12.0

## 0.13.0

### Minor Changes

- ce112c2: Add deterministic animation clock, streaming view stabilization, and agent vision/narration features:
  - Core: `Clock`, `realClock`, and `ManualClock` for step-by-step frame animation testing and deterministic trajectories.
  - Core: Streaming stabilization math including `layoutBounds`, `canvasHeight`, `estimateCanvasHeight`, `blendLayout`, and `connectedOnly`.
  - Core: `MCP_TOOL_VIEW_EDITOR` and `EXPORT_EXCLUDED_SELECTORS` for multimodal evaluation without cursor artifact loops.
  - Core: Choreography `say` and `wait` command planning with `note` support on `AgentPresence`.
  - React & Svelte: `AgentPresenceLayer` speech bubbles and presence exclusion classes.
  - React & Svelte: `useStreamingCanvas` and `createStreamingCanvas` with `connectedOnly` and `clock` options.

### Patch Changes

- Updated dependencies [ce112c2]
  - @pixerate/editor@0.11.0

## 0.12.0

### Minor Changes

- 09e2459: Add canvas math primitives, smart collision-avoiding layout, agent planning & MCP tools, streaming canvas gliding, and slot component inversion:

  - **Core Canvas Extraction**: Extracted graph layout, trajectory animations, directional displacement, and clipboard serialization into `@pixerate/editor/canvas`.
  - **Smart Layout & Collision Avoidance**: Implemented `ensureLayout` (centroid-based incremental layout blending) and `placeBeside` (spiral raycast collision avoidance).
  - **React Canvas Parity**: Implemented `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasShortcuts`, `useCanvasDocking`, and `useCanvasExplosion` in `@pixerate/editor-react/canvas`.
  - **Agent Director & MCP Layer**: Added `planAgentCommand`, MCP tool definitions (`get_editor_state`, `edit_canvas`, `edit_prompt`), and `<AgentPresenceLayer />` for visual multi-agent cursor choreography in both React and Svelte.
  - **Streaming Viewers**: Added `StreamingLayoutManager`, `useStreamingCanvas` (React), and `createStreamingCanvas` (Svelte) for throttled auto-layout with tweened node gliding during rapid streams.
  - **Slot-Based Inversion**: Added `EditorSlotsProvider` and `useEditorSlots` to allow zero-fork injection of custom design system components.

### Patch Changes

- Updated dependencies [09e2459]
  - @pixerate/editor@0.10.0

## 0.11.1

### Patch Changes

- Updated dependencies [3f1e332]
  - @pixerate/editor@0.9.0

## 0.11.0

### Minor Changes

- a51d55a: Add canvas node synchronization, multi-drag coordination, selection helpers, and floating horizontal scrollbar

  - `createCanvasNodeSync`: Headless rune for synchronizing reactive item collections into SvelteFlow nodes/edges with untracked node reads to prevent effect cycle crashes, handle normalization (`normalizeNodeHandles`), and dimension preservation (`preserveNodeMeasurements`).
  - `createCanvasMultiDrag`: Multi-node drag coordination rune with leader-follower relative offset tracking, dynamic z-indexing, fan-out rotations (`fanning`), and coordinate restoration on canceled drops.
  - `createCanvasSelection` & `getMarqueeSelectionPreset`: Canvas marquee drag-to-select configuration presets and Escape-key deselect helpers.
  - `FloatingHorizontalScrollbar`: Docked overlay horizontal scrollbar for wide canvas viewports with bidirectional sync and custom viewport bounds.

## 0.10.1

### Patch Changes

- Updated dependencies [4bcf5f0]
  - @pixerate/editor@0.8.1

## 0.10.0

### Minor Changes

- fba3d0d: feat(history): add generalizable undo/redo HistoryManager with React and Svelte adapters

  - Introduced framework-agnostic `HistoryManager` with bounded undo/redo stacks, atomic `batch()` transactions, continuous-event coalescing (`executeMerged`), and `createSnapshotCommand()` helper.
  - Added `@pixerate/editor-react` hooks: `useHistory()` (powered by `useSyncExternalStore`) and `useHistoryShortcuts()` with active input focus guards.
  - Added `@pixerate/editor-svelte` adapters: `createHistory()` (dual Svelte 5 rune and store contract support) and `createHistoryShortcuts()`.
  - 100% backward compatible and completely optional for consumers to adopt.

### Patch Changes

- Updated dependencies [fba3d0d]
  - @pixerate/editor@0.8.0

## 0.9.0

### Minor Changes

- 943b59c: Add dirty state tracking and navigation guards across Core, React, and Svelte packages:

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

### Patch Changes

- Updated dependencies [943b59c]
  - @pixerate/editor@0.7.0

## 0.8.1

### Patch Changes

- db73d55: feat(image): add maxBase64Size enforcement, onUploadError callback, and optimistic node cleanup on upload failure
- Updated dependencies [db73d55]
  - @pixerate/editor@0.6.1

## 0.8.0

### Minor Changes

- 25f0707: feat: add Image extension and clipboard paste/drop handling to editor and EditableTextNodeEditor

### Patch Changes

- Updated dependencies [25f0707]
  - @pixerate/editor@0.6.0

## 0.7.2

### Patch Changes

- 8a2e88d: fix(svelte): expose autofocus prop on EditableTextNodeEditor in index.d.ts

## 0.7.1

### Patch Changes

- f1aee60: fix(svelte): disable default autofocus in initiateEditor and expose autofocus prop on EditableTextNodeEditor

## 0.7.0

### Minor Changes

- 132f54b: Add multi-target disambiguation (`dockStrategy`, `resolvePrimaryDockTarget`) and `exclusiveHover` management to `createCanvasDocking`

## 0.6.1

### Patch Changes

- Updated dependencies [f0924c4]
  - @pixerate/editor@0.5.1

## 0.6.0

### Minor Changes

- e32b1ff: Add built-in optional Markdown support, serializers, and controller synchronization:
  - Export `Markdown` extension and `MarkdownOptions` configuration in `@pixerate/editor`.
  - Add `markdown?: MarkdownOptions | boolean` to `createRichTextPreset`.
  - Export `markdownToTipTapHtml` and `getEditorMarkdown` from `@pixerate/editor/serializers`.
  - Add `markdownMode`, `getMarkdown()`, `setMarkdown()`, and `onMarkdownChange` to `EditorController`.
  - Expose `markdown` and `richTextOptions` in `EditableTextNodeEditor` in `@pixerate/editor-svelte`.

### Patch Changes

- Updated dependencies [e32b1ff]
  - @pixerate/editor@0.5.0

## 0.5.5

### Patch Changes

- 7fbba7f: Add comprehensive multi-frame animation tests verifying continuous position advancement, edge opacity synchronization, and sibling node isolation.

## 0.5.4

### Patch Changes

- b422853: Fix node position and opacity synchronization during explosion and collapse transitions without freezing or breaking object references

## 0.5.3

### Patch Changes

- 05f9932: Animate opacity alongside position during canvas node explosion and collapse transitions, maintaining sibling node visibility with linearPositionTrajectory

## 0.5.2

### Patch Changes

- ed4f16c: Ensure vertical canvas displacement expands symmetrically by displacing nodes both above and below equally

## 0.5.1

### Patch Changes

- 43d61e0: Add vertical row displacement to canvas explosion solvers:
  - Add `'vertical'` to `DisplacementDirection` in `@pixerate/editor-svelte/canvas` to expand exploded rows vertically without horizontal coordinate shifts.
  - Symmetrically shift nodes above upward and nodes below downward based on child cluster bounding box.
  - Support `minY` constraint to prevent upward displacement from clipping past top boundaries or headers, transferring unmet upward displacement to downward clearance.

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
