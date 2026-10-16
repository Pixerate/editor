# @pixerate/editor

Editors for creative and AI apps: prompts, rich-text documents, spreadsheets, a design canvas and an image editor. The logic is plain TypeScript in one core package, with matching React and Svelte 5 packages on top.

**[Try the live demo →](https://pixerate.github.io/editor/)**

<p align="center">
  <a href="https://www.npmjs.com/package/@pixerate/editor"><img src="https://img.shields.io/npm/v/@pixerate/editor.svg?style=flat-square&color=rose" alt="npm core version" /></a>
  <a href="https://www.npmjs.com/package/@pixerate/editor-react"><img src="https://img.shields.io/npm/v/@pixerate/editor-react.svg?style=flat-square&color=blue" alt="npm react version" /></a>
  <a href="https://www.npmjs.com/package/@pixerate/editor-svelte"><img src="https://img.shields.io/npm/v/@pixerate/editor-svelte.svg?style=flat-square&color=orange" alt="npm svelte version" /></a>
  <a href="https://github.com/Pixerate/editor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Pixerate/editor/ci.yml?branch=main&style=flat-square" alt="CI build status" /></a>
  <a href="https://github.com/Pixerate/editor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
</p>

## What's inside

| Area | What you get | Core import |
| :--- | :--- | :--- |
| **Prompt engine** | `{{template}}`, `{variable\|default\|description}` and conditional-section grammar, recursive resolution with cycle detection, source maps back to the original text, fill-in forms, mail merge over CSV/JSON | `@pixerate/editor/grammar` |
| **Rich text** | TipTap preset with headings, lists, tables, links, images, footnotes, bookmarks, table of contents, paragraph styles, find & replace, mentions, slash commands and markdown | `@pixerate/editor/extensions` |
| **Review** | Comments with replies, tracked changes (insertions, deletions, moves, formatting), compare two documents into tracked changes | `@pixerate/editor/extensions`, `/compare` |
| **Import / export** | Import `.docx`, `.md`, `.html`, `.txt`, `.rtf`, PDF (layout-aware) and Notion/Confluence zips; export Word `.docx` with comments and tracked changes | `@pixerate/editor`, `/export` |
| **Spreadsheet** | Formula engine (dynamic arrays, `LAMBDA`, defined names, multiple sheets), Excel number formats, conditional formatting, data validation, sort/filter/freeze/merge, CSV, fast recalculation, virtualised grid | `@pixerate/editor/spreadsheet` |
| **Canvas** | Node graph tools on xyflow: align and distribute, smart guides, auto layout, curve-preserving shape booleans, design tokens with light/dark modes, components and instances, keyframe animation | `@pixerate/editor/canvas`, `/tokens`, `/animation` |
| **Vector editor** | Headless pen, pencil, shape, direct-selection, scissors, knife, eraser, width, Shape Builder and paint bucket tools over Bézier paths and groups: shape-keeping point deletion, segment bending, transforms with selection handles, boolean and Pathfinder operations, live per-corner radii (round, inverted, chamfer), inside / outside strokes, arrowheads, variable-width (tapered / pressure) strokes, align / distribute, grouping and stacking, smart guides with object and grid snapping, undo per gesture, DOM-free SVG import / export and agent commands | `@pixerate/editor/vector` |
| **Image editor** | Canvas 2D crop/rotate, adjustments and adjustment layers, blend modes, histogram, selections and masks (magic wand, Refine Edge), annotations | `@pixerate/editor/image-editor` |
| **Parameters** | Schema-driven control panel for effects, shaders, generators and component props: sliders, toggles, choices, colours, vectors, image pickers and text, with groups, conditional fields, presets, undo, randomize and keyframe diamonds | `@pixerate/editor/parameters` |
| **Commands and agents** | One command registry for shortcuts, the command palette and AI agent tools (MCP-style `tools/list` / `tools/call`) | `@pixerate/editor/commands`, `/agent` |
| **History and saving** | Undo/redo with gesture merging, dirty-vs-saved tracking, autosave with crash recovery, storage adapters (localStorage, IndexedDB, OPFS) | `@pixerate/editor/history`, `/persistence` |
| **AI generation** | Model capabilities and request planning, settings forms, job progress, generation records with Recreate, asset mentions with roles | `@pixerate/editor/generation` |

Everything in core runs without a framework (browser, Node.js, workers). The React and Svelte packages add hooks/runes and components for each area, with the same features in both (see [Feature parity](#feature-parity)).

## Packages

| Package | For | Install |
| :--- | :--- | :--- |
| [`@pixerate/editor`](./packages/core#readme) | Core logic, TipTap extensions, controllers; no UI framework | `npm i @pixerate/editor` |
| [`@pixerate/editor-react`](./packages/react#readme) | React 18+ hooks and components | `npm i @pixerate/editor @pixerate/editor-react` |
| [`@pixerate/editor-svelte`](./packages/svelte#readme) | Svelte 5 runes and components (shipped as source, SSR-friendly) | `npm i @pixerate/editor @pixerate/editor-svelte` |

- **Peer dependencies:** `@tiptap/core` and `@tiptap/pm` 2.x everywhere. React also needs `react`, `react-dom` and `@tiptap/react`; Svelte needs `svelte` 5. The canvas tools optionally use `@xyflow/react` / `@xyflow/svelte` and `@dagrejs/dagre`.
- **Subpath imports** keep bundles small: import only the area you use, e.g. `@pixerate/editor/spreadsheet` or `@pixerate/editor-react/canvas`. The [core README](./packages/core#readme) lists every entry point.
- **Styling:** the React and Svelte components use Tailwind CSS classes and shadcn-style theme tokens, so your Tailwind config must scan the package and define those colours. See *Styling* in the [React](./packages/react#styling-tailwind-css-required) or [Svelte](./packages/svelte#styling-tailwind-css-required) README.

## Quick start

### Prompt editor (React)

```tsx
import { useState } from "react";
import { usePromptEditor, EditorContent, TemplateRenderer } from "@pixerate/editor-react";

const templates = [{ name: "golden_hour", body: "warm 35mm volumetric lighting" }];

export function PromptStudio() {
  const [prompt, setPrompt] = useState("A photo of {subject} in {{golden_hour}}");
  const editor = usePromptEditor({ content: prompt, onContentChange: setPrompt, templates });

  return (
    <>
      <EditorContent editor={editor} />
      {/* Read-only preview with templates resolved */}
      <TemplateRenderer content={prompt} templates={templates} />
    </>
  );
}
```

### Rich-text document (React)

```tsx
import { useEditor, EditorContent, BubbleMenu } from "@pixerate/editor-react";

export function Document() {
  const editor = useEditor({ content: "<p>Hello</p>", richTextOptions: { markdown: true } });
  return (
    <>
      <BubbleMenu editor={editor}>
        <button onClick={() => editor?.chain().focus().toggleBold().run()}>Bold</button>
      </BubbleMenu>
      <EditorContent editor={editor} />
    </>
  );
}
```

### Rich-text document (Svelte 5)

```svelte
<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { EditableTextNodeEditor } from "@pixerate/editor-svelte";

  let editor = $state<Editor>();
  let html = $state("<p>Start writing…</p>");
</script>

<EditableTextNodeEditor
  bind:editor
  content={html}
  placeholder="Type anything…"
  onUpdate={() => (html = editor?.getHTML() ?? html)}
/>
```

### Spreadsheet (React)

```tsx
import { SpreadsheetEditor, useSpreadsheetEditor } from "@pixerate/editor-react/spreadsheet";

export function Sheet() {
  const state = useSpreadsheetEditor({
    onDocumentChange: (doc) => localStorage.setItem("sheet", JSON.stringify(doc)),
  });
  return <SpreadsheetEditor state={state} showSheetTabs />;
}
```

### Without a framework (Node.js, workers)

```ts
import { resolveTemplates, resolveTemplatesWithMapping } from "@pixerate/editor";
import { exportDocx } from "@pixerate/editor/export";

const templates = [
  { name: "mood", body: "cinematic cyber-noir" },
  { name: "scene", body: "rainy street with {{mood}}" },
];

resolveTemplates("Shot of {{scene}}", templates);
// → "Shot of rainy street with cinematic cyber-noir"

// Character offsets in the result map back to the source text.
const { text, map } = resolveTemplatesWithMapping("Shot of {{scene}}", templates);

// Variables with defaults, and conditional sections.
resolveTemplates("A {subject|red fox}{?style} by {style}{/style}", [], { values: { style: "Monet" } });
// → "A red fox by Monet"

// Word export from TipTap JSON or a live editor (comments and tracked changes included).
const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };
const { data, report } = await exportDocx(doc); // data: Uint8Array of the .docx
```

More examples: [prompt engine](docs/prompt-engine.md), [canvas](docs/canvas.md) and each package README.

## Demo

The demo is deployed to **https://pixerate.github.io/editor/** on every push to `main` that changes the demo or the packages. To run it locally:

```bash
pnpm install
pnpm build
pnpm --filter demo dev
```

Open http://localhost:3000. The demo has a tab per area: **Prompt Studio**, **Document Rich Text**, **Spreadsheet**, **Canvas**, **Image Editor**, **Parameters**, and a **Feature Parity Matrix**. A command palette (⌘K / Ctrl+K) works everywhere, and every tab except the parity matrix has an agent-tools panel listing the tools that tab registers.

## Feature parity

Every feature is available from core and from both framework packages. "Via core" means the framework package uses the core API directly, with no extra wrapper. Expand an area for the details.

<details>
<summary><strong>Prompt engine</strong> (17)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| AST Tokenizer (`tokenizePrompt`) | ✅ | ✅ | ✅ |
| Recursive Template Resolution | ✅ | ✅ | ✅ |
| Cycle Detection (`[Template loop detected]`) | ✅ | ✅ | ✅ |
| Bidirectional Sourcemapping | ✅ | ✅ | ✅ |
| Variable Defaults & Descriptions (`{name\|default\|description}`) | ✅ | ✅ | ✅ |
| Conditional Sections (`{?name}…{/name}`, `{!name}…{/name}`) with Diagnostics | ✅ | ✅ | ✅ |
| Resolution with Values (`values` option, `resolvePrompt`) | ✅ | ✅ | ✅ |
| Variable Fill-In Form (`getVariableFormFields` / `<VariableForm />`) | Headless | Component | Component |
| Value Preview in `<TemplateRenderer values />` | `evaluatePromptTokens` | ✅ | ✅ |
| Comparison Conditions (`{?amount>100}…{/amount}`, `= <> < > <= >=`) | ✅ | ✅ | ✅ |
| Mail-Merge Data Sources (`parseDataSource`, `matchFields`: CSV/TSV/JSON, fuzzy field matching) | ✅ | Via core | Via core |
| Multi-Record Merge & Preview (`mergeRecords` / `<MergePreview />`) | Headless | `<MergePreview />` & `useMergePreview` | `<MergePreview />` & `createMergePreview` |
| Plain Text Clipboard & Linebreak Parser | ✅ | ✅ | Via core¹ |
| Live Animated Gradient Text | ✅ | ✅ | Via core¹ |
| Slash Command Trigger (`/command`) | ✅ | ✅ | Via core¹ |
| Template Autocomplete (`{{`) | ✅ | ✅ | Via core¹ |
| Read-Only Token Renderer (`<TemplateRenderer />`) | AST Only | Component | Component |

</details>

<details>
<summary><strong>Rich text</strong> (14)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Floating Bubble Formatting Menu | Headless | Component | Component |
| Rich Text Preset (Headings, Lists, Task Lists, Links) | ✅ | ✅ | ✅ |
| Smilies (`:)` -> `🙂`) & Hex Highlighter | ✅ | ✅ | ✅ |
| Heading Outline & Navigation Panel (`outline`) | Headless (`createOutlineStore`) | `<OutlinePanel />` & `useOutline` | `<OutlinePanel />` & `createOutline` |
| Table of Contents Block (`tableOfContents`, `[[toc]]`) | ✅ | ✅ | ✅ |
| Footnotes (`footnotes`, markdown `[^n]`) | ✅ | ✅ | ✅ |
| Bookmarks & Cross-References (`bookmarks`, `crossReferences`) | ✅ | ✅ | ✅ |
| Autocorrect Rules & Exceptions (`autocorrect`) | ✅ | ✅ | ✅ |
| Document-Structure Slash/Toolbar Items (`getDocumentStructureCommandItems`) | ✅ | Via core | Via core |
| Paragraph styles (Normal, Title, Subtitle, Heading 1–6, Quote, Code, List Paragraph; `basedOn`, next style on Enter, linked character styles, user styles, `data-style` HTML) | `ParagraphStyles` (`paragraphStyles` preset option), `createStyleRegistry`, `createParagraphStylesStore` | `StylesGallery`, `useParagraphStyles` | `StylesGallery`, `createParagraphStyles` |
| Find & Replace (Word `^` codes, wildcards with `\1` groups, regex, match options; skips tracked deletions, tracked replacements) | `FindReplace` (`findReplace` preset option) | `FindReplaceBar`, `useFindReplace` | `FindReplaceBar`, `createFindReplace` |
| Tables (header rows/columns/cells, `colspan`/`rowspan`, resizable columns, cell alignment and background, never nested by paste or import; on by default, `table: false` to flatten) | `createTableExtensions` (`table` preset option), `createTableCommands`, `getTableState`, `createTableStore`, `edit_table` agent tool | `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `useTableMenu` | `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `createTableMenu` |
| Tables in exports and review (tab-separated plain text, GFM markdown or HTML fallback, GFM import, tracked row/column/table insertions and deletions, compare) | ✅ | Via core | Via core |
| Rich Clipboard MIME (`application/x.pixerate.document+json`) | `RichClipboard` | `richClipboard` | `richClipboard` prop |

</details>

<details>
<summary><strong>Review: comments, tracked changes, compare</strong> (9)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Comments (threads, replies, resolve, orphan detection, JSON) | Extension & `CommentStore` | `CommentsPanel`, `CommentButton`, `useComments` | `CommentsPanel`, `CommentButton`, `createComments` |
| Track Changes (insert/delete marks, accept/reject, navigation) | Extension & `getTrackedChanges` | `ReviewToolbar`, `useTrackChanges` | `ReviewToolbar`, `createTrackChanges` |
| Tracked-content export (`trackedChanges: "accepted"` default) | ✅ | Via core | Via core |
| Tracked formatting changes (`formatChange` mark, accept/reject, descriptions) | ✅ | `ReviewToolbar` description | `ReviewToolbar` description |
| Tracked block changes (heading/list/quote/alignment, `blockChange` attribute) | ✅ | `ReviewToolbar` description | `ReviewToolbar` description |
| Tracked edits inside code blocks | ✅ | Via core | Via core |
| Tracked moves (cut + paste / drag of a sentence or paragraph, linked move-from/move-to, accept/reject as one, `acceptMove`/`rejectMove`) | ✅ (`isMoveSized`, `trackMoves`, `isMove`) | `ReviewToolbar`, `TrackedChangesList` | `ReviewToolbar`, `TrackedChangesList` |
| Tracked changes list (accept/reject each change, select on click) | `getTrackedChanges`, `selectChange`, `trackedChangeLabel` | `TrackedChangesList` | `TrackedChangesList` |
| Compare Documents into tracked changes (word/char, ignore case/white space, formatting, whole-block insert/delete, optional moved paragraphs via `detectMoves`) | `compareDocuments`, `compareHtml`, `diffSequences` (`@pixerate/editor/compare`) & `setContentFromComparison` | `useDocumentCompare` | `createDocumentCompare` |

</details>

<details>
<summary><strong>Import and export</strong> (9)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| File Import Registry (`.md`, `.html`, `.txt`, `.rtf`, `.docx`; pluggable adapters) | ✅ | `useFileImport` + `fileImport` | `createFileImport` + `fileImport` prop |
| Drag-and-Drop File Import at Drop Position | `FileImport` | ✅ | ✅ |
| DOCX Import (headings, lists, tables, links, images, footnotes; dependency-free) | `docxImportAdapter` | Via core | Via core |
| DOCX Import of comments (replies, resolved), tracked changes (`trackedChanges: "marks"`: insertions, deletions, moves, `w:rPrChange`, `w:pPrChange`) and paragraph styles | `docxToDocumentImport`, `applyImportedReviewData` | Via core (`useFileImport` applies them) | Via core (`createFileImport` applies them) |
| Word (.docx) Export (styles, lists, tables, images, comments with replies, tracked changes with authors and dates, `privacy: "strip-authors"`) | `exportDocx`, `exportDocxBlob`, `DocxExportController` (`@pixerate/editor/export`) | `useDocxExport`, `ExportDocxButton` | `createDocxExport`, `ExportDocxButton` |
| PDF Import (injected pdf.js, opt-in) with layout analysis: reading order across columns, headings, lists, ruled and unruled tables, running headers/footers removed | `createPdfImportAdapter`, `analyzePdfLayout` | Via core | Via core |
| Import Structure Report and Plain Fallback Toggle (`adapterOptions: { pdf: { structure: false } }`) | `summarizeImportStructure` | `useFileImport().structureSummary` | `createFileImport().structureSummary` |
| Zipped Export Import (Notion / Confluence `.zip`, opt-in) | `zipImportAdapter` | Via core | Via core |
| Safe ZIP Reader (deflate via `DecompressionStream`, ZIP64, bomb / traversal guards) | `readZip` | Via core | Via core |

</details>

<details>
<summary><strong>Spreadsheet</strong> (27)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Spreadsheet Sort (multi-column, range) & Transpose (per-cell conditional formats / validations move with the cells) | ✅ | ✅ | ✅ |
| Spreadsheet Filters (per-column rules, toggle) | ✅ | ✅ | ✅ |
| Spreadsheet Freeze Panes, Header & Footer Rows | ✅ | ✅ | ✅ |
| Spreadsheet Hide/Unhide Rows & Columns | ✅ | ✅ | ✅ |
| Spreadsheet Merged Cells | ✅ | ✅ | ✅ |
| Spreadsheet Autofill (fill handle, series, formula shifting) | ✅ | ✅ | ✅ |
| Spreadsheet Categories (grouped rows, summaries, collapse) | ✅ | ✅ | ✅ |
| Spreadsheet CSV Import/Export (RFC 4180) | ✅ | ✅ | ✅ |
| Spreadsheet Clipboard (TSV + HTML + lossless JSON) | ✅ | ✅ | ✅ |
| Spreadsheet Table Context Menu | Headless | Component | Component |
| Spreadsheet Formula Function Registry (`registerFormulaFunction`) | ✅ | Via core | Via core |
| Spreadsheet Typed Input (numbers, currency, %, dates, times) & Excel Comparisons | `parseCellInput` / `formatCellDisplay` | Formatted cell display | Formatted cell display |
| Excel Number Formats (sections, `[Red]`, `[>=100]`, fractions, `E+`, `[h]:mm`, `TEXT()`, built-ins 0–49) | `NumberFormat` / `formatCellForDisplay` | Coloured, right-aligned numbers | Coloured, right-aligned numbers |
| Spreadsheet Cell & Column Number Formats (undoable, "Format cells" presets + custom code) | `setCellNumberFormat` / `setColumnNumberFormat` | Context menu | Context menu |
| Formula Error Diagnostics (`CellData.errorMessage`, error cell tooltips) | ✅ | ✅ | ✅ |
| Formula Autocomplete & Argument Hints (`<FormulaHints />`) | Headless (`getFormulaHints`) | Component | Component |
| Spreadsheet Dynamic Arrays (spilling, `#SPILL!`, `A1#` spill references) | `getSpillAt` / `getSpills` | Spill border + greyed formula bar | Spill border + greyed formula bar |
| Spreadsheet Conditional Formatting (highlight, formula, top/bottom, average, duplicates, dates, colour scales, data bars, icon sets; priority & stop if true) | `evaluateConditionalFormats` / `addConditionalFormat` | Fills, bars, icons + manager panel | Fills, bars, icons + manager panel |
| Spreadsheet Data Validation (whole, decimal, list, date, time, text length, custom; stop/warning/information alerts, circle invalid data) | `validateCellInput` / `addDataValidation` | List dropdown, alerts + manager panel | List dropdown, alerts + manager panel |
| Spreadsheet Incremental Recalculation (ranges indexed as intervals, dirty subgraph in topological order, volatile functions, one-pass bulk loads, blank-skipping aggregates) | `DependencyGraph` / `getRecalculationStats` | Via core | Via core |
| Spreadsheet Virtualised Rendering (visible rows/columns + overscan; frozen panes, merges, groups, keyboard scroll-into-view) | `getSpreadsheetViewWindow` / `getSpreadsheetScrollToCell` | `virtualize` prop / `useSpreadsheetViewport` | `virtualize` prop / `createSpreadsheetViewport` |
| Array Functions (FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, TRANSPOSE, RANDARRAY, LET) & array arithmetic | ✅ | Via core | Via core |
| LAMBDA (closures, inline calls, recursion cap) & MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY, ISOMITTED | ✅ | Via core | Via core |
| Defined Names (workbook/sheet scope, ranges, constants, LAMBDA names; rename rewrites formulas; saved in each sheet document's `names`) | `defineName` / `renameName` / `deleteName` | `<NameManager>` + name autocomplete | `<NameManager>` + name autocomplete |
| Multiple Sheets (`Sheet2!A1`, `'My Sheet'!A1:B2`, 3-D `Sheet1:Sheet3!A1`; rename/delete rewrite to `#REF!`, per-sheet undo) | `addSheet` / `renameSheet` / `moveSheet` / `deleteSheet` / `duplicateSheet` | `<SheetTabs>` (`showSheetTabs`) | `<SheetTabs>` (`showSheetTabs`) |
| Formula Date Arithmetic (`date ± days`, `date - date`, chronological date comparisons) | ✅ | Via core | Via core |
| Spreadsheet CSV / TSV File Import Adapters (import registry) | `importFileIntoSpreadsheet` | Via core | Via core |

</details>

<details>
<summary><strong>Canvas</strong> (27)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Canvas Align / Distribute / Make Same Size | ✅ | `useCanvasArrange` | `createCanvasArrange` |
| Canvas Lock / Unlock & Layer Order (Front / Back) | ✅ | `useCanvasArrange` | `createCanvasArrange` |
| Canvas Smart Guides & Snap-to-Shape (edges, centres, spacing) | ✅ | Hook & `<CanvasGuidesLayer>` | Rune & `<CanvasGuidesLayer>` |
| Canvas Resize & Grid Snapping | `snapResize` & `snapToGrid` | `useCanvasArrange` (`snapResizeChanges`) | `createCanvasArrange` (`resizerHandlers`) |
| Canvas Distance Measuring (Alt-hover) | `measureBetween` & `measureSelection` | `useCanvasMeasure` & `<CanvasGuidesLayer>` | `createCanvasMeasure` & `<CanvasGuidesLayer>` |
| Canvas Auto Layout & Constraints (stack, wrap, grid, hug / fill) | `layoutFrame`, `layoutAll`, `layoutUp` & `createCanvasAutoLayoutController` | `useCanvasAutoLayout` | `createCanvasAutoLayout` |
| Canvas Auto Layout Drag Reorder | `getAutoLayoutInsertTarget` & `moveLayoutChild` | `useCanvasAutoLayout` (`noteChanges`) | `createCanvasAutoLayout` (`dragReorder`) |
| Design Tokens: Collections, Modes, Aliases & Undoable Store | `TokenStore` & `resolveToken` (`/tokens`) | `useTokens` & `<TokensPanel>` (`/tokens`) | `createTokens` & `<TokensPanel>` (`/tokens`) |
| Design Tokens: W3C JSON Import / Export & CSS Variables per Mode | `importW3CTokens`, `exportW3CTokens` & `exportTokensCss` | `useTokens` (`css`, `cssVariables`) | `createTokens` (`css`, `style`) |
| Canvas Token Bindings & Per-Frame Modes | `bindCanvasToken`, `setCanvasTokenMode` & `resolveCanvasTokens` | `useCanvasTokens`, `<TokenBindingPicker>` & `<TokenModeSwitcher>` | `createCanvasTokens`, `<TokenBindingPicker>` & `<TokenModeSwitcher>` |
| Canvas Components & Instances (overrides, variants, properties, nested, detach / reset / push) | `syncCanvasComponents` & `createCanvasComponentsController` | `useCanvasComponents`, `<CanvasComponentsPanel>` & `<CanvasInstanceInspector>` | `createCanvasComponents`, `<CanvasComponentsPanel>` & `<CanvasInstanceInspector>` |
| Canvas Variant Editing (add / remove / edit / rename variants and their properties) | `addCanvasVariant`, `removeCanvasVariant`, `renameCanvasVariantProperty`, … | `<CanvasComponentsPanel components>` | `<CanvasComponentsPanel components>` |
| Canvas Component Commands & Agent Tools | `createComponentCommands` & `createCanvasComponentToolProvider` | Via core & `useRegisterCommands` | Via core & `useRegisterCommands` |
| Canvas Bézier Curve Fitting (boolean results, freehand) | `fitCubics` & `fitPathData` | Via core | Via core |
| Canvas Scenes (saved viewports, next / previous) | `CanvasScenesStore` | `useCanvasScenes` | `createCanvasScenes` |
| Canvas Connector Snapping to Shape Sides | ✅ | Via core | Via core |
| Canvas Arrange Keyboard Shortcuts | `matchArrangeShortcut` | `useCanvasArrangeShortcuts` | `createCanvasArrangeShortcuts` |
| Canvas Shape Boolean Ops (Unite / Intersect / Subtract / Exclude / Divide, curve-preserving) | `combineShapeNodes`, `pathBoolean` & `polygonBoolean` | `useCanvasArrange` | `createCanvasArrange` |
| Canvas Offset Path & Outline Stroke (joins, caps, miter limit, dashes) | `offsetPath`, `outlineStroke`, `offsetShapeNodes` & `outlineShapeNodeStrokes` | `useCanvasArrange` (`offsetShapes`, `outlineStroke`) | `createCanvasArrange` (`offsetShapes`, `outlineStroke`) |
| Canvas Shape Commands (palette / context menu) | `createShapeCommands` | Via core & `useRegisterCommands` | Via core & `useRegisterCommands` |
| Canvas Shape Nodes (rect, ellipse, polygon, star, SVG path) | `getShapeRenderData` | `<ShapeNode>` | `<ShapeNode>` |
| Canvas Freehand Drawing Tools (pen, highlighter, eraser, smoothing, SVG path nodes, undo/redo) | `createCanvasDrawController`, `streamlinePoints`, `strokeToShapeNode`, `findStrokesAtPoint` | `useCanvasDraw` & `<CanvasDrawLayer>` | `createCanvasDraw` & `<CanvasDrawLayer>` |
| Canvas Keyframe Animation (tracks, easing incl. spring, OKLab colours, record mode, undoable edits) | `evaluateAnimation`, `moveKeyframes`, `recordAnimationChanges` & `createCanvasAnimationController` | `useCanvasAnimation` | `createCanvasAnimation` |
| Canvas Animation Timeline (scrub, draggable keyframes with snapping, easing picker) | `getTimelineRows` & `snapKeyframeDelta` | `<AnimationTimeline>` | `<AnimationTimeline>` |
| Canvas Animation Playback & Export (injected clock, loop / ping-pong, CSS / Web Animations, frames) | `AnimationPlayer`, `exportCssAnimation`, `toWebAnimations` & `sampleAnimationFrames` | `useCanvasAnimation` | `createCanvasAnimation` |
| Canvas Animation Commands & Agent Tools | `createCanvasAnimationCommands` | Via core & `useRegisterCommands` | Via core & `useRegisterCommands` |
| Standalone Keyframe Model (tracks, easing, OKLab colours, evaluation, player and clock with no canvas nodes or dagre) | `evaluateTrack`, `evaluateEasing` & `AnimationPlayer` (`/animation`) | Via core | Via core |

</details>

<details>
<summary><strong>Vector editor</strong> (11)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Vector Document Model (Bézier paths with corner / smooth / symmetric anchors, compound paths, groups, gradients, hidden / locked nodes, rigid per-node transforms) | `VectorDocument` & geometry helpers (`/vector`) | `<VectorCanvas>` | `<VectorCanvas>` |
| Vector Tools (select, direct select, pen, pencil with lazy-mouse smoothing and shape recognition, rectangle, ellipse, polygon, star, line, scissors, knife, eraser, width, Shape Builder, paint bucket; keyboard shortcuts; pan / zoom; grid snapping) | `VectorEditorController` | `useVectorEditor`, `useVectorEditorController` & `useVectorEditorState` | `createVectorEditor` |
| Vector Smart Guides & Object Snapping (anchors, paths, curve intersections, perpendicular / tangent points, edges, centres, artboard, construction angles, equal spacing, matching sizes; rotated nodes; Cmd / Ctrl bypass; labelled guides) | `VectorSnapTargets`, `setSnap` & `getVectorOverlayRenderData().guides` | `<VectorCanvas>` guides & `<VectorToolbar>` snapping toggle | `<VectorCanvas>` guides & `<VectorToolbar>` snapping toggle |
| Vector Transforms (move, resize and rotate handles with a selection box that stays rotated, set rotation, flip, align, distribute, arrange, group / ungroup, duplicate, copy / paste) | `transform`, `setRotation`, `align`, `distribute`, `arrange`, `group` | `<VectorToolbar>` | `<VectorToolbar>` |
| Vector Path Editing (move points and handles, add / delete points, convert corner ↔ smooth, close / open, reverse) and Boolean Operations | `insertAnchorAt`, `convertAnchors`, `booleanOp` | `<VectorCanvas>` & `<VectorToolbar>` | `<VectorCanvas>` & `<VectorToolbar>` |
| Vector Path Clean-Up & Cutting (shape-keeping point deletion, segment bending, Curvature point moves, Join, Average, Remove Redundant Points, Smooth, Scissors, gap-free Knife, Eraser; all in each node's own space) | `deleteAnchors`, `bendSegment`, `joinPaths`, `knife`, `erase`, `setEditing` & `pathEdit` / `pathCut` helpers | `<VectorCanvas>` strokes & `<VectorToolbar>` path-editing group | `<VectorCanvas>` strokes & `<VectorToolbar>` path-editing group |
| Vector Live Corners & Stroke Options (per-anchor corner radius drawn round / inverted / chamfered at render, hit-test, bounds, boolean, outline and export time; rectangle, polygon and star tools keep editable corners; draggable corner widgets in the direct tool; centre / inside / outside stroke alignment; arrowheads with tip / extend alignment and per-end scale; Outline Stroke) | `expandVectorCorners`, `setCornerRadius`, `vectorStrokeParts`, `outlineStroke` & `getVectorOverlayRenderData().cornerWidgets` | `<VectorCanvas>` corner widgets & clipped strokes, `<VectorStylePanel>` | `<VectorCanvas>` corner widgets & clipped strokes, `<VectorStylePanel>` |
| Vector Variable-Width Strokes (width profiles with left / right side scales and monotone interpolation; taper, bulge, pinch, wave and pressure presets; parametric taper / wave; exact filled outlines refitted to Béziers with caps, joins, dashes, corners, arrowheads and alignment; Width tool (W) with draggable width points, Alt-drag copies, discontinuous points, Shift multi-selection and a numeric Width Point Edit on double-click; arrowheads sized from the profile; pencil pen pressure; SVG round-trip; Outline Stroke bakes them) | `strokeWidthProfile`, `setWidthProfile`, `setWidthPoint`, `widthPointEdit`, `selectedWidthPoints`, `variableStrokeOutline`, `widthProfileAt` & `getVectorOverlayRenderData().widthPoints` | `<VectorCanvas>` width points, filled outlines & `<VectorWidthPointEditor>`, `<VectorStylePanel>` profile picker | `<VectorCanvas>` width points, filled outlines & `<VectorWidthPointEditor>`, `<VectorStylePanel>` profile picker |
| Vector Pathfinder, Shape Builder & Paint Bucket (Divide, Trim, Merge, Crop, Outline, Minus Back on rotated shapes with holes, live corners and stroke areas; Shape Builder (M) hover / click / drag merge and Alt delete of faces and line pieces; paint bucket (B) fills the region outlines enclose, islands as holes, optional gap closing) | `pathfinder`, `shapeBuilder`, `fillRegion`, `PlanarMap` & `getVectorOverlayRenderData().builder` | `<VectorCanvas>` face highlights & `<VectorToolbar>` Pathfinder group | `<VectorCanvas>` face highlights & `<VectorToolbar>` Pathfinder group |
| Vector Style Panel (fill, stroke, width, alignment, width profile, arrowheads, corner radius and kind, opacity; defaults for new shapes) | `getVectorSelectionStyle`, `setStyle` & `setCornerRadius` | `<VectorStylePanel>` | `<VectorStylePanel>` |
| Vector SVG Import / Export & Agent Commands | `parseVectorSvg`, `vectorDocumentToSvg` & `createVectorCommands` | `useVectorCommands` | `useVectorCommands` |

</details>

<details>
<summary><strong>Image editor</strong> (10)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Image Editor Canvas 2D Engine & Transformations | ✅ | Component & Hook | Component & Rune |
| Image Filters & Adjustments | ✅ | ✅ | ✅ |
| Image White Balance (Temperature / Tint, eyedropper) & Process Versions | ✅ | ✅ | ✅ |
| Image Adjustment Layers (Curves, Levels, Hue/Saturation, Vibrance, Color Balance, B&W, Photo Filter, …) | ✅ | `<AdjustmentLayersPanel>` & `<CurvesEditor>` | `<AdjustmentLayersPanel>` & `<CurvesEditor>` |
| Photoshop Blend Modes (layers & annotations) | `blendPixel` & `BLEND_MODES` | ✅ | ✅ |
| Image Histogram | `computeHistogram` | `<Histogram>` & `useImageHistogram` | `<Histogram>` & `createImageHistogram` |
| Image Adjustment Control Table & Agent Tools | `IMAGE_ADJUSTMENT_CONTROLS` & `createImageEditorToolProvider` | `<ControlSlider>` | `<ControlSlider>` |
| Image Selections & Masks (magic wand, colour range, marquees, lasso, modes, grow/shrink/feather/border/smooth, guided-filter Refine Edge, Quick Mask, adjustment layer masks, RLE in the document, agent tools) | `SelectionGesture`, `magicWand`, `refineSelection`, `layerMaskFromSelection` | `<SelectionOptionsBar>` & `<RefineEdgePanel>` | `<SelectionOptionsBar>` & `<RefineEdgePanel>` |
| Vector Annotations (Pen, Rect, Circle, Arrow, Line, Text) | ✅ | ✅ | ✅ |
| Gleamforge Depth & Alpha Masking | ✅ | ✅ | ✅ |

</details>

<details>
<summary><strong>Parameters</strong> (8)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Parameter Schema (number / int, boolean, choice, color with optional alpha, vector 2–4, image, text; labels, descriptions, defaults) | `ParameterSchema` & `checkParameterSchema` (`/parameters`) | `<ParametersPanel>` | `<ParametersPanel>` |
| Collapsible Groups & Conditional Fields (`showIf`) | `getParameterVisibility` | `<ParametersPanel>` | `<ParametersPanel>` |
| Parameters Controller (validation with sentence errors, stable `getState`, `subscribe`, reset, seeded randomize, `toJSON` / `load`) | `ParametersController` | `useParameters`, `useParametersController` & `useParametersState` | `createParameters` |
| Parameter Undo with Merged Slider Drags (shared or own `HistoryManager`) | `beginGesture` / `endGesture` | `<ParameterSlider>` & `<ParameterColor>` | `<ParameterSlider>` & `<ParameterColor>` |
| Parameter Presets (apply, save, delete; built-in presets read-only) | `applyPreset`, `savePreset`, `deletePreset` | `<ParametersPanel>` | `<ParametersPanel>` |
| Field Controls (slider + number, toggle, select / segmented, colour, vector, image picker, text) | Headless helpers (`parseParameterNumberInput`, `formatParameterValue`) | `<ParameterFieldControl>` & per-type components | `<ParameterFieldControl>` & per-type components |
| Parameter Keyframe Hooks (`AnimationTrack`-shaped tracks, key at playhead, undoable toggle, keys follow edits) | `ParameterKeyframes` & `createParameterKeyframeStore` | `<KeyframeDiamond>` | `<KeyframeDiamond>` |
| Parameter Commands & Agent Tools; Shader `@control` Adapter | `createParameterCommands` & `parameterSchemaFromShaderControls` | `useParameterCommands` | `useParameterCommands` |

</details>

<details>
<summary><strong>Commands and agent tools</strong> (6)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Dynamic Agent Tool Registry (MCP `tools/list` / `tools/call`, `listChanged`) | `ToolRegistry` | `useAgentToolProvider` | `useAgentToolProvider` |
| Command Registry (enablement with reasons, strict params, structured results) | `CommandRegistry` (`/commands`) | `useRegisterCommands` | `useRegisterCommands` |
| Shortcuts as Data (`Mod`, scopes, user overrides, per-platform conflict audit) | `ShortcutMap` & `formatShortcut` | `useCommandShortcuts` | `createCommandShortcuts` |
| Command Palette (fuzzy ranking, recents, shortcuts, disabled reasons) | `rankCommands` & `createCommandPaletteController` | `<CommandPalette>` & `useCommandPalette` | `<CommandPalette>` & `createCommandPalette` |
| Commands as Agent Tools (`list_commands`, `run_command`, `run_commands`) | `createCommandToolProvider` | Via core | Via core |
| Built-in Commands (history undo/redo, canvas arrange, spreadsheet table) | `createHistoryCommands`, `createArrangeCommands`, `createSpreadsheetCommands` | Via core | Via core |

</details>

<details>
<summary><strong>History, autosave and persistence</strong> (7)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| History Gesture Merge Keys & Held Gestures (`executeMerged(cmd, { key })`, `beginGesture` / `endGesture`) | `HistoryManager` | `useHistory` | `createHistory` |
| History Undo Marks / Escape-Cancel (`mark`, `revertTo`) | `HistoryManager` | `useHistory` | `createHistory` |
| History Panel & Memory Budget (`getEntries`, `goTo`, `maxBytes` / `sizeOf`) | `HistoryManager` | `useHistory().entries` | `createHistory().entries` |
| Dirty-vs-Saved Tracking (undo-to-saved is clean, `normalize`, `suppress`) | `DirtyTracker` & `bindDirtyToHistory` | `useHistoryDirty` | `createHistoryDirty` |
| Autosave & Crash Recovery (hydration gate, backoff retry, flush on page hide, own-snapshot-only clean) | `createAutosaveController` & `createRecoveryPolicy` (`/persistence`) | `useAutosave` & `<RecoveryPrompt>` | `createAutosave` & `<RecoveryPrompt>` |
| Storage Adapters (memory, localStorage, IndexedDB, OPFS with atomic writes) | `create*Storage` / `create*Adapter` | Via core | Via core |
| Document Migration & Load Reports (step-wise `migrateDocument`, per-section fallback, read-only newer versions) | `migrateDocument`, `loadSections`, `loadImageEditorDocument` | Via core | Via core |

</details>

<details>
<summary><strong>AI generation</strong> (7)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Generation Model Capabilities & Request Planning (snap / clamp / truncate, strategies) | `planGenerationRequest` (`/generation`) | `useGenerationPlan` | `createGenerationPlan` |
| Generation Settings Form from Capabilities (enums, ranges, reference slots, adjustments) | `getGenerationControls` & `getReferenceSlots` | `<GenerationSettings>` | `<GenerationSettings>` |
| Generation Agent Tools (`list_models`, `plan_generation`, `estimate_generation`, idempotent `generate`) & JSON Schema | `createGenerationToolProvider` & `capabilitiesToJsonSchema` | Via core | Via core |
| Generation Provenance (pinned template versions, sourcemap, `recreateRequest`) & Batch Resolver | `createProvenance` & `createBatchResolver` | Via core | Via core |
| Generation Job Progress (time-based, ≤95% until done, "~2m left") | `estimateJobProgress` | `<JobProgress>` & `useJobProgress` | `<JobProgress>` & `createJobProgress` |
| Asset Mentions with Roles (`@fox:style`, `data-role`, per-role limits & media types from capabilities) | `findTextMentions`, `extractMentions({ details })`, `validateAssetMentions`, `PlanOptions.mentions` | `<AssetMentionChips>` (role picker popover) | `<AssetMentionChips>` (role picker popover) |
| Generation Records & Recreate (template/model/asset hashes, `exact` / `latest`, drift report, variations, record store with filter / prune) | `createGenerationRecord`, `recreateRequest`, `variationRequest`, `createGenerationRecordStore` | `<GenerationHistory>` & `useGenerationRecords` | `<GenerationHistory>` & `createGenerationRecords` |

</details>

¹ Svelte doesn't have a prompt-editor equivalent of React's `usePromptEditor` yet. Configure the core extensions (`GradientText`, `TemplateSuggestions`, `SlashCommands`) and pass them to `EditableTextNodeEditor` via `extensions`, or use `createEditor({ plainTextMode: true })` from `@pixerate/editor`.

## Documentation

- [Architecture](docs/architecture.md)
- [Prompt grammar and resolution](docs/prompt-engine.md)
- [Canvas](docs/canvas.md)
- [Parameters editor](docs/parameters.md)
- [Vector editor](docs/vector-editor.md)
- [CI/CD and releases](docs/ci-cd-release.md)
- [Known pitfalls and workarounds (GOTCHAS)](GOTCHAS.md)

## Contributing

This is a pnpm monorepo: `packages/core`, `packages/react`, `packages/svelte` and `apps/demo`. Before opening a pull request:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm --filter demo build
```

Use Conventional Commits, add a changeset (`pnpm changeset`) for any change to a published package, keep React and Svelte at parity, and record new pitfalls in [GOTCHAS.md](GOTCHAS.md). The full rules are in [Agents.md](Agents.md). Merges to `main` publish to npm.

## License

MIT © Pixerate. Some code is adapted from MIT / Apache-2.0 projects; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
