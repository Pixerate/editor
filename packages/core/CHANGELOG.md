# @pixerate/editor

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
