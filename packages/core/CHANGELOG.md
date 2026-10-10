# @pixerate/editor

## 0.18.0

### Minor Changes

- 1166e77: Fix several canvas, history and agent-planner engine bugs.

  - **`StreamingLayoutManager`**: `pushStreamUpdate` is now a real throttle (leading + trailing edge) instead of a debounce, so layouts keep running at most once per `throttleMs` during a continuous stream. Glides now animate known nodes from their current position to the newly computed layout. Previously every known node was pinned to its current position, so no glide ever ran. Only `layoutOptions.storedPositions` are treated as pinned. Added `getTargetPositions()`.
  - **`runMultiNodeTransition`** (core and the Svelte fork): no longer mutates the input nodes, and handles object styles (React Flow / xyflow) as well as CSS-string styles. Before this fix, an object `style` threw an error. **Behavior change:** updated node copies are passed to `onUpdate(nodes)` and `onComplete(nodes)`, in the same order as `transitions`. If your code read the mutated input nodes, merge these copies by `id` instead. A new `styleFormat: 'string' | 'object'` option controls the style created for nodes that have none (default `'string'`). `useCanvasExplosion` (React) passes `'object'`. Added the `withStyleOpacity` helper and the `CanvasNodeStyle` type. `CanvasNode.style` is now `string | Record<string, any>`.
  - **Canvas clipboard**: `isValidCanvasNode` now requires `position.x` and `position.y` to be finite numbers. A string like `"1e3"` is rejected. A non-array or malformed `edges` payload is ignored instead of crashing. `remapPastedNodes` remaps `parentId` (and the legacy `parentNode`) to the new parent ID when the parent was pasted too. In that case the child keeps its parent-relative position. Added `isValidCanvasEdge`. The Svelte `createCanvasClipboard` paste handler gets the same fixes.
  - **`HistoryManager`**: if `batch(fn)` throws, the commands that already ran in the batch are rolled back in reverse order, nothing is pushed, and the error is rethrown. If a command's `undo`/`redo` throws, the command stays on its original stack and the error is rethrown.
  - **Agent planner**: `canvas:add_node` accepts the schema's `side` values `top` and `bottom`, plus `above` and `below`. Before, `top` was treated as below. `canvas:layout` now defaults `incremental` to `true`, as the `edit_canvas` tool schema says. An unknown `nearNodeId` no longer adds a dangling edge. Added `normalizeSide`.

## 0.17.0

### Minor Changes

- ee94411: Spreadsheet engine correctness fixes (`SpreadsheetController` and the formula engine):

  - **Recalculation order and cycles:** recalculation now follows dependency order, so loading a document where `A1` = `=A2*2` and `A2` = `=3+1` gives 8, not 0. Every cell in a reference cycle is marked `#CYCLE!`, and it stays marked across inserts, undo and full recalculations. Cells depending on a cycle show `#CYCLE!` too. Breaking the cycle recalculates every member. The dependency graph is rebuilt on full recalculation instead of keeping stale keys.
  - **Inserting and deleting rows or columns rewrites references**, like spreadsheet apps. References after the change shift, ranges grow or shrink, references to a deleted row or column become `#REF!`, and `$` markers are kept. The new `shiftFormulaReferences(formula, change)` helper is exported.
  - **`[property]` references** in column formulas resolve against the row being evaluated. Previously they used the selected cell's row, giving every row the same value.
  - **Formula semantics** now follow spreadsheet conventions:
    - Errors propagate: `=1/0+1` gives `#DIV/0!`, not `NaN`, and `#REF!` literals are supported.
    - Unknown names and functions give `#NAME?`.
    - Unterminated strings and unexpected characters are formula errors.
    - `$A$1:$B$2` and whole-column ranges such as `A:A` now work.
    - `MIN`, `MAX` and `SUM` handle very large ranges without overflowing the stack.
    - `ROUND` rounds half away from zero without float drift: `ROUND(-2.5)` gives -3 and `ROUND(1.005, 2)` gives 1.01.
    - `IF` accepts the text `"TRUE"`/`"FALSE"`; other text gives `#VALUE!`.
    - Comparisons are type-aware: `"1"=1` is FALSE, and text comparisons are case-insensitive.
    - Blank cells act as `""` in text and 0 in arithmetic, so `=""&A1` is `""`.
    - `TODAY()` returns the local date.
  - **TSV import (paste):** a paste is now a single undo step, recalculates once, keeps leading empty cells (`"\tB"` puts B in column B), and grows the grid without shifting references. Large pastes are dramatically faster: a 3,000-row formula chain dropped from minutes to under 100ms.
  - `undo()` / `redo()` no longer leave the controller stuck in history mode if recalculation throws.

  **Behavior changes:**
  - Formulas referencing unknown bare names now return `#NAME?` instead of the name as text.
  - Blank cells are passed to formulas as `""` instead of `0`.
  - `tokenizeFormula` throws on unterminated strings and unexpected characters.

## 0.16.2

### Patch Changes

- a8f80dd: Fix spreadsheet keyboard handling in React and Svelte:

  - **Formula bar:** keystrokes no longer fall through to the grid. Previously Backspace in the formula bar cleared the active cell, arrow keys moved the cursor, and Enter re-opened the cell editor. In React, typing in the formula bar now actually edits the value; it commits on Enter or blur and is discarded on Escape. The formula bar is read-only for read-only sheets and columns.
  - **Redo:** Cmd/Ctrl+Shift+Z now redoes (with Shift held, `e.key` is `"Z"`), and Ctrl+Y is supported.
  - **Copy:** Cmd/Ctrl+C copies the selected range instead of the whole sheet. `SpreadsheetController.exportToTsv(range?)` accepts an optional range.
  - **React column resize:** `onColumnResize` now fires when the pointer stops moving before mouseup. Previously the effect re-subscribed after every width update and lost the drag state.
  - **React `useSpreadsheetEditor`:** the initial `document` now reflects the controller, so `<SpreadsheetEditor />` without a document renders the default grid immediately instead of an empty table. The `onDocumentChange`, `onSelectionChange` and `onCellCommit` callbacks are no longer captured once at mount.

## 0.16.1

### Patch Changes

- 0a1a841: Fix `usePromptEditor` lifecycle bugs:

  - Passing `templateColorMap` inline (`new Map(...)` in render) no longer causes an infinite render loop ("Maximum update depth exceeded"). The map is now compared by value.
  - Toggling `isEditing`, or changing `placeholder`, `className` or `jsonVariables`, updates the live editor instead of destroying and recreating it. Undo history, focus and the caret are kept.
  - `content` is now applied when the parent changes it, so you can clear the editor after submit with `setPrompt("")`. Echoes of the editor's own `onContentChange` are ignored, so typing never resets the caret.
  - Milestones use the core tokenizer, so `__award_winning__` now fires `used_magic`. Each milestone fires once per mount instead of on every keystroke.
  - Plain-text paste handling uses the new core `plainTextToSlice` helper, which replaces two duplicated copies. Core now exports `plainTextToSlice(text, schema)` from its serializers.

## 0.16.0

### Minor Changes

- 869b4d4: **Breaking:** TipTap's core packages are now peer dependencies, so your app and these packages share a single TipTap/ProseMirror instance. Install them alongside the editor packages (npm 7+ and pnpm install peer dependencies automatically):

  ```bash
  # core / Svelte
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5
  # React
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5 @tiptap/react@^2.11.5
  ```

  Previously each package pulled in its own `@tiptap/core` and `@tiptap/pm`, and `@pixerate/editor-react` allowed TipTap v3 while core required v2. That could install two ProseMirror copies, which breaks `instanceof` checks and loads v2 extensions into a v3 editor. The untested `^3.0.0` range has been removed from `@pixerate/editor-react`; all packages now target TipTap `^2.11.5`.

## 0.15.0

### Minor Changes

- c949fd9: **Breaking (core):** the root `@pixerate/editor` entry no longer re-exports the canvas, agent or image editor modules. Import them from their subpaths:

  ```diff
  - import { ensureLayout, ImageEditorController, planAgentCommand } from "@pixerate/editor";
  + import { ensureLayout } from "@pixerate/editor/canvas";
  + import { ImageEditorController } from "@pixerate/editor/image-editor";
  + import { planAgentCommand } from "@pixerate/editor/agent";
  ```

  The root entry therefore no longer loads `@dagrejs/dagre` or the Canvas 2D image renderer. The core build now uses code splitting, so subpath entries share a single copy of common modules. Previously each entry bundled its own copy, which created duplicate singletons such as `globalImageCache` and broke `instanceof` checks across entries. The React and Svelte image editors now import from `@pixerate/editor/image-editor`.

## 0.14.3

### Patch Changes

- ac4f459: Add package READMEs (installation, API overview and Tailwind styling requirements) so the npm package pages are no longer empty.

## 0.14.2

### Patch Changes

- ea4dd6d: Sanitize raw HTML in `markdownToTipTapHtml` (also used by `EditorController.setMarkdown` and markdown-mode initial content).

  - Raw HTML embedded in markdown is now restricted to an allowlist of tags and attributes. Event handlers (`onerror`, `onclick`, …), `style`, and unsafe URL schemes (`javascript:`, including entity- and whitespace-obfuscated forms) are removed. Disallowed tags such as `<script>`, `<iframe>` and `<style>` are rendered as escaped text.
  - Mention spans, `data-*` attributes, file/vscode/cursor links and task-list checkboxes keep working, so markdown round-trips are unaffected.
  - `preprocessMarkdownFileLinks` now escapes link hrefs and labels, so a crafted `[x](file:///a"onmouseover="…)` can no longer inject attributes.
  - Pass `allowUnsafeHtml: true` to restore the previous unsanitized behavior for fully trusted input.

## 0.14.1

### Patch Changes

- 6a369fc: Fix plain-text serialization and literal text insertion:

  - `htmlToPlainText` (and therefore `getEditorText`, `EditorController.getPlainText`, `onPlainTextChange` and dirty tracking) no longer repeats list items (TipTap renders `<li><p>…</p></li>`) and no longer drops code blocks, blockquote content or other text outside the recognised block tags.
  - HTML is now parsed into an inert `<template>` fragment instead of a `<div>` owned by the live document, so `htmlToPlainText` / `extractMentionsFromDoc` on untrusted HTML can no longer trigger `<img onerror>`-style handlers.
  - Mention-span normalization no longer backtracks catastrophically on malformed HTML (previously seconds per keystroke on large inputs).
  - The Node.js fallback decodes `&amp;` last (so `&amp;lt;` stays `&lt;`), no longer trims leading blank lines, and handles nested list paragraphs.
  - `plainTextToTipTapHtml` only passes input through untouched when it is paragraph HTML (starts with `<p>` and ends with `</p>`); plain text that merely contains `<p>` is now escaped.
  - `EditorController.insertText`, `insertTextAt` and `replaceRange` now insert text literally (HTML is not parsed) and split paragraphs on newlines.

## 0.14.0

### Minor Changes

- 743f096: Fix template resolution edge cases:

  - Template bodies containing `$&`, `` $` ``, `$'` or `$$` are now inserted literally. Previously they were treated as `String.replace` patterns, which corrupted output and could hang the resolver forever.
  - **Behavior change:** loop and max-depth errors now replace only the offending tag instead of the whole prompt. `resolveTemplates("Hello {{a}} world")` with a self-referencing `a` now returns `"Hello [Template loop detected] world"`. Use the new `TEMPLATE_LOOP_ERROR` / `TEMPLATE_DEPTH_ERROR` constants with `.includes()` to detect errors.
  - `resolveTemplatesWithMapping` now produces exactly the same text as `resolveTemplates` (it previously expanded loops one level further and ignored `maxDepth`), and accepts an optional `{ maxDepth }` options argument.
  - `mapResolvedOffsetToRaw` / `mapRawOffsetToResolved` now map the end of a trailing template to the end of its tag instead of jumping back to its start.
  - New `getTemplateBody(template, bindings)` helper exposes version-binding resolution.

## 0.13.0

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

## 0.12.0

### Minor Changes

- ce828f8: Add UI-agnostic Canvas 2D image editor engine with cross-framework parity across Vanilla JS, React, and Svelte 5:
  - **Core Canvas 2D Engine**: persistent interactive crop overlay with 8 resize handles, aspect ratio locking, geometric hit-testing, transformations (rotate, flip), color adjustments (brightness, contrast, saturation, exposure, temperature, blur, opacity), drawing and annotation vector layers with live draft camera projection (pen, rect, circle, arrow, line, text), zoom/pan viewport, live compare mode, and JSON state serialization.
  - **Gleamforge Depth Alpha Masking**: threshold and brightness depth alpha blending with softness, invert, and `removeAlpha`.
  - **React Support**: `useImageEditor` hook and `<ImageEditor />` component with interactive crop box dragging, handle resizing, live annotation preview, top toolbars, and side control panels.
  - **Svelte 5 Support**: `createReactiveImageEditor` rune helper and `<ImageEditor />` component with 1:1 functional parity.

## 0.11.0

### Minor Changes

- ce112c2: Add deterministic animation clock, streaming view stabilization, and agent vision/narration features:
  - Core: `Clock`, `realClock`, and `ManualClock` for step-by-step frame animation testing and deterministic trajectories.
  - Core: Streaming stabilization math including `layoutBounds`, `canvasHeight`, `estimateCanvasHeight`, `blendLayout`, and `connectedOnly`.
  - Core: `MCP_TOOL_VIEW_EDITOR` and `EXPORT_EXCLUDED_SELECTORS` for multimodal evaluation without cursor artifact loops.
  - Core: Choreography `say` and `wait` command planning with `note` support on `AgentPresence`.
  - React & Svelte: `AgentPresenceLayer` speech bubbles and presence exclusion classes.
  - React & Svelte: `useStreamingCanvas` and `createStreamingCanvas` with `connectedOnly` and `clock` options.

## 0.10.0

### Minor Changes

- 09e2459: Add canvas math primitives, smart collision-avoiding layout, agent planning & MCP tools, streaming canvas gliding, and slot component inversion:

  - **Core Canvas Extraction**: Extracted graph layout, trajectory animations, directional displacement, and clipboard serialization into `@pixerate/editor/canvas`.
  - **Smart Layout & Collision Avoidance**: Implemented `ensureLayout` (centroid-based incremental layout blending) and `placeBeside` (spiral raycast collision avoidance).
  - **React Canvas Parity**: Implemented `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasShortcuts`, `useCanvasDocking`, and `useCanvasExplosion` in `@pixerate/editor-react/canvas`.
  - **Agent Director & MCP Layer**: Added `planAgentCommand`, MCP tool definitions (`get_editor_state`, `edit_canvas`, `edit_prompt`), and `<AgentPresenceLayer />` for visual multi-agent cursor choreography in both React and Svelte.
  - **Streaming Viewers**: Added `StreamingLayoutManager`, `useStreamingCanvas` (React), and `createStreamingCanvas` (Svelte) for throttled auto-layout with tweened node gliding during rapid streams.
  - **Slot-Based Inversion**: Added `EditorSlotsProvider` and `useEditorSlots` to allow zero-fork injection of custom design system components.

## 0.9.0

### Minor Changes

- 3f1e332: feat(core): add mention parsing, extraction, code-block immunity, and markdown preprocessing

  - Add `preprocessMarkdownMentions` to transform raw markdown `@mentions` into TipTap mention node HTML spans before document creation.
  - Add strict code-block immunity (`MARKDOWN_MENTION_SPLIT_REGEX` and `stripMarkdownCode`) protecting fenced code blocks (``` and ~~~), inline code (`...`), HTML `<pre>`/`<code>` blocks, markdown links (`[text](url)`), and raw URLs from false-positive mention parsing.
  - Add `extractMentions` to extract unique mention handles from text, markdown, or HTML, safely ignoring HTML attributes, URLs, and code blocks.
  - Add `parseMentionSegments` to tokenize content into plain text and mention tokens while preserving punctuation boundaries.
  - Add `preprocessMarkdownFileLinks` and support `MarkdownToHtmlOptions` (`mentionables`, `preprocessMentions`, `preprocessFileLinks`) in `markdownToTipTapHtml`.
  - Enhance `extractMentionsFromDoc` to gracefully fallback to extracting raw mentions when provided plain text or markdown without pre-rendered HTML spans.

## 0.8.1

### Patch Changes

- 4bcf5f0: Allow `file://`, `vscode://`, and `cursor://` link protocols in markdown serializer and rich text preset

## 0.8.0

### Minor Changes

- fba3d0d: feat(history): add generalizable undo/redo HistoryManager with React and Svelte adapters

  - Introduced framework-agnostic `HistoryManager` with bounded undo/redo stacks, atomic `batch()` transactions, continuous-event coalescing (`executeMerged`), and `createSnapshotCommand()` helper.
  - Added `@pixerate/editor-react` hooks: `useHistory()` (powered by `useSyncExternalStore`) and `useHistoryShortcuts()` with active input focus guards.
  - Added `@pixerate/editor-svelte` adapters: `createHistory()` (dual Svelte 5 rune and store contract support) and `createHistoryShortcuts()`.
  - 100% backward compatible and completely optional for consumers to adopt.

## 0.7.0

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

## 0.6.1

### Patch Changes

- db73d55: feat(image): add maxBase64Size enforcement, onUploadError callback, and optimistic node cleanup on upload failure

## 0.6.0

### Minor Changes

- 25f0707: feat: add Image extension and clipboard paste/drop handling to editor and EditableTextNodeEditor

## 0.5.1

### Patch Changes

- f0924c4: Publish built-in markdown support and serializers to npm.

## 0.5.0

### Minor Changes

- e32b1ff: Add built-in optional Markdown support, serializers, and controller synchronization:
  - Export `Markdown` extension and `MarkdownOptions` configuration in `@pixerate/editor`.
  - Add `markdown?: MarkdownOptions | boolean` to `createRichTextPreset`.
  - Export `markdownToTipTapHtml` and `getEditorMarkdown` from `@pixerate/editor/serializers`.
  - Add `markdownMode`, `getMarkdown()`, `setMarkdown()`, and `onMarkdownChange` to `EditorController`.
  - Expose `markdown` and `richTextOptions` in `EditableTextNodeEditor` in `@pixerate/editor-svelte`.

## 0.4.5

### Patch Changes

- 0557d6b: Support double-clicking column header edge to size to fit in spreadsheet view

## 0.4.4

### Patch Changes

- 878ae7a: Ensure spreadsheet columns can be reduced and collapsed with explicit inline styles and style block rules on table cells, and align controller min width constraint to 30px

## 0.4.3

### Patch Changes

- 5faaf5d: Fix CommonJS module interop for TipTap extensions by using resilient named and default unwrapping

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
