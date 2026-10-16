# @pixerate/editor-react

## 0.22.0

### Minor Changes

- bf3ebff: Support linear and radial gradients for canvas shapes and freehand drawing, and fix endcaps preservation on stroke completion.

  - Added gradient data models, angle-to-coordinate calculations, presets (`CANVAS_GRADIENT_PRESETS`), and SVG `<defs>` generation in core.
  - Updated `ShapePaint` and shape render pipelines to support gradient fills and strokes across React (`ShapeNode`) and Svelte (`ShapeNode.svelte`).
  - Added live gradient rendering preview to `CanvasDrawLayer` in both React and Svelte.
  - Fixed an issue where freehand pen/highlighter linecaps and joins were stripped upon finishing a stroke or creating single-point dots.

### Patch Changes

- Updated dependencies [bf3ebff]
  - @pixerate/editor@0.31.0

## 0.21.0

### Minor Changes

- a41385b: Add freehand drawing tools (pen, highlighter, eraser) for xyflow canvas:
  - `@pixerate/editor/canvas`: Streamline point smoothing, Bézier curve fitting to ShapeNode, eraser hit-testing, and headless CanvasDrawController with undo/redo history and batch deletion
  - `@pixerate/editor-react/canvas`: `useCanvasDraw` hook and `<CanvasDrawLayer>` interactive SVG overlay with live stroke preview, spacebar pan override, and viewport transforms
  - `@pixerate/editor-svelte/canvas`: `createCanvasDraw` rune and `<CanvasDrawLayer>` Svelte 5 component with reactive SVG overlay and cross-framework parity

### Patch Changes

- 9075249: Align `@pixerate/editor` peer dependency range to `>=0.29.0 <1` to match sibling Pixerate ecosystem packages and prevent `ERESOLVE` collisions on clean npm installs.
- Updated dependencies [a41385b]
- Updated dependencies [9c8ab5d]
  - @pixerate/editor@0.30.0

## 0.20.0

### Minor Changes

- 41af28c: Add `@pixerate/editor-react/parameters`: `useParameters`, `useParametersController`, `useParametersState` and `useParameterCommands`, the field controls `ParameterSlider` (slider + number box), `ParameterToggle`, `ParameterSelect`, `ParameterColor`, `ParameterVector`, `ParameterImage`, `ParameterText`, `KeyframeDiamond` and `ParameterFieldControl`, and `ParametersPanel`, which renders a whole parameter schema with groups, presets, undo / reset / randomize and keyframe diamonds.

### Patch Changes

- Updated dependencies [41af28c]
  - @pixerate/editor@0.29.0

## 0.19.1

### Patch Changes

- ca79b03: Add the `@pixerate/editor/tools` subpath: `ToolRegistry`, `createToolRegistry`, `ToolRegistryError`, the agent tool types, `validateJsonSchema` and the static `EDITOR_MCP_TOOLS` definitions, with no TipTap, ProseMirror or dagre imports. Hosts that only combine tool providers (for example `createCommandToolProvider`) no longer need TipTap installed. `@pixerate/editor/agent` still re-exports all of it, and the TipTap-bound providers (`createRichTextToolProvider`, `createEditorMcpToolProvider`, ...) stay there. The React and Svelte tool-provider helpers now import their types from `/tools`.
- Updated dependencies [e06ae39]
- Updated dependencies [ca79b03]
  - @pixerate/editor@0.28.0

## 0.19.0

### Minor Changes

- 40d8cb2: Edit the variants of a canvas component set. Core adds `addCanvasVariant` (duplicate a variant with new ids and property values; new property names are added to every variant; duplicate combinations are refused; laid out next to the source or by the set's auto layout), `removeCanvasVariant` (refuses the last variant; instances switch to the closest variant, keeping overrides), `setCanvasVariantProperties`, `renameCanvasVariantProperty`, `renameCanvasVariantValue` and `getNextVariantValues`. The components controller gains undoable `addVariant`, `removeVariant`, `setVariantProperties`, `renameVariantProperty` and `renameVariantValue` with `can…` reasons, registered as `canvas.*` commands and agent tools (`add_variant`, `remove_variant`, `set_variant_properties`, `rename_variant_property`, `rename_variant_value`). React and Svelte `CanvasComponentsPanel` take an optional `components` (and `onError` / `onerror`) to show "+ Variant" on sets, inline property / value renames, and a per-variant menu (also on right click) to edit, duplicate or remove a variant.

### Patch Changes

- 40d8cb2: Spreadsheet defined names now survive the single-document save path. Apps that only save the document passed to `onDocumentChange` (including through `useSpreadsheetEditor` and `createReactiveSpreadsheet`) lost every defined name on reload. Each sheet document now has an optional `names` array: all the workbook-scoped names plus that sheet's own sheet-scoped names. The controller updates it on every change, including define, rename, delete, undo and redo.

  `new SpreadsheetController({ document })`, `loadDocument` and `addSheet({ document })` read these names back. Any `sheetId` in a document's names means "this sheet". When a workbook is loaded, `workbook.names` wins over the same names repeated in `sheets[*].names`, and names found only in sheet documents are added (the first sheet wins). `getWorkbook()` is unchanged: names stay in `names` only. Saved documents and workbooks without these fields load as before. `new SpreadsheetController({ workbook })` no longer changes the `id`, `name` or `names` of the sheet objects passed in.

- Updated dependencies [40d8cb2]
- Updated dependencies [40d8cb2]
- Updated dependencies [40d8cb2]
- Updated dependencies [40d8cb2]
  - @pixerate/editor@0.27.0

## 0.18.1

### Patch Changes

- Updated dependencies [41b2435]
  - @pixerate/editor@0.26.1

## 0.18.0

### Minor Changes

- 723b347: Add Figma-style components and instances to the canvas. `@pixerate/editor/canvas` turns a frame (or a wrapped selection) into a main component (`data.component`), places instances (`data.instance`) whose layers are real nodes copied from the main with stable source ids (`data.componentSource`), records edits inside instances as per-layer overrides (`data.componentOverrides`: text, fills, styles, visibility, auto layout padding / gap, token bindings, …) and rebuilds every instance when its main changes, keeping overrides and layer ids (`syncCanvasComponents(before, after)`). Component sets hold variants (`combineCanvasComponentsAsVariants`; switching variants keeps overrides the variants agreed on), and component properties drive layers (boolean → visibility, text → a `data` field, instance swap → a nested instance's main). Also: nested instances, swap, detach (keeps the look), reset overrides (all, per layer or per group), push overrides to the main, a "missing main" state when a main is deleted with `restoreCanvasMainComponent`, cycle prevention, deleting a layer inside an instance hides it, token bindings and per-instance modes inside instances, and links that survive JSON, copy / paste and duplication. `createCanvasComponentsController` makes each action one undoable step with `can…` checks giving disabled reasons; `createComponentCommands` (`@pixerate/editor/commands`) and `createCanvasComponentToolProvider` (`@pixerate/editor/agent`) expose them to the palette and agents. React adds `useCanvasComponents`, `<CanvasComponentsPanel>` and `<CanvasInstanceInspector>`; Svelte adds `createCanvasComponents`, `<CanvasComponentsPanel>` and `<CanvasInstanceInspector>`. Portions ported from FigCraft (MIT OR Apache-2.0).
- 723b347: Add keyframe animation for canvas nodes. `@pixerate/editor/canvas` stores per-property tracks in `node.data.animation` (so they copy, paste and duplicate with the node) for x, y, width, height, rotation, scale, opacity, fill, stroke, stroke width, corner radius and a motion path. Keyframes use hold, linear, CSS `cubic-bezier` presets or springs; colours interpolate in OKLab with premultiplied alpha; unsorted and duplicate keyframe times are handled. `evaluateAnimation` / `applyAnimation` return evaluated copies without touching the source and compose with `resolveCanvasTokens`. Editing helpers (`setKeyframe`, `updateKeyframe`, `deleteKeyframes`, `setKeyframeEasing`, `setTrackEnabled`, `moveKeyframes`, `scaleKeyframes`, `snapKeyframeDelta`, `copyKeyframes` / `pasteKeyframes`, `recordAnimationChanges`, `animateNode`) never apply partial edits. `AnimationPlayer` plays on an injected `Clock` with loop, ping-pong and playback rate. Export covers `sampleAnimationFrames`, CSS `@keyframes` (`exportCssAnimation`) and Web Animations (`toWebAnimations`). `createCanvasAnimationController` adds record mode, undoable edits and keyframe drags with snapping. `@pixerate/editor/commands` adds `createCanvasAnimationCommands`, which agents can also call as tools (for example `canvas.animation.animateNode`). React adds `useCanvasAnimation` and `<AnimationTimeline>`. Svelte adds `createCanvasAnimation` and `<AnimationTimeline>`. Portions ported from FilmCraft (MIT OR Apache-2.0).
- 723b347: Word (.docx) export and review import.

  - Core: new `@pixerate/editor/export` subpath (also re-exported from the root): `exportDocx(editorOrJSON, { styles, comments, author, privacy, title, remoteImages })` writes a dependency-free `.docx` with paragraph styles (`styles.xml` with `basedOn` / `next` / `link`), formatting, links, bullet / ordered / task lists, block quotes, code blocks, embedded images, tables (`gridSpan` / `vMerge` / header rows), tracked insertions, deletions, moves, formatting and block changes with authors and dates, and comments with replies and resolved state; returns a report of anything dropped. `privacy: "strip-authors"` anonymises names. Also `exportDocxBlob`, `createDocxParts`, `DocxExportController`, `downloadBlob`, `writeZip`.
  - Core: the DOCX importer reads comments (replies, resolved, author ids from `people.xml`) into `DocumentImport.comments` with `data-comment-id` ranges, tracked changes as review marks with `trackedChanges: "marks"`, and `styles.xml` into `DocumentImport.styles` (a style registry) with `data-style` on styled paragraphs; `Block Text` paragraphs become block quotes and `Code` paragraphs code blocks. `applyImportedReviewData` loads comments and styles into an editor (`importFilesIntoEditor` does it automatically). The HTML sanitizer now keeps `<ins>`.
  - React: `useDocxExport` and `ExportDocxButton`. Svelte: `createDocxExport` and `ExportDocxButton`.

- 723b347: Tables in the rich-text editor.

  - **Behaviour change:** `createRichTextPreset` now includes tables by default (TipTap's `table`, `tableRow`, `tableHeader`, `tableCell` nodes): resizable columns, header rows/columns/cells, `colspan` / `rowspan` (kept from pasted HTML and from DOCX and PDF import, which were previously flattened into paragraphs), cell `align` and `backgroundColor`, and table node selection. Pass `table: false` to keep the old flattening, or `table: { … }` to configure them. `createRichTextToolProvider` now also lists an `edit_table` tool when the schema has tables.
  - New table API: `TABLE_ACTIONS`, `getTableActionState` (with reasons such as "Place the cursor in a table first."), `runTableAction`, `getTableState`, `createTableStore`, `createTableCommands` (command registry: `table.insertTable`, `table.addRowAfter`, `table.mergeCells`, `table.toggleHeaderRow`, `table.goToNextCell`, `table.setCellAlignment`, …), `DEFAULT_TABLE_TOOLBAR`, `shouldShowTableBubbleMenu`, `createTableExtensions`.
  - Export: plain text writes table rows as lines of tab-separated cells; markdown writes GFM pipe tables (header alignment, escaped `|`) when representable and HTML otherwise; GFM tables in markdown import as tables. The HTML sanitizer now allows `colgroup`, `col` and `colwidth`.
  - Track changes: inserted and deleted rows, columns and tables are tracked as whole-block changes (reject removes inserted ones, accept removes deleted ones); header toggles are tracked block changes; merging/splitting cells is disabled while tracking. Whole-block changes inside tables are described as "Inserted 2 table cells".
  - React: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `useTableMenu`. Svelte: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `createTableMenu`.

- 723b347: Faster recalculation for formulas over ranges, and virtualised rendering of large sheets.

  - **Range-aware dependency graph** (`@pixerate/editor`): ranges are stored whole in an interval index (per column, plus a per-sheet index for ranges wider than 64 columns) instead of one key per cell, so `=SUM(A1:A50000)` and `=SUM(A:A)` are one entry each and an edit finds its dependents in O(log n + k). Only the dirty subgraph is recalculated, in topological order, with cycles, spills, cross-sheet / 3-D / defined-name references and LAMBDA unchanged. New: `IntervalIndex`, `extractReferenceDependencies`, `rangeDependencyKey`, `DependencyGraph.dependsOn` / `setVolatile` / `getVolatileKeys` / `detachSpilledCell` / `getIndexStats`, `getEvaluationPlan(keys, { includeVolatile })`, and `SpreadsheetController.getRecalculationStats()` (formulas evaluated by the last recalculation). `DependencyGraph.getDependencies` now returns range keys (`A1:A3`, `A:`) rather than every cell of a range.
  - **Volatile functions** (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, `RANDARRAY`, also through defined names) now recalculate on every edit, as in Excel.
  - **Bulk loads**: CSV import, `importRows`, paste and autofill register formulas once and recalculate in one plan (one full evaluation when the grid grows); row and column lookups by id no longer scan the sheet, so a 50k-row CSV import goes from ~23 s to ~0.5 s.
  - **Single-cell edits** are undone from a record of that cell instead of a whole-sheet snapshot (an edit on a 50k-cell sheet: ~25 ms → ~0.2 ms).
  - **Evaluation fast paths**: `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` read range arguments without materialising blank cells (`EvaluationContext.resolveRange` gets an optional `{ skipBlanks }` hint), large ranges read by several formulas are resolved once per recalculation, and formulas are parsed once for registration and evaluation.
  - **Fixes**: a blocked dynamic array no longer becomes `#CYCLE!` through its blockers, and stale spill edges no longer cause false cycles after re-entering an anchor or typing into a spilled cell.
  - **Virtualised rendering**: new core helpers `measureSpreadsheetView`, `getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell` and `shouldVirtualizeSpreadsheet`. React (`useSpreadsheetViewport`) and Svelte (`createSpreadsheetViewport`) `SpreadsheetEditor`s render only the visible rows and columns plus overscan for sheets over 200 rows or 60 columns (`virtualize` prop: `'auto'` | `true` | `false`), keeping frozen panes, merged cells, row groups, conditional formats, selection, column resizing and keyboard navigation (the active cell scrolls into view). Smaller sheets render as before. `SpreadsheetGroupRow` accepts `labelColumns`, `leadingColumns`, `leftSpace` and `rightSpace` for windowed columns.

### Patch Changes

- 723b347: Fix scrolled rows showing through frozen rows in `SpreadsheetEditor`. The grid table used `border-collapse: collapse`, whose shared row borders are not repainted with sticky (frozen) cells, so thin slivers of the rows scrolling underneath appeared along each frozen row. The table now uses separate borders with zero spacing and draws each row's bottom border on its cells.
- Updated dependencies [723b347]
- Updated dependencies [723b347]
- Updated dependencies [723b347]
- Updated dependencies [723b347]
- Updated dependencies [723b347]
  - @pixerate/editor@0.26.0

## 0.17.0

### Minor Changes

- c96cabb: Add curve-preserving path operations for the canvas. A new Bézier path engine (`pathBoolean`, `unitePaths`, `intersectPaths`, `subtractPaths`, `excludePaths`, `dividePaths`, `normalizeBezierPath`) intersects curves directly (subdivision with Newton polishing, tangencies, coincident edges and T-junctions resolved; nonzero / evenodd fill rules) and rebuilds results from exact sub-curves of the inputs, falling back to the polygon engine (reported as `engine` / `fallbackReason`) only when it cannot resolve the input. Adds `offsetPath` (inset / outset with miter, round or bevel joins and loop removal), `outlineStroke` (SVG joins, caps, miter limit and dashes to a clean filled path) and arc-length / area / hit-test utilities (`bezierPathLength`, `bezierPathPointAtLength`, `bezierPathArea`, `pointInBezierPath`, …).

  Behaviour change: `combineShapeNodes` (and the arrange controller's Unite / Intersect / Subtract / Exclude / Divide) now use the curve engine by default, so results keep exact arcs and straight sides instead of fitted polylines; pass `engine: 'polygon'` (or `curves: 'lines'`) for the previous behaviour. Results also report `engine`.

  New undoable shape commands: `arrange.offsetShapes(distance, ids?, options?)` and `arrange.outlineStroke(ids?, options?)` (with `canOffsetShapes` / `canOutlineStroke`) in core, `useCanvasArrange` (React) and `createCanvasArrange` (Svelte); pure `offsetShapeNodes`, `outlineShapeNodeStrokes` and `applyShapeReplacement`; and `createShapeCommands` for the command palette / context menus. Portions ported from VectorCraft (MIT OR Apache-2.0).

- c96cabb: Add design tokens (Figma-style variables) with modes such as light / dark. The new dependency-free `@pixerate/editor/tokens` subpath has collections, modes (default, add / duplicate / reorder / remove), typed colour / number / string / boolean variables with per-mode values, aliases across collections with cycle and type checks, scopes for pickers, `resolveToken` with diagnostics, an undoable `TokenStore` with change events and transactions, W3C Design Tokens JSON import / export (merging by name, keeping ids, modes in `$extensions`) and CSS custom properties per mode (`exportTokensCss`, `getTokenCssVariables`). Deleting a variable or collection detaches aliases to their values. `@pixerate/editor/canvas` binds node properties (fill, stroke, stroke width, opacity, corner radius, auto layout gap and padding, text colour and size, visibility) to variables via `data.tokenBindings`, with an explicit mode per frame or group (`data.tokenModes`) inherited by descendants; bound values are written into the nodes (`resolveCanvasTokens`), survive copy / paste and duplication, and `detachTokenBindings` keeps the last value when a variable is deleted. React adds the `./tokens` subpath (`useTokens`, `useTokenStore`, `<TokensPanel>`) and `useCanvasTokens`, `<TokenBindingPicker>` and `<TokenModeSwitcher>` in `./canvas`; Svelte adds the same (`createTokens`, `<TokensPanel>`, `createCanvasTokens`, `<TokenBindingPicker>`, `<TokenModeSwitcher>`). Portions ported from FigCraft (MIT OR Apache-2.0).
- c96cabb: Image editor selections and masks. Core (`@pixerate/editor/image-editor`): 8-bit `SelectionMask` selections with magic wand (scanline fill, RGB or perceptual tolerance, contiguous / global, sample merged), colour / tone / hue range, rectangle / ellipse / lasso, replace / add / subtract / intersect, grow / shrink (exact distance transform), feather, border, smooth, invert, and guided-filter Refine Edge (radius, smart radius, smooth, feather, contrast, shift edge) for snapping coarse AI masks to image edges. Selections are undoable, saved run-length encoded as an optional `selection` key, shown as marching ants or a Quick Mask tint, and included in `toMaskDataURL()`. Adjustment layers get an optional `mask` with non-destructive density and feather (`applySelectionAsLayerMask`, `selectionFromLayerMask`), resampled through crop / rotation / flips. Selection- and mask-free documents serialize exactly as before. New agent tools: `get_selection`, `select_region`, `select_by_color`, `modify_selection`, `refine_selection`, `apply_selection_as_mask`. React and Svelte: `SelectionOptionsBar`, `RefineEdgePanel` and a Select & Mask tab in `ImageEditor`.
- c96cabb: PDF import now recovers document structure from the page layout. The new pure `analyzePdfLayout` reads multi-column pages in column order, removes running headers, footers and page numbers, re-joins hyphenated words, and detects headings (levels from font-size and weight clusters against the body size), bulleted and numbered lists (nesting by indent, ordered `start`), and tables from ruling lines (with spanning cells) or aligned column gaps (spanning header/totals rows, header rows from bold or labels over numbers). `createPdfImportAdapter` uses it by default, reads ruling lines and font weights from pdf.js, and returns a `structure` report (counts, confidences, detected items); `structure: false` (at creation or per import via the new `adapterOptions: { pdf: { structure: false } }` on `importFile`, `importFilesIntoEditor`, the file-import controller and the `FileImport` extension) restores the plain paragraph import. New helpers: `pdfLayoutBlocksToHtml`, `pdfTextItemsToRuns`, `pdfOperatorListToRules`, `summarizeImportStructure`. React's `useFileImport` and Svelte's `createFileImport` expose `structureSummary`.
- c96cabb: Generation records and Recreate, and asset mentions with roles.

  - Core (`/generation`): `createGenerationRecord` (built on provenance, plus template/capability/prompt hashes, original settings, seed, assets with roles and content hashes, lineage). `recreateRequest(record, { templates, capabilities, assets, mode: "exact" | "latest" })` returns the re-planned request and a drift report (template changed/deleted, model missing/changed, setting unsupported/changed, asset missing/changed). Also adds `variationRequest`, `createGenerationRecordStore` on the persistence storage adapters (filter by model/template/asset/role, prune, subscribe), and `hashText` / `hashCapabilities`. `recreateRequest(provenance)` keeps its old behaviour.
  - Roles are extensible: models may declare custom roles. Each role can list accepted media (`accepts`). Aliases such as `style` and `start-frame` map to built-in roles. `planGenerationRequest` accepts `mentions` and validates them per role. `validateAssetMentions`, `describeAssetMentions` and `getAssetRoleOptions` are new. Agent schemas list custom roles and `mediaType`.
  - Mentions: opt-in `@handle:role` text syntax (`extractMentions(text, { details: true, roles: true })`, `preprocessMarkdownMentions(…, { roles })`). `findTextMentions` and `setMentionRoleInText` are new. The Mention node has an `assetRole` attribute (`data-role`), with `setMentionRoleAt` / `getMentionNodes`. `htmlToPlainText` writes `@label:role`. Output without roles is unchanged.
  - React and Svelte: `<AssetMentionChips>` (role badges, role picker popover), `<GenerationHistory>` (drift report, Recreate exact/latest, Variation), `useGenerationRecords` / `createGenerationRecords`.

- c96cabb: Add spreadsheet conditional formatting and data validation (ported from GridCraft).

  Conditional formatting (`@pixerate/editor/spreadsheet`): cell value comparisons (with formula operands), formula rules with relative references (`=$A1>10` formats whole rows), text contains / not contains / begins / ends with, blanks, errors, duplicates / unique, top / bottom N and N%, above / below average (with standard deviations), dates occurring, 2- and 3-colour scales and data bars (min / max / number / percent / percentile / formula anchors), and icon sets (12 sets, file or default thresholds, reversed, value hidden). Rules apply in priority order with stop if true. `evaluateConditionalFormats(sheet, rules)` returns a per-cell overlay (fill, font colour, bold / italic / underline / strikethrough, data-bar fraction and colour, icon); `ConditionalFormatEngine.update` re-evaluates only affected cells after edits. The controller stores rules in `document.table.conditionalFormats` and adds undoable `addConditionalFormat`, `updateConditionalFormat`, `deleteConditionalFormat`, `moveConditionalFormat`, `clearConditionalFormats`, plus `getConditionalFormatOverlay` / `getConditionalFormat`. Rule ranges and rule formulas follow inserted and deleted rows and columns.

  Data validation: whole number, decimal, list (literal or from a range), date, time, text length and custom formula rules, with ignore blank, input messages and stop / warning / information alerts (`document.table.dataValidations`, undoable `addDataValidation`, `updateDataValidation`, `deleteDataValidation`, `clearDataValidation`). `commitEditing()` now validates and returns a `SpreadsheetCommitResult`: invalid input keeps the editor open and sets `validationPrompt`, answered with `resolveValidationPrompt('accept' | 'retry' | 'cancel')`. New `commitCellInput` validates formula-bar and dropdown input; `setCellValue`, paste and import do not validate. Also `validateCellInput`, `getValidationListValues`, `findInvalidCells` and "circle invalid data" (`setInvalidDataCircles`, `isInvalidDataCircled`).

  React and Svelte grids render fills, font styles, data bars, icons and invalid-data circles, show a dropdown arrow on list-validated cells (also Alt+Down), the input message, and validation alert dialogs. The context menu gains conditional formatting and data validation items, including compact "Conditional formatting…" and "Data validation…" managers (`SpreadsheetConditionalFormatPanel`, `SpreadsheetDataValidationPanel`, `SpreadsheetValidationDialog`; menu items with `panel` are opened through the context menu's `onOpenPanel`).

- c96cabb: Spreadsheet LAMBDA functions, defined names and multiple sheets (ported from GridCraft's calc engine and workbook model).

  **LAMBDA.** `LAMBDA(params…, body)` creates function values with lexical scoping (closures keep their LET variables). Call them inline (`=LAMBDA(x, x+1)(2)`), through LET (`=LET(f, LAMBDA(x, x*2), f(3))`) or a defined name (`=Double(4)`, recursion included), or pass them, or a built-in by name, to `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL` and `MAKEARRAY`. `ISOMITTED` checks for left-out arguments (`f(1,)`); empty arguments now parse everywhere. Wrong argument counts are `#VALUE!`, an uncalled lambda in a cell is `#CALC!`, and recursion deeper than `MAX_LAMBDA_DEPTH` (1000) is `#NUM!`. New exports `FormulaLambda`, `isFormulaLambda`; `EvaluationContext` gains `resolveName` and `resolveSheetSpan`, and its resolvers receive an optional sheet name.

  **Defined names.** `defineName(name, refersTo, { sheet?, comment? })` for workbook- or sheet-scoped ranges, constants, formulas and lambdas; `renameName` rewrites the formulas (and other names) that use it; `deleteName` leaves `#NAME?`. Names are validated like Excel (`validateDefinedName`: not cell- or R1C1-like). Formulas depend on the cells a name refers to, so edits recalculate them; `getNames`, `getName`, `getNameSuggestions` and `evaluateFormula(formula, { sheet })`. Formula autocomplete suggests names (`getFormulaHints(input, caret, { names })`, `<FormulaHints names>`).

  **Sheets.** A `SpreadsheetController` is now a workbook (a single-sheet controller works exactly as before; `document` is the active sheet): `addSheet`, `renameSheet`, `moveSheet`, `deleteSheet` (not the last), `duplicateSheet` (with its sheet-scoped names), `setActiveSheet`, `getSheets`, `getWorkbook`/`loadWorkbook` and the `workbook`, `onWorkbookChange` and `onActiveSheetChange` options. Formulas reference other sheets (`Sheet2!A1`, `'My Sheet'!A1:B2`, `Data!A1#`, `Data!Rate`) and 3-D ranges (`SUM(Sheet1:Sheet3!A1)`). Renaming a sheet rewrites references to it, deleting one turns them into `#REF!` (3-D spans shrink), and inserting/deleting rows or columns, sorting and transposing rewrite references from other sheets too. Undo snapshots the changed sheet (undoing switches to it) or, for sheet and name operations, the whole workbook. CSV/row imports take a `sheet` option. New helpers: `validateSheetName`, `quoteSheetName`, `renameSheetInFormula`, `deleteSheetInFormula`, `renameNameInFormula`, `getSheetTabMenuItems`, `getNameManagerRows`; `shiftFormulaReferences` / `remapFormulaReferences` accept a sheet filter, and menu items can ask to `confirm`.

  **React and Svelte.** `<SheetTabs>` (click to switch, double-click to rename, drag to reorder, context menu with insert/rename/duplicate/move/delete-with-confirm, `+` to add), `<NameManager>` (list with values, add/edit/rename/delete), `showSheetTabs` on `<SpreadsheetEditor>`, and `sheets`, `activeSheetId`, `names` plus the sheet and name actions on `useSpreadsheetEditor` / `createReactiveSpreadsheet`.

- c96cabb: Tracked moves and paragraph styles.

  - **Tracked moves** (`TrackChanges`): with tracking on, a cut followed by a paste of the same text, or a drag within the document, of at least a sentence (`isMoveSized`; configurable with the `isMove` and `trackMoves` options) is recorded as one move. Both ends are `insertion`/`deletion` marks sharing a `moveId` (`data-move-id`) and styled with a green double strike/underline (`moveHTMLAttributes`). `getTrackedChanges` lists a move once (`type: "move"` with `move.from`/`move.to`); new `acceptMove(id)`/`rejectMove(id)` commands (and `acceptChange`/`rejectChange`/accept-all) remove the source or the destination, taking an emptied top-level paragraph with it. New `selectChange(id)` command and `trackedChangeLabel` helper. `getEditorText` resolves moved paragraphs without leaving empty lines. Block changes of a paragraph style read "Changed style to …".
  - **`compareDocuments({ detectMoves: true })`** records a uniquely identical top-level paragraph deleted in one place and inserted elsewhere as a move; the summary has a new `moves` count.
  - **Paragraph styles**: `createStyleRegistry` / `StyleRegistry` with built-in Normal, Title, Subtitle, Heading 1–6, Quote, Code and List Paragraph styles (plus linked and Emphasis/Strong character styles), `basedOn` chains (cycle-safe), `next` styles, document defaults, cascade resolution, user styles, JSON round-trip and a scoped stylesheet (`toCSS`). The `ParagraphStyles` extension (`paragraphStyles` preset option) adds a `styleId` attribute (`data-style`) to paragraphs, headings and code blocks, a `characterStyle` mark, `setParagraphStyle`, `clearParagraphStyle`, `setCharacterStyle`, `unsetCharacterStyle`, `updateParagraphStyleFromSelection` and `createParagraphStyleFromSelection` commands, next-style on Enter and CSS injection. Headings without a `styleId` map to Heading N, so existing documents are unchanged.
  - **React**: `StylesGallery` (dropdown or gallery, update/new style from selection) and `useParagraphStyles`; `TrackedChangesList`; `useTrackChanges` gains `select`, `acceptMove` and `rejectMove`.
  - **Svelte**: `StylesGallery` and `createParagraphStyles`; `TrackedChangesList`; `createTrackChanges` gains `select`, `acceptMove` and `rejectMove`.

### Patch Changes

- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
- Updated dependencies [c96cabb]
  - @pixerate/editor@0.25.0

## 0.16.0

### Minor Changes

- fd0c687: Add autosave, crash recovery and document migration (`@pixerate/editor/persistence`).

  - Core: `createAutosaveController` (debounced crash-recovery snapshots with a hydration gate, exponential retry, `flushNow` for `pagehide`, `checkRecovery` / `discardRecovery`, and `markClean` that only retires a snapshot this session wrote), the pure `createRecoveryPolicy` state machine, `createRevisionTracker` (revisions from a `HistoryManager` and `bindDirtyToHistory`), storage adapters (`createMemoryStorage`, `createLocalStorageAdapter`, `createIndexedDbAdapter`, `createOpfsAdapter` with temp-file rename or pointer-swap writes, all feature-detected and with injectable failures), and `migrateDocument` / `loadSections` / `loadDocument` with a `LoadReport` (step-wise migration, per-section fallback, read-only newer versions, unknown keys preserved).
  - Core: `loadImageEditorDocument` in `@pixerate/editor/image-editor` loads `SerializedImageEditorState` with a `LoadReport`; valid state is returned unchanged.
  - React: `useAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-react/persistence`).
  - Svelte: `createAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-svelte/persistence`).

- fd0c687: Add Figma-style auto layout and constraints for canvas sub-flows. Frames are nodes with `data.layout` (horizontal, vertical or grid; gap, padding, wrap, main / cross / content alignment including space-between and baseline, hug / fill / fixed sizing, min / max, `fr` grid tracks with spans and anchors); children take `data.childLayout` (sizing, limits, absolute positioning and constraints). Core adds the pure `layoutFrame`, `layoutAll`, `layoutUp`, `applyConstraints`, `makeSizingCoherent`, `getAutoLayoutGrid`, `getAutoLayoutInsertTarget` and `moveLayoutChild`, plus `createCanvasAutoLayoutController`, which relayouts frames after nodes are added, removed, resized or reordered (one undo step with the triggering action) and reorders children dragged within their frame. React gets `useCanvasAutoLayout`, Svelte `createCanvasAutoLayout`, and the arrange controller an `autoLayout` option. Portions ported from FigCraft (MIT OR Apache-2.0).
- fd0c687: Compare two documents into tracked changes.

  - `@pixerate/editor` (also `@pixerate/editor/compare`): `diffSequences` / `diffChanges` (Myers diff with common prefix/suffix stripping and patience anchors for long inputs), `compareDocuments(original, revised, options)` returning the revised document with the differences as `insertion` / `deletion` / `formatChange` marks and `blockChange` records plus a summary (`insertions`, `deletions`, `formatChanges`, `blockChanges`, `notHonoured`), and `compareHtml`. Options: `granularity: "word" | "char"`, `ignoreCase`, `ignoreWhitespace`, `formatting`, `author`, `date`. Accepting all changes yields the revised document, rejecting all the original.
  - New `DocumentCompare` extension (added by the rich-text preset with `trackChanges`) with the `setContentFromComparison(original, revised)` command, and `applyDocumentComparison(editor, …)` / `compareInEditor`; the content is set without being tracked.
  - Track changes: `blockChange` records can carry `operation: "insert" | "delete"` for wholly inserted/deleted blocks (accepting a deletion or rejecting an insertion removes the block and emptied containers). They render with `data-block-operation` and the new `blockInsertedClass` / `blockDeletedClass` options, and are described as "Inserted Paragraph" / "Deleted 2 blocks". Exports (`getEditorText`, Markdown, `resolveTrackedChanges`) resolve them like inline changes.
  - React: `useDocumentCompare(editor)`; Svelte: `createDocumentCompare(editor)`.

- fd0c687: Add an Excel number-format engine (ported from GridCraft's numfmt): `NumberFormat.parse` never throws and supports up to four sections, `[>=100]` conditions, `[Red]`/`[ColorN]` colours, `,` scaling, `%`, scientific `E+`, `?` padding, fractions (`# ??/??`), `_x` spacing, `*x` fill, elapsed `[h]`/`[m]`/`[s]`, the `@` text section, date/time tokens and Excel's 15-significant-digit rounding (`2.675` → `2.68`); codes over 255 characters display as General. Also `formatNumberFormatValue`, `formatTextFunction`, `formatGeneralFit`, `builtinNumberFormat`/`builtinNumberFormatId` (ids 0–49), `numberFormatColorToCss`, `NUMBER_FORMAT_PRESETS` and `CellFormat` ↔ code mapping helpers.

  `TEXT()` now uses the engine (text that is neither a number nor a date is returned unchanged, as in Excel, instead of `#VALUE!`). `formatCellForDisplay(cell)` returns the text, colour and whether the value is numeric; `formatCellDisplay` uses it, and numbers in cells with a `currency` / `percentage` / `date` `CellFormat` but no code use that kind's code. New `SpreadsheetColumn.numberFormat`, `CellData.explicitNumberFormat`, and undoable `setCellNumberFormat(range, code)` / `setColumnNumberFormat(colId, code)` on the controller (also on the React and Svelte spreadsheet state). Context menu items can be `checked` and ask for `input` (`runSpreadsheetMenuItem`).

  React and Svelte grids render formatted values right-aligned for numbers with `[Red]`-style colours, and the table context menu gains "Format cells" presets (General, Number, Currency, Percent, Date, Time) and a Custom… code prompt.

- fd0c687: Add `@pixerate/editor/generation`: declarative model capability descriptors (media kind, prompt limits counted on resolved text, negative/system prompts, aspect ratios, resolutions, quality, output count, durations, seeds, reference inputs by role with per-role and total limits, edit/inpaint modes, extra numeric/enum/boolean params, timing). `planGenerationRequest(request, caps, { strategy })` snaps, clamps, truncates and drops unsupported values with a report of every adjustment and error (`error`, `nearest`, `downgrade`, `upgrade` strategies). `capabilitiesToJsonSchema`, `mergeCapabilities`, and `createGenerationToolProvider` add `list_models`, `plan_generation`, `estimate_generation` and an idempotent `generate` (deduplicated by `idempotencyKey`) to a `ToolRegistry`. `createProvenance` / `serializeProvenance` / `parseProvenance` / `recreateRequest` record pinned template versions, values, the resolved prompt and source map, and the planned settings. Also adds `createBatchResolver`, `estimateJobProgress`, `expectedDurationFor`, and headless form helpers (`getGenerationControls`, `getReferenceSlots`).

  React (`@pixerate/editor-react/generation`): `useGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `useJobProgress`. Svelte (`@pixerate/editor-svelte/generation`): `createGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `createJobProgress`.

- fd0c687: Image editor: non-destructive adjustment layers, Photoshop blend modes, a histogram, a control table and agent tools.

  - **Adjustment layers**: `ImageAdjustments.layers?: AdjustmentLayer[]` (`{ id, kind, params, enabled, opacity, blend, name? }`), evaluated bottom to top after the base adjustments (and before blur) on the encoded result, each blended over the layers below with its blend mode and opacity. Kinds: `curves` (master + R/G/B natural-spline curves), `levels` (per channel then master, Photoshop whole-level stretch and soft gamma toe), `hueSaturation` (master + six trapezoid hue ranges, colorize), `vibrance`, `colorBalance`, `blackWhite` (with tint), `photoFilter`, `invert`, `posterize`, `threshold`, matching Photoshop ground truth. Each layer is compiled once per parameter change (per-channel kinds into LUTs). Controller: `addAdjustmentLayer`, `updateAdjustmentLayer` (with `commitToHistory = false` for drags), `removeAdjustmentLayer`, `moveAdjustmentLayer`, `toggleAdjustmentLayer`, `clearAdjustmentLayers`, `getAdjustmentLayers`, all undoable. States with layers serialize as schema `version: 2`; states without layers still serialize as version 1, byte for byte, and render exactly as before. `migrateSerializedImageEditorState` normalises stored states. `resetAdjustments()` now keeps adjustment layers (it resets the sliders).
  - **Blend modes** (`BLEND_MODES`, `blendChannel`, `blendRgb`, `blendPixel`, `blendImageData`, `canvasCompositeOperation`): all 26 Photoshop modes including Photoshop soft light, vivid / linear / pin light, hard mix, subtract, divide, darker / lighter colour and hue / saturation / color / luminosity with a hardened ClipColor, composited with the W3C formula. Annotations accept an optional `blend`: drawn with `globalCompositeOperation` where the canvas matches, with a scalar fallback otherwise.
  - **Histogram**: `computeHistogram(imageData)` (R, G, B and luminance bins, clipping counts, transparent pixels excluded), `histogramPath`, and `controller.getHistogram()` / `subscribeHistogram()` for the rendered preview after adjustments.
  - **Control table**: `IMAGE_ADJUSTMENT_CONTROLS` and `ADJUSTMENT_LAYER_CONTROLS` (`ControlSpec`: id, label, section, range, step, default, decimals, track), with `clampControlValue`, `formatControlValue`, `getControlPath` / `setControlPath`.
  - **Agent tools**: `createImageEditorToolProvider(controller)` for `ToolRegistry`: `get_adjustments`, `list_controls`, `set_adjustments {values, label}` (clamped, echoed, one undo step; base ids or `layers.<id>.<control>`), `add_adjustment_layer`, `render_preview {maxSide}`, with complete MCP annotations.
  - **React / Svelte**: `<Histogram>`, `<AdjustmentLayersPanel>` (add / reorder / show / remove layers, blend and opacity, curves editor with draggable points over the histogram, levels per channel, hue range selector, colour balance tones), `<CurvesEditor>` and `<ControlSlider>`. The image editor's Adjustments tab renders its sliders from the control table and shows the histogram and the layers panel. `useImageEditor` and `createReactiveImageEditor` gain `histogram` and the layer methods.

- fd0c687: Mail merge on top of the prompt grammar.

  - **Comparison conditions**: `{?amount>100}…{/amount}`, `{?status=paid}…{/status}`, `{!tier<>"gold"}…{/tier}` with `= <> != < > <= >=`, compared numerically when both sides are numbers and as case-insensitive text otherwise. The section is closed by the bare variable name, so existing prompts (including `{?a>1}…{/a>1}`) resolve exactly as before. Malformed comparisons stay literal and are reported as `invalid-condition`. Tokens carry `comparison: { operator, operand }`; new helpers `compareConditionValues`, `parseComparison`, `conditionSubject`, `formatConditionalTag`, `describeConditionalTag`, `parseConditionExpression`, `evaluateConditionExpression`. `extractVariables` flags `usedInComparison`, and such variables are no longer `conditionOnly` form fields. `GradientText` decorates comparisons and flags malformed ones.
  - **Data sources**: `parseDataSource(text | rows | objects, { delimiter, hasHeader, format, maxRecords, maxFields })` reads CSV/TSV (delimiter auto-detect) and JSON into `{ fields, records, warnings }` with header normalisation, padding and caps. `matchFields(variables, fields)` maps variables to fields case-/space-insensitively and through aliases (`FirstName`/`First`/`GivenName`, …); `recordToValues` builds prompt values.
  - **Merging**: `mergeRecords(template, source, { mapping, skipIf, separator, maxOutputs, maxLength, from, to })` resolves one output per record with source maps, skips records with a condition or function, and reports diagnostics. `serializeMergeOutputs` writes text or JSON.
  - **React / Svelte**: `<MergePreview />` (paste or pick CSV/JSON, editable field mapping, Prev/Next record preview, Merge all with copy/download) plus `useMergePreview` / `createMergePreview`. `TemplateRenderer` shows comparison tags.

- fd0c687: Word-style Find and Replace for the rich-text editor.

  - New `FindReplace` extension (opt-in `createRichTextPreset({ findReplace: true })`): commands `setSearch`, `openFindReplace`, `closeFindReplace`, `findNext`, `findPrevious`, `replaceCurrent`, `replaceAll` (one undo step) and `clearSearch`; Mod+F / Mod+H open the find state, F3 / Mod+G step. Matches are decorated with `pixerate-find-match` and `pixerate-find-match-current`. `getFindReplaceState(editor)`, `getFindReplaceStore(editor)` (cached snapshots), `formatFindStatus`, `FIND_OPTION_TOGGLES`.
  - Options: match case, whole words, match prefix / suffix, ignore punctuation / white space, Word `^` special characters (`^p`, `^t`, `^l`, `^?`, `^#`, `^$`, `^w`, `^13`, `^u8212`, … and `^&` / `^c` in the replacement), Word wildcards (`?`, `*`, `[a-z]`, `[!x]`, `{n,m}`, `@`, `<`, `>`, groups with `\1`–`\9` in the replacement), a raw regex mode and a literal mode.
  - Patterns compile with `compileFindPattern` and run on a linear-time Pike VM, so no Find text can backtrack catastrophically; searches are bounded by a time budget and match cap (`truncated`). Invalid patterns return a structured `{ code, message }` error instead of throwing. Regex mode uses `RegExp` and rejects nested repetition.
  - Searching skips tracked-deleted text (matches never span a deletion; word boundaries see the live text), reads paragraphs together only when the pattern contains `^p`, and replacements made while Track Changes is on become tracked changes. A paragraph mark in the replacement splits the paragraph. `searchDocument(doc, query, options)` and `applyReplacements(tr, matches)` are exported for custom flows.
  - `createFindReplaceCommands(editor)` returns command-registry specs (`findReplace.open`, `.openReplace`, `.find`, `.next`, `.previous`, `.replaceAll`) for menus, the palette and agents.
  - React: `FindReplaceBar` and `useFindReplace(editor)`.
  - Svelte: `FindReplaceBar` and the `createFindReplace(editor)` rune.

### Patch Changes

- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
- Updated dependencies [fd0c687]
  - @pixerate/editor@0.24.0

## 0.15.0

### Minor Changes

- 5a37e61: Canvas distance measuring, resize / grid snapping and Bézier curve fitting.

  - **Measuring**: `measureBetween(a, b)` (inside, overlapping and separated boxes, labelled lines plus dashed extension lines), `measureToLine`, `measureSelection(nodes, selectedIds, hoveredId)` and `measureLabel`. `GuideLine` gains the `measure` / `extension` kinds and an optional `label`, which both `<CanvasGuidesLayer>`s draw (new `measureColor` prop). Alt-hover hooks: React `useCanvasMeasure`, Svelte `createCanvasMeasure`.
  - **Resize snapping**: `snapResize(rect, handle, targets, options)` keeps the opposite edge / corner fixed, snaps corner axes independently, rejects snaps that collapse or flip the box, and supports `keepAspectRatio`, `minWidth` / `minHeight`. The arrange controller adds `snapResizeChanges` (React Flow `dimensions` changes), `beginResize` / `resize` / `endResize`, and the Svelte rune adds `resizerHandlers(id)` for `<NodeResizer>`. Locked nodes are not resized.
  - **Grid snapping**: `snapToGrid` and the `gridSize` / `gridOrigin` guide options for drag and resize snapping.
  - **Curve fitting**: `fitCubics`, `fitPathData`, `fitFreehandPath` (Schneider-style with corner preservation). `polygonToSvgPath` takes `curves: 'fit'`, and `combineShapeNodes` now fits curves by default (`curves: 'lines'` restores straight segments), so booleans of curved shapes stay smooth.

- 5a37e61: Add one command system for shortcuts, a command palette and agent tools.

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

- 5a37e61: History gestures, undo marks, memory budget, History-panel entries and dirty-vs-saved tracking.

  - `HistoryManager.executeMerged(cmd, { key })` folds consecutive merged executes with the same key into one undo step regardless of timing; any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()` ends the gesture. `beginGesture(key)` / `endGesture()` hold a gesture so every merged execute joins one step. Tag-only `executeMerged` keeps its 300 ms time window.
  - `mark()` / `revertTo(mark)` take back every step since the mark without leaving anything on the redo stack (Escape-cancel); a mark that has left the history is a no-op returning 0. `isMarkValid(mark)`.
  - `maxBytes` with a `sizeOf(command)` hook (or `command.byteSize`) drops the oldest steps beyond the budget but always keeps the newest; `getByteSize()`.
  - `getEntries()` (`{ id, label, index, current, undone }`) and `goTo(index)` for History panels; `getRevision()`.
  - `DirtyTracker` gains `normalize`, a revision-keyed `isDirty(value, revision)` cache, stateful `update` / `dirty` / `markClean` / `subscribe`, and re-entrant `suppress(fn)` (also `withoutDirty`). `bindDirtyToHistory` keeps it in step with a `HistoryManager`, so undoing back to the saved state is clean again. Also exported from `@pixerate/editor/history`.
  - `SpreadsheetController` caps its snapshot undo at `maxHistoryBytes` (default 64 MiB) in addition to 50 steps, and exposes `getHistoryByteSize()` / `getHistoryDepth()`.
  - React: `useHistory()` returns `entries`, `goTo`, `mark`, `revertTo`, `beginGesture`, `endGesture`; new `useHistoryDirty()`.
  - Svelte: `createHistory()` gains the same members; new `createHistoryDirty()` rune.

- 5a37e61: Image editor: proper white balance, LUT-based tone without intermediate clipping, and process versions. `ImageAdjustments` gains optional `tint` (−100 green … +100 magenta) and `process` (`1 | 2`). Process 2 (the default for new edits and Reset) decodes sRGB to linear float once, applies exposure and a Bradford white-balance matrix relative to "as shot" (`temperature` maps to Kelvin at one mired per unit around 6500 K; `tint` is Duv × 3000), then per-channel tone LUTs (highlight shoulder, contrast S-curve anchored at black / grey / white, brightness midtone lift), luminance-preserving saturation in linear light, and a LUT encode, clamping only at the end. Adjustments saved without `process` keep the frozen legacy rendering (`applyLegacyAdjustments`) and serialize exactly as before; `controller.upgradeProcess()` / `isProcessOutdated` (also on `useImageEditor` and `createReactiveImageEditor`) move an edit to the current process in one undo step. New `@pixerate/editor/image-editor` exports: `tempTintToXy`, `xyToTempTint`, `wbMatrix`, `whiteBalanceMatrix`, `whiteBalanceFromSample` (neutral-point eyedropper), `temperatureToKelvin`, `kelvinToTemperature`, `toneCurve`, `buildToneLut`, `normalizeProcessVersion`, `applyProcess2Adjustments` and friends. The React and Svelte image editors add a Tint slider and an "Update" notice for legacy edits. Note: `DEFAULT_ADJUSTMENTS` now carries `process: 2`, so `applyAdjustments(img, { ...DEFAULT_ADJUSTMENTS, … })` renders with process 2; pass `process: 1` for the old output.

### Patch Changes

- 5a37e61: Spreadsheet: typed cell input is now parsed into typed values, and comparisons follow Excel.

  - New `parseCellInput(raw)` (numbers with `$`, `%`, thousands separators, scientific notation, `(100)` negatives, fractions such as `1 1/2`; dates such as `3/4/2026`, `4-Mar-2026`, `Mar 4, 2026`; times; TRUE/FALSE; error literals; a leading `'` forces text) and `parseNumberText(text)`. Dates stay ISO text (`2026-03-04`); a time on its own becomes a fraction of a day.
  - `setCellValue`, TSV/CSV import, `importRows`, clipboard paste and autofill store the typed value in `value` and keep `raw` as typed. Cells get an automatic `numberFormat` (new optional `CellData` field) and, when the column format is unset or `text`, a matching `format` (`currency`, `percentage`, `date`, `number`). Documents saved with numeric-string values are re-parsed from `raw` on load.
  - Writes to bound number/boolean/date fields are coerced by the field type before `updateRecord`; string and enum fields still receive the text as typed. Values read from data sources are never re-parsed.
  - `compareValues` follows Excel: numbers < text < booleans < errors, numbers compared at 15 significant digits (`=0.1+0.2=0.3` is TRUE), blanks as 0/""/FALSE, ISO dates chronologically (and as serials against numbers). New `sortCompareValues` (blanks last), `compareNumbers`, `numberToText`. `&` and other text coercion print numbers with up to 15 significant digits; arithmetic coerces numeric text such as `"1,000"`, `"50%"` and date text.
  - Table sort uses Excel's type order; filters and criteria (`SUMIF`, `COUNTIFS`…) read operands with the typed-input rules (`">1,000"`, `"10%"`, `">=3/1/2026"`).
  - New `formatCellDisplay(cell)`, used by the React and Svelte grids, CSV/TSV export and clipboard text, shows typed values as entered (`10%`, `$1,200.50`, `3/4/2026`) and booleans as TRUE/FALSE.

- Updated dependencies [5a37e61]
- Updated dependencies [5a37e61]
- Updated dependencies [5a37e61]
- Updated dependencies [5a37e61]
- Updated dependencies [5a37e61]
  - @pixerate/editor@0.23.0

## 0.14.0

### Minor Changes

- be14fc8: Add Freeform-style shape boolean operations (Unite / Intersect / Subtract / Exclude / Divide) for canvas shape nodes. Core (`@pixerate/editor/canvas`) gains a dependency-free polygon boolean engine for multi-polygons with holes (`polygonBoolean`, `unionPolygons`, `intersectPolygons`, `subtractPolygons`, `xorPolygons`, `dividePolygons`), shape geometry (`data.shape` descriptions for rect / rounded rect, ellipse, regular polygon, star and SVG path data; `parseSvgPath`, `flattenSvgPath`, `shapeToPolygon`, `polygonToSvgPath`, `simplifyRing`, `getShapeRenderData`), `combineShapeNodes` / `canCombineShapeNodes`, and `combineShapes` / `unite` / `intersect` / `subtract` / `exclude` / `divide` / `canCombineShapes` on the arrange controller (one undo step with `HistoryManager`). `useCanvasArrange` and `createCanvasArrange` expose the new actions, and both packages add a headless `ShapeNode` component for React Flow / SvelteFlow.
- be14fc8: Add dependency-free DOCX, PDF and zipped-export import adapters.

  - **DOCX** is now a built-in `document` adapter (`docxImportAdapter`, `createDocxImportAdapter`, `docxToDocumentImport`): headings, run formatting, hyperlinks (incl. `HYPERLINK` fields), nested lists, tables, line breaks, tabs, footnotes / endnotes and embedded images, sanitized with `sanitizeImportedHtml`. Tracked changes import as accepted by default (`trackedChanges: "original"` to reject). `getImportAccept("document")` now includes `.docx`, `.docm`, `.dotx` and the WordprocessingML MIME types, so React `useFileImport` / `useEditor({ fileImport })` and Svelte `createFileImport` / the `fileImport` prop import Word files automatically.
  - **PDF** (opt-in): `createPdfImportAdapter(pdfjs)` takes an injected pdf.js-compatible object and groups text items into lines and paragraphs; `pdfTextItemsToParagraphs` is exported.
  - **Zipped exports** (opt-in): `zipImportAdapter` / `createZipImportAdapter` import `.zip` archives of markdown / HTML / text / DOCX files with a heading per file and report skipped entries.
  - **ZIP reader**: `readZip` / `ZipArchive` / `ZipError` parse ZIP (incl. ZIP64) and inflate with `DecompressionStream`, with entry-count, uncompressed-size, path-traversal, encryption and CRC-32 checks.
  - `ImportErrorCode` gains `invalid_file` and `unsupported_environment`; `ImportError`s thrown by adapters now keep their code instead of being wrapped as `adapter_failed`. `ImportContext` exposes the running `registry`.

- be14fc8: Spreadsheet dynamic arrays and date arithmetic.

  - **Spilling**: a formula returning several values (`=A1:A3`, `=A1:A3*2`, `=SEQUENCE(3)`, `INDEX(..., 0, n)`, 2D `XLOOKUP` results) spills into the cells below and to the right. Spilled cells keep an empty `raw`, carry `CellData.spillAnchor` and are not stored in the document. A blocked spill (non-empty cell, merged cells, another spill, or the edge of the sheet; the grid never grows) shows `#SPILL!` with a message naming the blocking cell. Typing into a spilled cell blocks the array; clearing it restores the spill. New controller methods `getSpillAt(row, col)` and `getSpills()` return `SpreadsheetSpill` objects.
  - **Recalculation**: spill ranges join the dependency graph (`DependencyGraph.setSpillEdges`), so dependents of spilled cells recalculate when the array changes size, and cycles through spills are `#CYCLE!`.
  - **`A1#` spill references** in the lexer (`SPILL_REF`), parser (`SpillRef`), evaluator (`EvaluationContext.resolveSpill`) and reference rewriting (insert/delete, paste/autofill offsets, sort/transpose remaps, clipboard JSON).
  - **Array functions**: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, TRANSPOSE, RANDARRAY and LET; element-wise arithmetic, comparison and `&` on arrays with broadcasting; scalar functions such as IF, LEN, ROUND and IFERROR apply element by element (`FormulaFunctionDefinition.elementwise`); implicit intersection `@`. New error codes `#SPILL!` and `#CALC!`. `evaluateWithDiagnostics` now also returns multi-value results in `array` (`value` is still the top-left value). LAMBDA is not implemented.
  - **Dates**: `date + n` / `date - n` return ISO dates, `date - date` returns days, and ISO dates compare chronologically. TRIM collapses inner runs of spaces like Excel.
  - **Table operations**: sorting, merging and transposing a range that touches a spill are refused; CSV/TSV export writes spilled values; copying spilled cells without their anchor pastes them as values.
  - **React / Svelte**: the spreadsheet editors draw a border around the active spill range and show the anchor's formula greyed out in the formula bar for spilled cells.

- be14fc8: Track formatting, block-structure and code-block edits in suggestion mode.

  - Core: `TrackChanges` now records formatting changes on existing text (mark added/removed/changed, e.g. bold, links, highlight, font size) with a `formatChange` mark holding the author, id and the `before` / `after` formatting, and textblock changes (paragraph ↔ heading, heading level, code block, alignment, list wrap/lift/indent/outdent, list type, blockquote) with a `blockChange` node attribute holding the previous type, attributes and wrappers. Accept/reject (single and all) handle every kind as one undo step; reject restores the previous formatting, type and nesting. Insertions and deletions inside code blocks are tracked as well. New options `trackFormatting`, `trackBlocks`, `trackCodeBlocks`, `blockTypes`, `ignoredMarks`, `ignoredBlockAttributes`, `formatChangeHTMLAttributes` and `blockChangeClass`.
  - `TrackedChange.type` adds `"format"` and `"block"`; every change has a human-readable `description` ("Formatted: Bold", "Changed Paragraph to Heading 2"), plus `format` / `block` details. New exports: `TrackedFormatChange`, `FORMAT_CHANGE_MARK_NAME`, `BLOCK_CHANGE_ATTRIBUTE`, `describeFormatChange`, `describeBlockChange` and the related types.
  - Serializers export the new formatting and block types by default and the original ones with `trackedChanges: "original"`. Pasted content drops format and block records.
  - React / Svelte: `ReviewToolbar` shows the current change's author and description (`showDescription`, `descriptionClassName` / `descriptionClass`).

### Patch Changes

- be14fc8: Fix UI bugs found in the browser:

  - Spreadsheet (React): text typed into a cell is committed again on Enter, Tab and blur (`setDraftValue` now updates the controller's draft).
  - Spreadsheet (React, Svelte): typing on a selected cell no longer doubles the first character, the cell editor is focused (Svelte), focus returns to the grid after Enter / Tab / Escape, sticky header and row-number cells are opaque, the context menu stays inside the viewport (new `clampMenuPosition` helper), and a denied clipboard write in the copy fallback no longer causes an unhandled rejection.
  - Canvas: the snapped position is kept when a drag ends (React Flow's drag-stop change and SvelteFlow's drop no longer restore the raw pointer position), and `snapPositionChanges` accepts React Flow's `NodeChange[]` (id-less `add` changes).

- Updated dependencies [be14fc8]
- Updated dependencies [be14fc8]
- Updated dependencies [be14fc8]
- Updated dependencies [be14fc8]
- Updated dependencies [be14fc8]
  - @pixerate/editor@0.22.0

## 0.13.0

### Minor Changes

- dd09aac: Per-feature entries so a spreadsheet- or image-only app does not take canvas dependencies.

  - **`@dagrejs/dagre` is now an optional peer dependency** of all three packages instead of a hard dependency of `@pixerate/editor` and `@pixerate/editor-svelte`. It is only used by the canvas entries; if you use `@pixerate/editor/canvas`, `@pixerate/editor-react/canvas`, `@pixerate/editor-svelte/canvas` or the agent canvas planner, add it to your app: `npm install @dagrejs/dagre`.
  - **New `./spreadsheet` subpath** in `@pixerate/editor-react` and `@pixerate/editor-svelte`. It imports only the framework and `@pixerate/editor/spreadsheet`, so it bundles no TipTap, markdown or dagre code. The root entries still re-export the spreadsheet components.
  - The React and Svelte spreadsheet and history bindings now import from the narrow `@pixerate/editor/spreadsheet` and `@pixerate/editor/history` subpaths instead of the root entry.
  - `@pixerate/editor` and `@pixerate/editor-react` are marked `sideEffects: false` so bundlers can drop unused root exports.
  - `tiptap-markdown` (already bundled into `@pixerate/editor`) moved to `devDependencies`, so it is no longer installed separately.

### Patch Changes

- Updated dependencies [dd09aac]
  - @pixerate/editor@0.21.0

## 0.12.0

### Minor Changes

- a626b31: Add Freeform-style canvas arrangement features. Core (`@pixerate/editor/canvas`) gains `alignNodes`, `distributeNodes` (equal gaps or equal centres), `matchSize`, node locking (`lockNodes` / `unlockNodes` / `isLocked`), z-order helpers (`reorderNodes` for bring forward / send backward / bring to front / send to back), smart guides with snap-to-shape (`computeSnapGuides`, `createGuideIndex`, `snapNodeDrag`, edge, centre and equal-spacing guides), connector snapping (`findConnectorSnap`, `nearestHandlePositions`), a headless Scenes store (`CanvasScenesStore`, `fitViewportToNodes`), arrange keyboard shortcuts (`matchArrangeShortcut`) and a shared `createCanvasArrangeController` with optional `HistoryManager` undo. React adds `useCanvasArrange`, `useCanvasArrangeShortcuts`, `useCanvasScenes` and `<CanvasGuidesLayer>`. Svelte adds `createCanvasArrange`, `createCanvasArrangeShortcuts`, `createCanvasScenes` and `<CanvasGuidesLayer>`.
- a626b31: Add document-structure features for the rich-text editor, all opt-in via new `createRichTextPreset` options (`outline`, `tableOfContents`, `footnotes`, `bookmarks`, `crossReferences`, `autocorrect`); existing consumers see no behaviour change.

  - **Outline**: `Outline` extension gives headings stable `id` attributes and keeps a heading outline in plugin state (`getOutline`, `buildOutlineTree`, `getActiveHeading`, `createOutlineStore`, `navigateToHeading`, `focusHeading` / `scrollToHeading` commands).
  - **Table of contents**: `TableOfContents` atom block with linked entries refreshed on every change, `insertTableOfContents` command, `[[toc]]` markdown round-trip.
  - **Footnotes**: `FootnoteReference`, `Footnotes` and `Footnote` nodes with automatic numbering, reordering and pruning; `insertFootnote`, `updateFootnote`, `deleteFootnote`, `goToFootnote`, `goToFootnoteReference` commands; `[^n]` markdown export and import.
  - **Bookmarks and cross-references**: `Bookmark` mark (`setBookmark`, `removeBookmark`, `renameBookmark`, `goToBookmark`) and `CrossReference` node that shows its target's current text and a broken state when the target is removed.
  - **Autocorrect**: `Autocorrect` extension with a rule registry (smart quotes, symbols, fractions, sentence capitalization, two initial capitals), an exceptions list, Word-like undo of a correction, and no corrections in code or prompt tokens. `SmilieReplacer` is unchanged; its smilies are also available as `smilieAutocorrectRules`.
  - `documentStructureCommandItems` / `getDocumentStructureCommandItems` for slash menus and toolbars.
  - React: `OutlinePanel` component and `useOutline` hook. Svelte: `OutlinePanel` component and `createOutline` rune.

- a626b31: Add file import adapters, a rich-text clipboard MIME type and a dynamic agent tool registry.

  - **Import adapters** (`@pixerate/editor`): `registerImportAdapter`, `findImportAdapter`, `importFile`, `getImportAccept` and `ImportAdapterRegistry`, with built-in markdown, HTML (sanitized), plain-text and RTF adapters for the `document` target. DOCX/PDF/zip or CSV → spreadsheet adapters can be registered. New serializers: `sanitizeHtml`, `sanitizeImportedHtml`, `plainTextToParagraphHtml`, `rtfToPlainText`.
  - **Drag-and-drop / picker import**: opt-in `FileImport` extension (`createRichTextPreset({ fileImport: true })`), `importFilesIntoEditor`, `FileImportController`; React `useFileImport` and `useEditor({ fileImport })` / `usePromptEditor({ fileImport })`; Svelte `createFileImport` and the `fileImport` prop on `EditableTextNodeEditor`.
  - **Rich clipboard**: opt-in `RichClipboard` extension writes `application/x.pixerate.document+json` (slice JSON + schema signature) on copy/cut and prefers it on paste when schemas match; `richClipboard` option in React `useEditor` and on the Svelte editor.
  - **Agent tool registry** (`@pixerate/editor/agent`): `ToolRegistry` with MCP-shaped `listTools` / `callTool`, JSON-Schema-lite argument validation (`validateJsonSchema`), structured errors, namespacing on name collisions and coalesced `onListChanged`. Providers: `createRichTextToolProvider`, `createSpreadsheetToolProvider`, `createEditorMcpToolProvider`. The planner gains `toolCallToAgentCommand`, `planToolCall` and a `tool:call` command / `step:tool_call` step. React and Svelte `useAgentToolProvider`.
  - Fix (Svelte): `EditableTextNodeEditor` no longer passes `undefined` `onUpdate`/`onCreate` to TipTap, which made editor updates throw when those props were omitted.

- a626b31: Prompt grammar: variable defaults, descriptions, conditional sections and resolution with values.

  - `{name|default|description}` variables (FILLIN-style). The tokenizer exposes `defaultValue` and `description` on variable tokens, and `\|`, `\{`, `\}`, `\\` escapes are supported.
  - `{?name}…{/name}` and `{!name}…{/name}` conditional sections, emitted as `conditional` tokens. They nest, and they work inside template bodies with cycle detection. Unbalanced tags stay literal text and are reported as diagnostics (`tokenizePromptWithDiagnostics`, `getPromptDiagnostics`).
  - New `values` option on `resolveTemplates` / `resolveTemplatesWithMapping`, and a new `resolvePrompt()` that returns `{ text, map, diagnostics }`. Source maps gain `variable` and `conditional` segments. Without `values`, output is unchanged.
  - Headless fill-in form helpers: `extractVariables`, `getVariableFormFields`, `compactVariableValues`, plus `evaluatePromptTokens` for renderers.
  - `GradientText` styles variables that have defaults, balanced conditional tags, and unbalanced conditional tags (each differently).
  - React and Svelte: `TemplateRenderer` accepts `values` and `bindings` and renders the new tokens. New `VariableForm` component.
  - `extractVariableNames` now strips defaults and includes names used by conditions. `resolveVariables` honors defaults and sections.

- a626b31: Add review features for the rich-text editor: comments and tracked changes.

  - Core: `Comments` extension (`comment` mark + `addComment` / `resolveComment` / `deleteComment` / `setActiveComment` / `focusComment`) backed by a headless, server-free `CommentStore` (threads, replies, resolve, orphan detection, `toJSON` / `load`). `TrackChanges` extension (suggestion mode) with `insertion` / `deletion` marks, `setTrackChanges` / `toggleTrackChanges`, `acceptChange` / `rejectChange` / `acceptAllChanges` / `rejectAllChanges` (single undo steps), `selectNextChange` / `selectPreviousChange`, and `getTrackedChanges`. Both are opt-in via `createRichTextPreset({ comments, trackChanges })`.
  - Serializers: `htmlToPlainText`, `getEditorText` and `getEditorMarkdown` accept `{ trackedChanges: "accepted" | "original" | "all" }` and default to `"accepted"`, so suggested deletions never leak into exported text. New `resolveTrackedChanges(doc, view)`.
  - React: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `useComments`, `useTrackChanges`.
  - Svelte: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `createComments`, `createTrackChanges`.

- a626b31: Spreadsheet formula engine: function registry, 70 new functions, diagnostics and autocomplete.

  - **Function registry** (`@pixerate/editor`): every formula function now has a category, description and argument specs. Use `registerFormulaFunction` / `unregisterFormulaFunction` to add or override functions, `listFormulaFunctions` / `searchFormulaFunctions` for function browsers, and `getFormulaSignature` (e.g. `SUMIF(range, criteria, [sum_range])`) / `getFormulaSignatureParts` for hints. The existing 16 functions moved onto the registry unchanged.
  - **New functions**: IFERROR, IFNA, AND, OR, NOT, XOR, IFS, SWITCH, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS, COUNTBLANK, INDEX, MATCH, XLOOKUP, VLOOKUP, HLOOKUP, LEFT, RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, TEXTJOIN, PROPER, EXACT, VALUE, TEXT, ROUNDUP, ROUNDDOWN, INT, MOD, POWER, SQRT, PRODUCT, MEDIAN, MODE, STDEV, VAR, LARGE, SMALL, RANK, CEILING, FLOOR, SIGN, PI, RAND, RANDBETWEEN, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, NETWORKDAYS, DATEDIF, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA. Criteria support `">5"`, `"<>x"`, `"=a"` and `*` / `?` wildcards.
  - **Diagnostics**: `FormulaEvaluator.evaluateWithDiagnostics()` returns `{ value, error, message }` with argument-indexed messages (`Argument 1 of SUMIF must be a range.`), unknown-function, argument-count and circular/self-reference messages. Cells get an optional `CellData.errorMessage`, and `CellData.error` now carries the code for value errors such as `#DIV/0!` (previously only set for `#CYCLE!` and malformed formulas). Wrong argument counts now return `#ERROR!` instead of throwing.
  - **Autocomplete**: `getFormulaCaretContext`, `getFormulaHints` and `applyFormulaSuggestion` in core; new `FormulaHints` components in React and Svelte, wired into the cell editor and formula bar of `SpreadsheetEditor` (ArrowUp/Down to choose, Tab or click to accept, Escape to close). Error cells show their message as a tooltip.

- a626b31: Spreadsheet table operations, CSV and rich clipboard.

  - `SpreadsheetController` gains undoable table operations: `sortRows` (multi-column, stable, numbers before text, blanks last; whole table or a range; header/footer rows stay put), filters (`addFilterRule`, `setFilterRules`, `updateFilterRule`, `removeFilterRule`, `clearFilters`, `setFiltersEnabled`, `toggleFilters`), header/footer/frozen row and column counts, `hideRows`/`hideColumns`/`unhideRows`/`unhideColumns`/`unhideAll`, `mergeCells`/`unmergeCells` (selection, navigation and editing respect merges), `autofill` (number/date series, "Item 1" → "Item 2", formulas with relative references shifted), categories (`groupRowsBy`, `setGroupSummary`, `toggleGroupCollapsed`, `getGroups`) and `transposeRange`. Sort and transpose keep formula references pointing at the moved cells, and merges follow row/column inserts and deletes.
  - `getViewModel()` / `buildSpreadsheetView()` describe what to render: visible rows (with group headers) and columns in display order, frozen offsets and merged-cell spans. Keyboard navigation follows the view, skipping hidden, filtered and collapsed rows.
  - New RFC 4180 CSV module (`parseCsv`, `serializeCsv`, `parseTsv`, `serializeTsv`) and `importFromCsv` / `exportToCsv`.
  - New spreadsheet clipboard: `copyToClipboardData` writes `text/plain` (TSV), `text/html` (a table) and `application/x.pixerate.spreadsheet+json` (raw inputs and formulas); `pasteClipboardData` prefers that format (formulas re-based to the target), then HTML tables, then TSV.
  - New core helpers: `offsetFormulaReferences`, `remapFormulaReferences`, `mapFormulaReferences`, `fillSeries`, `computeFillTarget`, `compareCellValues`, `matchesFilterRule`, `aggregateValues`, `getSpreadsheetMenuItems`, `bindSpreadsheetTableActions`.
  - React (`useSpreadsheetEditor`, `<SpreadsheetEditor />`) and Svelte (`createReactiveSpreadsheet`, `<SpreadsheetEditor />`) expose every table action plus `viewModel`, and render frozen panes (sticky), merged cells, hidden rows/columns, filtered-column markers and collapsible category headers with summaries. Both add a right-click table menu, a fill handle for autofill, and copy/paste of all three clipboard formats. Mod+C now lets the browser's `copy` event write the rich formats, falling back to `navigator.clipboard.writeText` (TSV) when no copy event fires.

### Patch Changes

- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
- Updated dependencies [a626b31]
  - @pixerate/editor@0.20.0

## 0.11.0

### Minor Changes

- 76593c8: Fix image editor geometry under rotate/flip/crop and make AI edits undoable.

  **`@pixerate/editor` (image editor)**

  - The crop box and annotations now live in one coordinate space: natural pixels of the source image. A single forward/inverse transform (90° rotations, flips, crop, fit scale, zoom, pan) drives rendering, export, hit-testing, viewport metrics and mask generation.
    - `canvasToImagePoint` now accounts for rotation, flips and the crop offset, and `imageToCanvasPoint` is its exact inverse. Results are no longer rounded to whole pixels.
    - The crop overlay and `getViewportMetrics().cropRect` are correct at 90°/270°. For example, the left half of an 800×600 image drawn at 90° is now 600×400, not 300×800.
    - `hitTestCrop` returns the crop handle in image space, so dragging a crop on a flipped or rotated image moves the correct edge. `getCropCursor(handle, transform?)` and `calculateCropDrag(..., aspectRatio, transform?)` take an optional transform so the cursor and the on-screen aspect ratio match what the user sees. `applyCropPreset` treats its ratio as the on-screen aspect.
    - The depth mask gets the same rotate/flip transform as the image.
    - Annotations stay attached to the image content when the image is rotated, flipped or cropped, and are clipped to the visible region. Annotations saved by earlier versions while a crop or rotation was active were stored in display space, so they may appear shifted.
  - `renderMask` is aligned with the natural-size source image. Its output is strictly black and white: annotations are never drawn in their own colours or opacity, and edges are thresholded. Negative circle radii no longer throw.
  - `applyInpaintedImage` and `applyBackgroundRemovedImage` are each a single undoable step. Undo restores the previous source image (URL and element), dimensions and annotations, and redo applies the edit again. If the new image has different dimensions, the crop and annotations are rescaled. `reset()` still returns to the image that was originally loaded.
  - New `renderSource()` / `toSourceDataURL()` return the untransformed source image, which is the image the mask lines up with.
  - The base-render cache key now includes `depthMask.maskSource` and the identity of the source image, so changing either re-renders the base image instead of showing a stale one.
  - `rotate`, `setRotation`, `flipHorizontal` and `flipVertical` now create a new `transform` object instead of changing the existing one, so subscribers that memoize by reference see the change.
  - There is now one `getAnnotationBounds` (in the geometry module). `ImageEditorRenderer#getAnnotationBounds` delegates to it and is deprecated.
  - When the controller is constructed with an image element, `sourceUrl` is now set from that element's `src`.

  **`@pixerate/editor-react` / `@pixerate/editor-svelte`**

  - The built-in AI panel now sends the untransformed source image (`toSourceDataURL()`) to `onInpaint` / `onRemoveBackground`, so the image and the mask line up, and the returned image replaces the source without crop, rotation or adjustments being applied twice.
  - The crop cursor and the aspect-locked crop drag respect rotation and flips.
  - `useImageEditor()` and `createReactiveImageEditor()` expose `toSourceDataURL()`.

### Patch Changes

- Updated dependencies [76593c8]
  - @pixerate/editor@0.19.0

## 0.10.5

### Patch Changes

- 1166e77: Fix several canvas, history and agent-planner engine bugs.

  - **`StreamingLayoutManager`**: `pushStreamUpdate` is now a real throttle (leading + trailing edge) instead of a debounce, so layouts keep running at most once per `throttleMs` during a continuous stream. Glides now animate known nodes from their current position to the newly computed layout. Previously every known node was pinned to its current position, so no glide ever ran. Only `layoutOptions.storedPositions` are treated as pinned. Added `getTargetPositions()`.
  - **`runMultiNodeTransition`** (core and the Svelte fork): no longer mutates the input nodes, and handles object styles (React Flow / xyflow) as well as CSS-string styles. Before this fix, an object `style` threw an error. **Behavior change:** updated node copies are passed to `onUpdate(nodes)` and `onComplete(nodes)`, in the same order as `transitions`. If your code read the mutated input nodes, merge these copies by `id` instead. A new `styleFormat: 'string' | 'object'` option controls the style created for nodes that have none (default `'string'`). `useCanvasExplosion` (React) passes `'object'`. Added the `withStyleOpacity` helper and the `CanvasNodeStyle` type. `CanvasNode.style` is now `string | Record<string, any>`.
  - **Canvas clipboard**: `isValidCanvasNode` now requires `position.x` and `position.y` to be finite numbers. A string like `"1e3"` is rejected. A non-array or malformed `edges` payload is ignored instead of crashing. `remapPastedNodes` remaps `parentId` (and the legacy `parentNode`) to the new parent ID when the parent was pasted too. In that case the child keeps its parent-relative position. Added `isValidCanvasEdge`. The Svelte `createCanvasClipboard` paste handler gets the same fixes.
  - **`HistoryManager`**: if `batch(fn)` throws, the commands that already ran in the batch are rolled back in reverse order, nothing is pushed, and the error is rethrown. If a command's `undo`/`redo` throws, the command stays on its original stack and the error is rethrown.
  - **Agent planner**: `canvas:add_node` accepts the schema's `side` values `top` and `bottom`, plus `above` and `below`. Before, `top` was treated as below. `canvas:layout` now defaults `incremental` to `true`, as the `edit_canvas` tool schema says. An unknown `nearNodeId` no longer adds a dangling edge. Added `normalizeSide`.

- Updated dependencies [1166e77]
  - @pixerate/editor@0.18.0

## 0.10.4

### Patch Changes

- Updated dependencies [ee94411]
  - @pixerate/editor@0.17.0

## 0.10.3

### Patch Changes

- 6b0aaed: Fix the image editor reverting AI edits, and `useHistory` losing history:

  - **React `useImageEditor` / `<ImageEditor src>` and Svelte `<ImageEditor src>`:** applying an inpainting or background-removal result no longer immediately reloads the original `src`. Previously the image was reloaded whenever the editor's source differed from `src`, which was always true after an AI edit. The image now reloads only when `src` itself changes.
  - **Svelte `createReactiveImageEditor`:** new `destroy()` method that stops syncing controller state. `<ImageEditor>` now calls it for its internal editor on unmount; previously that subscription leaked.
  - **React `useHistory`:** passing options inline (`useHistory({ maxDepth: 10 })`) no longer creates a new `HistoryManager`, and wipes the history, on every render. Options are read on the first render.

## 0.10.2

### Patch Changes

- a8f80dd: Fix spreadsheet keyboard handling in React and Svelte:

  - **Formula bar:** keystrokes no longer fall through to the grid. Previously Backspace in the formula bar cleared the active cell, arrow keys moved the cursor, and Enter re-opened the cell editor. In React, typing in the formula bar now actually edits the value; it commits on Enter or blur and is discarded on Escape. The formula bar is read-only for read-only sheets and columns.
  - **Redo:** Cmd/Ctrl+Shift+Z now redoes (with Shift held, `e.key` is `"Z"`), and Ctrl+Y is supported.
  - **Copy:** Cmd/Ctrl+C copies the selected range instead of the whole sheet. `SpreadsheetController.exportToTsv(range?)` accepts an optional range.
  - **React column resize:** `onColumnResize` now fires when the pointer stops moving before mouseup. Previously the effect re-subscribed after every width update and lost the drag state.
  - **React `useSpreadsheetEditor`:** the initial `document` now reflects the controller, so `<SpreadsheetEditor />` without a document renders the default grid immediately instead of an empty table. The `onDocumentChange`, `onSelectionChange` and `onCellCommit` callbacks are no longer captured once at mount.

- Updated dependencies [a8f80dd]
  - @pixerate/editor@0.16.2

## 0.10.1

### Patch Changes

- 0a1a841: Fix `usePromptEditor` lifecycle bugs:

  - Passing `templateColorMap` inline (`new Map(...)` in render) no longer causes an infinite render loop ("Maximum update depth exceeded"). The map is now compared by value.
  - Toggling `isEditing`, or changing `placeholder`, `className` or `jsonVariables`, updates the live editor instead of destroying and recreating it. Undo history, focus and the caret are kept.
  - `content` is now applied when the parent changes it, so you can clear the editor after submit with `setPrompt("")`. Echoes of the editor's own `onContentChange` are ignored, so typing never resets the caret.
  - Milestones use the core tokenizer, so `__award_winning__` now fires `used_magic`. Each milestone fires once per mount instead of on every keystroke.
  - Plain-text paste handling uses the new core `plainTextToSlice` helper, which replaces two duplicated copies. Core now exports `plainTextToSlice(text, schema)` from its serializers.

- Updated dependencies [0a1a841]
  - @pixerate/editor@0.16.1

## 0.10.0

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

## 0.9.5

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

## 0.9.4

### Patch Changes

- ac4f459: Add package READMEs (installation, API overview and Tailwind styling requirements) so the npm package pages are no longer empty.
- Updated dependencies [ac4f459]
  - @pixerate/editor@0.14.3

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
