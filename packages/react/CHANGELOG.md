# @pixerate/editor-react

## 0.9.3

### Patch Changes

- Updated dependencies [ea4dd6d]
  - @pixerate/editor@0.14.2

## 0.9.2

### Patch Changes

- Updated dependencies [6a369fc]
  - @pixerate/editor@0.14.1

## 0.9.1

### Patch Changes

- Updated dependencies [743f096]
  - @pixerate/editor@0.14.0

## 0.9.0

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

## 0.8.0

### Minor Changes

- ce828f8: Add UI-agnostic Canvas 2D image editor engine with cross-framework parity across Vanilla JS, React, and Svelte 5:
  - **Core Canvas 2D Engine**: persistent interactive crop overlay with 8 resize handles, aspect ratio locking, geometric hit-testing, transformations (rotate, flip), color adjustments (brightness, contrast, saturation, exposure, temperature, blur, opacity), drawing and annotation vector layers with live draft camera projection (pen, rect, circle, arrow, line, text), zoom/pan viewport, live compare mode, and JSON state serialization.
  - **Gleamforge Depth Alpha Masking**: threshold and brightness depth alpha blending with softness, invert, and `removeAlpha`.
  - **React Support**: `useImageEditor` hook and `<ImageEditor />` component with interactive crop box dragging, handle resizing, live annotation preview, top toolbars, and side control panels.
  - **Svelte 5 Support**: `createReactiveImageEditor` rune helper and `<ImageEditor />` component with 1:1 functional parity.

### Patch Changes

- Updated dependencies [ce828f8]
  - @pixerate/editor@0.12.0

## 0.7.0

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

## 0.6.0

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

## 0.5.2

### Patch Changes

- Updated dependencies [3f1e332]
  - @pixerate/editor@0.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [4bcf5f0]
  - @pixerate/editor@0.8.1

## 0.5.0

### Minor Changes

- fba3d0d: feat(history): add generalizable undo/redo HistoryManager with React and Svelte adapters

  - Introduced framework-agnostic `HistoryManager` with bounded undo/redo stacks, atomic `batch()` transactions, continuous-event coalescing (`executeMerged`), and `createSnapshotCommand()` helper.
  - Added `@pixerate/editor-react` hooks: `useHistory()` (powered by `useSyncExternalStore`) and `useHistoryShortcuts()` with active input focus guards.
  - Added `@pixerate/editor-svelte` adapters: `createHistory()` (dual Svelte 5 rune and store contract support) and `createHistoryShortcuts()`.
  - 100% backward compatible and completely optional for consumers to adopt.

### Patch Changes

- Updated dependencies [fba3d0d]
  - @pixerate/editor@0.8.0

## 0.4.0

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

## 0.3.13

### Patch Changes

- Updated dependencies [db73d55]
  - @pixerate/editor@0.6.1

## 0.3.12

### Patch Changes

- Updated dependencies [25f0707]
  - @pixerate/editor@0.6.0

## 0.3.11

### Patch Changes

- Updated dependencies [f0924c4]
  - @pixerate/editor@0.5.1

## 0.3.10

### Patch Changes

- Updated dependencies [e32b1ff]
  - @pixerate/editor@0.5.0

## 0.3.9

### Patch Changes

- 0557d6b: Support double-clicking column header edge to size to fit in spreadsheet view
- Updated dependencies [0557d6b]
  - @pixerate/editor@0.4.5

## 0.3.8

### Patch Changes

- 878ae7a: Ensure spreadsheet columns can be reduced and collapsed with explicit inline styles and style block rules on table cells, and align controller min width constraint to 30px
- Updated dependencies [878ae7a]
  - @pixerate/editor@0.4.4

## 0.3.7

### Patch Changes

- d848090: Allow spreadsheet columns to collapse below text natural width with text truncation and max-w-0 on table cells

## 0.3.6

### Patch Changes

- 7c71228: Optimize spreadsheet column resize performance with requestAnimationFrame and transition-colors, and improve column header hover cursor and divider visual indicator

## 0.3.5

### Patch Changes

- 3d69855: Fix column resize handle positioning and hit area centering over column borders across Tailwind environments.

## 0.3.4

### Patch Changes

- Updated dependencies [5faaf5d]
  - @pixerate/editor@0.4.3

## 0.3.3

### Patch Changes

- 336456c: Add onColumnResize to SpreadsheetEditorProps in TypeScript definitions and React implementation.

## 0.3.2

### Patch Changes

- Updated dependencies [73a0740]
  - @pixerate/editor@0.4.2

## 0.3.1

### Patch Changes

- 3fa68c9: Add `loadDocument` and `syncWithDataSource` methods to `SpreadsheetController`, `createReactiveSpreadsheet`, and `useSpreadsheetEditor`. Deep clones loaded documents to prevent reactive proxy mutation cascades.
- Updated dependencies [3fa68c9]
  - @pixerate/editor@0.4.1

## 0.3.0

### Minor Changes

- 3edfea4: Add generic spreadsheet editor with pure TypeScript formula engine, reactive dependency graph, data source two-way binding, and cross-framework Svelte 5 and React components.

### Patch Changes

- Updated dependencies [3edfea4]
  - @pixerate/editor@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies [c0348c6]
  - @pixerate/editor@0.3.0

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

- 169b363: - Fix CJS/ESM interop for StarterKit and Placeholder
  - Support resilient Suggestion unwrapping
  - Implement slash command keyboard navigation and paste handling
  - Implement native BubbleMenu using BubbleMenuPlugin for TipTap v2 and v3 compatibility
  - Support number and string version values in Template types
  - Widen @tiptap/* dependencies to support ^2.11.5 || ^3.0.0
- Updated dependencies [169b363]
  - @pixerate/editor@0.2.1

## 0.2.0

### Minor Changes

- 654701d: Initial release of the UI-agnostic rich text and prompt media editing engine with JavaScript, React, and Svelte packages.

### Patch Changes

- Updated dependencies [654701d]
  - @pixerate/editor@0.2.0
