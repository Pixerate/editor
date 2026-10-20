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
| **Import / export** | Import `.docx`, `.md`, `.html`, `.txt`, `.rtf`, PDF (layout-aware) and Notion/Confluence zips; export Word `.docx` with comments, tracked changes and native charts | `@pixerate/editor`, `/export` |
| **Spreadsheet** | Formula engine (dynamic arrays, `LAMBDA`, defined names, multiple sheets), Excel number formats, conditional formatting, data validation, sort/filter/freeze/merge, CSV, fast recalculation, virtualised grid | `@pixerate/editor/spreadsheet` |
| **Canvas** | Node graph tools on xyflow: align and distribute, smart guides, auto layout, curve-preserving shape booleans, design tokens with light/dark modes, components and instances, keyframe animation | `@pixerate/editor/canvas`, `/tokens`, `/animation` |
| **Vector editor** | Headless pen, pencil, shape, direct-selection, scissors, knife, eraser, width, Shape Builder, paint bucket, blend, gradient and envelope-mesh tools over Bézier paths and groups: shape-keeping point deletion, segment bending, transforms with selection handles, Free Distort (perspective) and skew, live envelope warps (fifteen presets and editable Bézier meshes, Make with Top Object), boolean and Pathfinder operations, live blends with rotation-aware path morphing, non-destructive path effects (trim, round corners, pucker & bloat, twist, zig zag, wiggle, offset, merge, repeater) and live booleans, stacked fills and strokes with per-layer opacity and blend modes, node blend modes, drop / inner shadows, glows, blurs and feather, linear, radial (focal point, aspect), conic, reflected and diamond gradients with stop midpoints, sRGB / linear-light / Oklab interpolation, spread modes and gradients along or across strokes, live per-corner radii (round, inverted, chamfer), inside / outside strokes, arrowheads, variable-width (tapered / pressure) strokes, align / distribute, grouping and stacking, smart guides with object and grid snapping, undo per gesture, DOM-free SVG import / export and agent commands | `@pixerate/editor/vector` |
| **Vector animation** | Animation editor for vector artwork (footage goes in the video editor): scenes of shots whose commands (enter, including wipe, iris and split reveals through a clip, draw, move, morph, Smart Animate between two groups, follow a path, emphasis such as pulse, teeter and seeded wiggle, live path-effect tweens, camera framing; named and defaulted like Flair's motion primitives) take their timing from the content (springs last until they settle; repeats loop, mirror or carry on; stepped "on twos" time; geometric zoom), frames as pure functions of time, coded issues with "did you mean", undoable all-or-nothing edits, fitting to a length, cues to a beat or a voiceover, onion skin and motion paths on the stage, hand-editing controls in React and Svelte (scrubber, command list and schema-generated inspector, ease picker with curve preview, picking on the stage, shot and scene settings), reusable clips, drivers, PowerPoint import, text by letter, word or line, 33 agent tools, export to Flair's vector motion and catalog effects (and import from them) and to Lottie | `@pixerate/editor/animation-editor` |
| **Video editor** | Non-linear video editor over plain-JSON projects: video, audio and image assets on video and audio tracks (earlier tracks draw on top), media clips with in points, speed, volume, fades (with shaped sound fades), opacity, fit and transforms, titles and colour clips, markers; insert, overwrite, move, trim, split, slip, roll, slide, lift and extract a range and cut across tracks, with ripple that keeps sync-locked tracks in step, as undoable all-or-nothing edits that never add an error; crossfade, dip, wipe, push, slide and iris transitions over the cut with handle checks that say the longest that fits; coded issues; frames as layers and sounds (`videoFrameAt`); browser playback on a canvas that keeps `<video>` / `<audio>` elements in step; snapping to edges, markers and the playhead; keyframes on opacity, volume and transform (clip time, linear / hold / named / cubic-bezier easing, kept through splits and trims); SVG frames and contact sheets; waveforms from a peak pyramid decoded once per asset; editing by text from transcripts (fillers, pauses, phrases); speed ramps and freeze frames; sound levels and silence detection; 3D LUTs (`.cube`, tetrahedral, at a strength) on grades; proxies the preview plays at a chosen scale (with ffmpeg commands that make them); an optional cache of decoded frames with prefetch ahead of the playhead; colour scopes (histogram, luma waveform, vectorscope) with exposure and clipping figures; nested sequences played by compound clips as one picture and sound (grouped, blended and graded as a whole in the preview, SVG and ffmpeg); export to an ffmpeg command or a CMX 3600 EDL (drop-frame at NTSC rates); 59 agent tools | `@pixerate/editor/video-editor` |
| **Mermaid diagrams** | Flowchart, state, class and ER diagrams edited on the canvas, and sequence, Gantt, pie, quadrant, XY, radar, timeline, journey, mindmap, gitGraph, C4 and architecture diagrams drawn as Mermaid draws them and edited statement by statement: untouched statements, comments and formatting round-trip byte for byte, edits rewrite only the statements they touch, positions live in a `%% @pixerate` comment; nested groups with dagre layout, a streaming view for diagrams a model is still writing, `findMermaidSources` for Mermaid in Markdown or chat, sankey and treemap data readers, and 23 agent tools | `@pixerate/editor/diagram`, `/canvas` |
| **Chart editor** | Bar, line, area, scatter, bubble, pie, donut, radar, waterfall, histogram, box, funnel and treemap charts (combos with a secondary axis, stacked and 100% stacked, horizontal bars, numeric-x scatter, date axes, trendlines, spreadsheet format codes) from a validated JSON spec; a DOM-free layout engine with click targets and layout warnings, drag-to-edit with snapping, keyboard editing, a data grid with paste and CSV import, presets and colour-blind checks, Mermaid and Office (DOCX / PPTX chart XML) import and export, charts read from `.xlsx` / `.pptx` / `.docx` files, streaming views, sparklines, accessible SVG and PNG, and 28 agent tools whose edits can be acted out with a cursor | `@pixerate/editor/chart` |
| **Image editor** | Layer stack on tiled copy-on-write surfaces with live layer effects, Free Transform (scale, rotate, skew, distort, perspective, warp), vector shape layers, Canvas 2D crop/rotate, adjustments and adjustment layers, blend modes, histogram, selections and masks (magic wand, Refine Edge), annotations, PSD open and export | `@pixerate/editor/image-editor` |
| **Paint editor** | Natural-media painting on the shared raster stack and brush engine: generated paper grain in a library of families (watercolour, drawing, pastel, canvas, gesso) with grain depth, grain-responsive dry media (pencil, pastel, charcoal, airbrush, marker, ink, erasers) with pressure, tilt, barrel rotation and velocity, blending tools (a pigment blender that mixes nearby colours, smudge with pigment mixing, Mixer Brush), brush behaviours (pick-up and mix ratios, dirty and multi-coloured brushes), separately smoothed position and pressure, brush rotation modes, a brush library with JSON import / export and thumbnails, strokes as data that replay and vary, view rotation and mirroring, mirror and kaleidoscope painting, perspective guides with one to three vanishing points, tracing and reference images, colour harmonies on the painter's RYB wheel, swatches and a pigment mixing pad with measured mixes and kept pads, painterly layer blend modes (watercolor, tint, highlight, shadow), JSON + PNG documents, PNG / JPEG / WebP / PSD export, 67 agent tools | `@pixerate/editor/paint-editor` |
| **Raster layers** | Shared by the image and paint editors: tiled copy-on-write surfaces, PNG / zlib codec, blend modes, the generic layer stack (pixel layers, groups, masks, clipping, locks), layer effects, nearest / bilinear / bicubic resampling through transforms and warps, and the per-tile compositor engine with caches; no DOM, runs in Workers | `@pixerate/editor/raster` |
| **Brush engine** | Shared by the image and paint editors: round computed tip with hardness, angle, roundness and spacing, opacity versus flow build-up, smoothing, pen pressure, the stroke coverage buffer applied to raster tiles, the Mixer Brush (a reservoir that picks up and blends canvas colour per dab, RGB or pigment mixing) on the shared pick-up / mix exchange that wet media will reuse, a pigment blender and a patch-carrying smudge, and pigment-like colour mixing (Kubelka-Munk over reflectance spectra, so blue and yellow make green); no DOM | `@pixerate/editor/paint` |
| **Parameters** | Schema-driven control panel for effects, shaders, generators and component props: sliders, toggles, choices, colours, vectors, image pickers and text, with groups, conditional fields, presets, undo, randomize and keyframe diamonds | `@pixerate/editor/parameters` |
| **Commands and agents** | One command registry for shortcuts, the command palette and AI agent tools (MCP-style `tools/list` / `tools/call`), and an MCP bridge so Claude Desktop, Claude Code or an IDE can drive editors open in a browser | `@pixerate/editor/commands`, `/agent` |
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

Open http://localhost:3000. The demo has a tab per area: **Prompt Studio**, **Document Rich Text**, **Spreadsheet**, **Canvas**, **Vector**, **Animation**, **Video**, **Image Editor**, **Parameters**, and a **Feature Parity Matrix**. A command palette (⌘K / Ctrl+K) works everywhere, and every tab except the parity matrix has an agent-tools panel listing the tools that tab registers.

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
<summary><strong>Rich text</strong> (15)</summary>

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
| Chart & Sparkline Nodes (`chart` preset option: live chart blocks storing a `ChartSpec`, static SVG in HTML, ` ```mermaid ` in markdown, DOCX charts imported as charts, inline sparklines; click to edit with the inspector; `insert_chart`, `list_document_charts`, `update_chart_in_document`, `insert_sparkline` agent tools) | `Chart`, `Sparkline`, `ChartNodeView`, `getDocumentCharts` | `createReactChartNodeView`, `<ChartNodeView>` | `createSvelteChartNodeView`, `<ChartNodeView>` |

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
| DOCX Import (headings, lists, tables, links, images, footnotes, charts — as `chart` nodes when the schema has them, else a caption and a data table; dependency-free) | `docxImportAdapter` | Via core | Via core |
| DOCX Import of comments (replies, resolved), tracked changes (`trackedChanges: "marks"`: insertions, deletions, moves, `w:rPrChange`, `w:pPrChange`) and paragraph styles | `docxToDocumentImport`, `applyImportedReviewData` | Via core (`useFileImport` applies them) | Via core (`createFileImport` applies them) |
| Word (.docx) Export (styles, lists, tables, images, `chart` nodes as native Word charts, sparklines as text, comments with replies, tracked changes with authors and dates, `privacy: "strip-authors"`) | `exportDocx`, `exportDocxBlob`, `DocxExportController` (`@pixerate/editor/export`) | `useDocxExport`, `ExportDocxButton` | `createDocxExport`, `ExportDocxButton` |
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
<summary><strong>Canvas</strong> (33)</summary>

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
| Mermaid Diagram Model (flowchart, state, class, ER, pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY, radar; lossless parse / serialise, statement-level edits, `%% @pixerate` layout comment, Ursula's `@ursula` read; sankey, block, packet, kanban, treemap kept as text, sankey and treemap data readable) | `parseMermaid`, `applyEdits`, `serializeMermaid`, `DiagramController`, `parseSankey` & `parseTreemap` (`/diagram`) | `useMermaidDiagram` & `useDiagramState` | `createMermaidDiagram` |
| Mermaid Family Vocabulary (shapes, edge kinds, groups, direction, id scheme, new-node defaults and data fields per family; starter templates and titles) | `familyUI`, `checkFieldData`, `FAMILY_TEMPLATES`, `FAMILY_TITLES` (`/diagram`) | Via core | Via core |
| Mermaid Family Pictures (sequence lifelines, Gantt bars, pie wedges, quadrant points, XY and radar charts, timelines, journeys, mindmaps, git graphs, C4 and architecture, as marks that select their node; family layouts from the data; also used by SVG / PNG export) | `mermaidToScene`, `registerFamilyScene`, `registerFamilyLayout` & `diagramRenameOp` (`/canvas`) | `useMermaidDiagram().scene` & `<MermaidFamilyScene>` | `createMermaidDiagram().scene` & `<MermaidFamilyScene>` |
| Mermaid Diagrams on the Canvas (dagre with nested groups and per-group direction, stored positions blended with new nodes, drags back to `moveNodes`, SVG geometry for the flowchart and state shapes) | `mermaidToCanvas`, `ensureDiagramLayout`, `mermaidMovesFromCanvas` & `mermaidShapePaths` (`/canvas`) | `<MermaidDiagramNode>` & `<MermaidDiagramGroup>` | `<MermaidDiagramNode>` & `<MermaidDiagramGroup>` |
| Mermaid Streaming View & Finder (nodes held back until an edge places them, glide between layouts; diagrams found in Markdown, chat and bare text) | `DiagramStream`, `blendDiagramLayout`, `streamedDiagramText` & `findMermaidSources` | `useMermaidStream` | `createMermaidStream` |
| Mermaid Diagram Agent Tools (23 tools: read, export, find, load, add / remove / rename / reshape / style nodes, node and edge data fields, diagram settings and title, connect / label / reconnect edges, groups, direction, moves, undo / redo; checked against the diagram and the family's fields first) | `createDiagramToolProvider` | `useAgentToolProvider` | `useAgentToolProvider` |
| Mermaid Diagram Export & Thumbnails (standalone SVG matching the canvas layout, with Mermaid styles, arrow heads and labels, or the family's picture; fitted thumbnails; PNG in the browser; `render_diagram` agent tool) | `mermaidToSvg`, `mermaidThumbnailSvg`, `rasterizeSvg` & `downloadDiagramPng` (`/canvas`) | `<MermaidThumbnail>` | `<MermaidThumbnail>` |
| Mermaid Diagram Agent Cursors (agent edits acted out on the canvas: move, click, drag, connect, type; a whole-diagram write drawn statement by statement; one undo step per call, rolled back if the diagram changed underneath; pure planner, injectable clock; shared with the chart director) | `DiagramDirector`, `planDiagramEdit`, `draftFrames`, `PresenceStore` & `PerformanceQueue` (`/animation`) | `useDiagramDirector` & `<DiagramPresenceLayer>` | `createDiagramDirector` & `<DiagramPresenceLayer>` |
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
<summary><strong>Vector editor</strong> (18)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Vector Document Model (Bézier paths with corner / smooth / symmetric anchors, compound paths, groups, gradients, hidden / locked nodes, rigid per-node transforms) | `VectorDocument` & geometry helpers (`/vector`) | `<VectorCanvas>` | `<VectorCanvas>` |
| Vector Tools (select, direct select, pen, pencil with lazy-mouse smoothing and shape recognition, rectangle, ellipse, polygon, star, line, scissors, knife, eraser, width, Shape Builder, paint bucket, blend, gradient; keyboard shortcuts; pan / zoom; grid snapping) | `VectorEditorController` | `useVectorEditor`, `useVectorEditorController` & `useVectorEditorState` | `createVectorEditor` |
| Vector Smart Guides & Object Snapping (anchors, paths, curve intersections, perpendicular / tangent points, edges, centres, artboard, construction angles, equal spacing, matching sizes; rotated nodes; Cmd / Ctrl bypass; labelled guides) | `VectorSnapTargets`, `setSnap` & `getVectorOverlayRenderData().guides` | `<VectorCanvas>` guides & `<VectorToolbar>` snapping toggle | `<VectorCanvas>` guides & `<VectorToolbar>` snapping toggle |
| Vector Transforms (move, resize and rotate handles with a selection box that stays rotated, set rotation, flip, align, distribute, arrange, group / ungroup, duplicate, copy / paste) | `transform`, `setRotation`, `align`, `distribute`, `arrange`, `group` | `<VectorToolbar>` | `<VectorToolbar>` |
| Vector Path Editing (move points and handles, add / delete points, convert corner ↔ smooth, close / open, reverse) and Boolean Operations | `insertAnchorAt`, `convertAnchors`, `booleanOp` | `<VectorCanvas>` & `<VectorToolbar>` | `<VectorCanvas>` & `<VectorToolbar>` |
| Vector Path Clean-Up & Cutting (shape-keeping point deletion, segment bending, Curvature point moves, Join, Average, Remove Redundant Points, Smooth, Scissors, gap-free Knife, Eraser; all in each node's own space) | `deleteAnchors`, `bendSegment`, `joinPaths`, `knife`, `erase`, `setEditing` & `pathEdit` / `pathCut` helpers | `<VectorCanvas>` strokes & `<VectorToolbar>` path-editing group | `<VectorCanvas>` strokes & `<VectorToolbar>` path-editing group |
| Vector Live Corners & Stroke Options (per-anchor corner radius drawn round / inverted / chamfered at render, hit-test, bounds, boolean, outline and export time; rectangle, polygon and star tools keep editable corners; draggable corner widgets in the direct tool; centre / inside / outside stroke alignment; arrowheads with tip / extend alignment and per-end scale; Outline Stroke) | `expandVectorCorners`, `setCornerRadius`, `vectorStrokeParts`, `outlineStroke` & `getVectorOverlayRenderData().cornerWidgets` | `<VectorCanvas>` corner widgets & clipped strokes, `<VectorStylePanel>` | `<VectorCanvas>` corner widgets & clipped strokes, `<VectorStylePanel>` |
| Vector Variable-Width Strokes (width profiles with left / right side scales and monotone interpolation; taper, bulge, pinch, wave and pressure presets; parametric taper / wave; exact filled outlines refitted to Béziers with caps, joins, dashes, corners, arrowheads and alignment; Width tool (W) with draggable width points, Alt-drag copies, discontinuous points, Shift multi-selection and a numeric Width Point Edit on double-click; arrowheads sized from the profile; pencil pen pressure; SVG round-trip; Outline Stroke bakes them) | `strokeWidthProfile`, `setWidthProfile`, `setWidthPoint`, `widthPointEdit`, `selectedWidthPoints`, `variableStrokeOutline`, `widthProfileAt` & `getVectorOverlayRenderData().widthPoints` | `<VectorCanvas>` width points, filled outlines & `<VectorWidthPointEditor>`, `<VectorStylePanel>` profile picker | `<VectorCanvas>` width points, filled outlines & `<VectorWidthPointEditor>`, `<VectorStylePanel>` profile picker |
| Vector Pathfinder, Shape Builder & Paint Bucket (Divide, Trim, Merge, Crop, Outline, Minus Back on rotated shapes with holes, live corners and stroke areas; Shape Builder (M) hover / click / drag merge and Alt delete of faces, line pieces and outline edges (an erased edge opens its path) with a hatched highlight; paint bucket (B) fills the region outlines enclose, islands as holes, optional gap closing) | `pathfinder`, `shapeBuilder`, `fillRegion`, `PlanarMap`, `cutOutPiece`, `hatchPath` & `getVectorOverlayRenderData().builder` | `<VectorCanvas>` hatched face highlights & `<VectorToolbar>` Pathfinder group | `<VectorCanvas>` hatched face highlights & `<VectorToolbar>` Pathfinder group |
| Vector Blends & Path Morphing (live blend groups regenerated whenever a key changes; specified steps, specified distance or smooth colour; replace spine with orient to spine; Expand and Release; Blend tool (J) with clicked start anchors; morphs with arc-length anchor insertion, start and winding chosen by fit and shape context, Procrustes in-betweens that turn rather than collapse, holes growing from points, OKLab colours, resampled gradients, width profiles and rigid transforms; path keyframes for animation; SVG round-trip) | `blend`, `setBlendOptions`, `replaceBlendSpine`, `expandBlend`, `createVectorMorph`, `interpolateVectorPaths`, `evaluateVectorPathKeyframes` & `getVectorOverlayRenderData().blend` | `<VectorCanvas>` spines & Blend tool picks, `<VectorToolbar>` Blend group | `<VectorCanvas>` spines & Blend tool picks, `<VectorToolbar>` Blend group |
| Vector Path Effects (editable effect stacks on paths and groups: Trim Paths simultaneous / individual, Round Corners, Pucker & Bloat, Twist, Zig Zag, seeded Wiggle Paths, Offset Paths with copies, Merge Paths, Repeater with opacity ramp and fractional copies; After Effects stacking; effected geometry for render, hit-test, bounds, snapping, booleans, Pathfinder and SVG; per-node cache; Expand Appearance; slider drags as one undo step) | `addEffect`, `updateEffect`, `expandAppearance`, `expandVectorAppearance`, `applyVectorEffects` & `getVectorEffectsPanel` | `<VectorEffectsPanel>` (in `<VectorStylePanel>`) & `<VectorCanvas>` | `<VectorEffectsPanel>` (in `<VectorStylePanel>`) & `<VectorCanvas>` |
| Vector Appearance Stack (several fills and strokes per path, bottom to top with fills under strokes, each with its own paint, opacity, blend mode and visibility and each stroke with its own width, alignment, dashes, caps, joins, arrowheads and profile; `fill` / `stroke` as shorthands for the top layer, so old documents and commands keep working; node blend modes from the CSS `mix-blend-mode` set under the image editor's names; drop shadow, inner shadow, outer / inner glow, layer blur and feather as one SVG filter per node; topmost-visible-paint hit-testing; Outline Stroke per stroke layer; gradient editor and tool per layer; SVG export with filters and lossless round-trip, import of `fill-opacity`, `mix-blend-mode`, `feDropShadow` / blur filters and, optionally, stacked shapes; agent commands `vector.addFill` … `vector.moveFilter`) | `addPaintLayer`, `updatePaintLayer`, `movePaintLayer`, `setBlendMode`, `addFilter`, `vectorFills`, `vectorStrokes`, `vectorFilterSvg`, `hitTestVectorPaintLayer` & `getVectorAppearancePanel` | `<VectorAppearancePanel>` (in `<VectorStylePanel>`), `<VectorFilterDefs>` & `<VectorCanvas>` layers | `<VectorAppearancePanel>` (in `<VectorStylePanel>`), `<VectorFilterDefs>` & `<VectorCanvas>` layers |
| Vector Masks & Clipping (mask groups whose first child masks the rest: clipping masks by outline, alpha and luminance opacity masks, inverted masks (an even-odd clip of a rectangle with the mask's union cut out; a colour-matrix filter for opacity masks); a hidden mask turns it off; hit-testing, bounds, snapping, booleans and the Pathfinder on the masked result, open paths cut where they cross; the group's filters, opacity and blend mode apply to the masked result and its path effects to the contents; Make Clipping Mask (Mod+7), Make Opacity Mask, Release (Mod+Alt+7), Edit Mask / Edit Contents; SVG export as `<clipPath>` / `<mask>` with a lossless round-trip and import of foreign `clip-path` / `mask` references (user space and `objectBoundingBox` units); agent commands `vector.makeClippingMask`, `vector.makeOpacityMask`, `vector.setMaskOptions`, `vector.releaseMask`) | `makeMask`, `releaseMask`, `setMaskOptions`, `editMask`, `vectorMaskRenderData`, `vectorMaskContains`, `getVectorMaskPanel` & `getVectorOverlayRenderData().masks` | `<VectorMaskPanel>` (in `<VectorStylePanel>`), `<VectorMaskedNodes>`, `<VectorToolbar>` mask actions & `<VectorCanvas>` mask indicator | `<VectorMaskPanel>` (in `<VectorStylePanel>`), `<VectorMaskedNodes>`, `<VectorToolbar>` mask actions & `<VectorCanvas>` mask indicator |
| Vector Live Booleans (boolean groups whose operands stay editable, each with its own operation; prefix-cached fold so an edit recombines only the operands above it; hit-testing by the result, or by the operands while entered; destructive booleans kept) | `booleanOp(op, { live })`, `foldVectorBooleanOperands` & `vectorEnteredGroups` | `<VectorToolbar>` Live toggle | `<VectorToolbar>` Live toggle |
| Vector Distort & Envelopes (Free Distort mode of the selection box: corners distort in perspective by an exact homography, Shift+Alt+Mod for symmetric perspective, Mod-drag a side to skew; `distort(corners)` and `skew(ax, ay)` on rotated nodes too; adaptive curve mapping within a tolerance, refitted to fewer anchors; live envelope effect with Photoshop's fifteen warp presets — bend, horizontal / vertical distortion, orientation — or an editable bicubic mesh of rows × columns split exactly with de Casteljau; Envelope tool (U) dragging anchors, handles and the surface, one undo step per gesture; Make with Top Object, Release, Expand; user-space gradient handles mapped; agent commands `vector.distort`, `vector.skew`, `vector.envelope`) | `setFreeDistort`, `distort`, `skew`, `envelope`, `makeEnvelopeWithTopObject`, `releaseEnvelope`, `mapVectorSubpaths`, `vectorHomography`, `vectorWarpPresetMesh`, `getVectorEnvelopePanel` & `getVectorOverlayRenderData().envelope` / `.distort` | `<VectorEnvelopePanel>` (in `<VectorStylePanel>`), `<VectorToolbar>` Distort toggle & `<VectorCanvas>` mesh / quad overlay | `<VectorEnvelopePanel>` (in `<VectorStylePanel>`), `<VectorToolbar>` Distort toggle & `<VectorCanvas>` mesh / quad overlay |
| Vector Gradients (linear, radial with focal point / focal radius and aspect, conic, reflected and diamond; explicit start / end / aspect frames in the box or node space with the angle / centre shorthand; stop midpoints, smoothness and sRGB / linear-light / Oklab interpolation exported as extra stops; pad / reflect / repeat; within, along or across strokes; conic, diamond and stroke modes as SVG patterns; Gradient tool (G) with start, end, radius, aspect and focal handles, click-to-add, drag and drag-off-to-delete stops and midpoints, one undo step per gesture; gradients follow scale and skew; SVG import of fx / fy / fr / spreadMethod / gradientTransform / userSpaceOnUse and lossless round-trip) | `setGradient`, `setGradientStop`, `vectorGradientSvgDefs`, `expandVectorGradientStops`, `sampleVectorGradientAt`, `getVectorGradientEditor` & `getVectorOverlayRenderData().gradient` | `<VectorGradientEditor>` (in `<VectorStylePanel>`), `<VectorGradientAnnotator>` & `<VectorGradientDefs>` | `<VectorGradientEditor>` (in `<VectorStylePanel>`), `<VectorGradientAnnotator>` & `<VectorGradientDefs>` |
| Vector Style Panel (fill, stroke, gradient editor, width, alignment, width profile, arrowheads, corner radius and kind, opacity, fill and stroke stacks, blend mode, filters, effects, envelope; defaults for new shapes) | `getVectorSelectionStyle`, `setStyle` & `setCornerRadius` | `<VectorStylePanel>` | `<VectorStylePanel>` |
| Vector SVG Import / Export & Agent Commands | `parseVectorSvg`, `vectorDocumentToSvg` & `createVectorCommands` | `useVectorCommands` | `useVectorCommands` |

</details>

<details>
<summary><strong>Vector animation</strong> (10)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Animation Scenes (vector artwork plus shots of commands: enter (fade, pop, grow, slide, draw, zoom, rise, and wipe, iris and split reveals through a clip on the frame, `MotionFrame.clips`), exit (fade, shrink, slide, undraw, wipe), draw (strokes together, in sequence by length or out from a point, at one speed, or as a travelling comet), move (straight, or smoothly through `via` waypoints at a steady speed with no overshoot), rotate, scale, fade, style, morph, outlined text animated a letter, word or line at a time (`split`, `cascade`, `motionTextLayout`), drivers (a property following another node's: parallax, a wheel turning as it rolls; `motionPropertyValue`, typed one a line in `SceneSettings`), play (reusable named clips written against `"$"`, played on any nodes with stagger and speed; `motionClipLayout`), match (Smart Animate: a group into another, part by part, paired by name, id and kind; `matchMotionNodes`), follow a path, emphasis (pulse, shake, teeter, wave, wiggle, color-pulse) as Flair's behaviours, additive layers (`blend: "add"`, the default for emphasis) that stack on moves, turns and scales, live path-effect tweens; each names the Flair motion primitive it plays (`motionFlairPrimitive`); camera moves and framing (`geometric` for an even zoom); timing from the content: springs (`spring-gentle`, `-quick`, `-bouncy`, `-slow` or custom) last until they settle, `repeat` with `loop`, `mirror` or `offset`, stepped time (`steps`) per command or scene; a shot's `speed` scales all its time, and `fitMotionScene` / `fit_animation` fits the scene to a length, keeping chosen shots' pace; shots cued (`at`) to a beat grid, a voiceover's word timings or a time, the shot before holding until the cue) | `MotionScene`, `parseMotionScene`, `compileMotionScene` (`/animation-editor`) | Via core | Via core |
| Frames at Any Time (vector document and camera, SVG with the camera as the viewBox, colour control values; onion skin ghosts and motion paths drawn on the stage; motion blur (`scene.motionBlur`, `motionBlurTimes`) averaging moments across the shutter, more for faster motion, on the stage and rendered frames; `motionContactSheetSvg` puts several moments in one labelled picture) | `motionFrameAt`, `motionFrameToSvg`, `motionStageSvg`, `motionGhosts`, `motionPath` | `<AnimationStage onionSkin motionPaths>` | `<AnimationStage onionSkin motionPaths>` |
| Animation Editor (undoable all-or-nothing edits, playback on an injectable clock, shot selection, read-only; `<AnimationEditor>` puts the stage, scrubber and every hand-editing panel together, `editable={false}` for a player) | `AnimationEditorController`, `applyMotionEdits` | `useAnimationEditor` & `<AnimationEditor>`, `<ShotTimeline>` | `createAnimationEditor` & `<AnimationEditor>`, `<ShotTimeline>` |
| Animation Hand Controls (playhead scrubber: ruler with shot bands, beat grid and narration marks, drag to scrub, play / pause / loop; command list per shot: add, reorder, duplicate, delete, inline `with` and `delay`; command inspector generated from `MOTION_COMMAND_SCHEMA` (enums as selects, numbers with units and limits, node pickers) showing each command's Flair primitive; ease picker with presets incl. springs and a curve drawn from `evaluateEasing`; click an element on the stage to pick it, shift-click to toggle it as a target; shot inspector: label, hold, speed, camera framing, cue picker for `at`; scene settings: loop, fps, steps, target length with Fit, beat grid, narration words; every change one undo step, refusals shown with their reason) | `motionCommandFields`, `motionFieldEdit`, `defaultMotionCommand`, `motionCommandRows`, `motionEasingCurve`, `motionNodeAtElement`, `highlightMotionSvg`, `motionRulerTicks`, `fitMotionSceneEdits`, `motionCueChoices`, `parseMotionNarration`, `move_command` edit | `<PlayheadScrubber>`, `<CommandList>`, `<CommandInspector>`, `<EasePicker>`, `<ShotInspector>`, `<SceneSettings>`, `<AnimationStage onPick highlight>` | `<PlayheadScrubber>`, `<CommandList>`, `<CommandInspector>`, `<EasePicker>`, `<ShotInspector>`, `<SceneSettings>`, `<AnimationStage onpick highlight>` |
| Animation Checks (coded issues with severity, shot, command, ids and measured / needed values; "did you mean" for unknown ids) | `checkMotionScene`, `MOTION_ISSUE_CODES` | Issue list in `<AnimationEditor>` | Issue list in `<AnimationEditor>` |
| Flair Export (`SvgMotion`, catalog `VectorEffect` with colour controls and presets, `EffectDocument`; a scene `trigger` plays it on click (a Flair step per shot), hover, press or scroll; exact for Flair's curves and, with Flair ≥ 0.36, any cubic-bezier ease; with Flair ≥ 0.38, pulses, shakes, teeters, waves, wiggles and colour pulses as one change with a `behavior`; reveals as a wrapper group with an animated `objectBoundingBox` clip rect or circle; follows as Flair `along` + `orient` on a wrapper; with Flair ≥ 0.39, springs and stepped time (`strobe`) too, mirrored repeats as reversed curves; `flair` picks the version; elastic, geometric zooms and morphs sampled) | `toFlairSvgMotion`, `toFlairVectorEffect`, `toFlairEffectDocument` | Via core | Via core |
| Lottie Export (Bodymovin JSON v5 for lottie-web and the mobile players: one shape layer whose groups mirror the artwork, solid fills and strokes, trim paths for drawing on, the camera as a root transform, a marker per shot; cubic-bezier changes as eased keyframes, the rest sampled; notes on gradients, dashes, reveals and point-changing morphs) | `toLottie` | Via core | Via core |
| PowerPoint Import (a slide's shapes — preset and custom geometry, groups, fills, outlines, theme colours — become the artwork and its animation pane becomes a shot per click: entrances, exits, emphasis and motion paths mapped to commands, with previous / after previous, delays, repeats and acceleration kept; notes for text, pictures and unmatched effects) | `fromPptxAnimation` | Via core | Via core |
| Flair Import (a Flair `SvgMotion` or catalog `VectorEffect` becomes a scene: SVG as artwork, `{{name: color}}` placeholders as colour controls, each step a shot of commands, behaviours back to emphasis commands, with notes on what does not carry over) | `fromFlairSvgMotion`, `fromFlairVectorEffect` | Via core | Via core |
| Animation Agent Tools (33 tools: read, read outlined text as letters, words and lines, import a PowerPoint slide, set drivers, define clips, copy one node's motion to others, find elements, trace a node's motion path, render a frame with onion skin and paths, read the beat grid and narration, check, render a frame, export to Flair or Lottie, import a Flair effect, fit to a length, artwork from SVG, add / change / move / delete shots and commands (`move_command` reorders a command), settings, controls, batched edits with dry run where later ops refer to earlier ones' outcomes (`"$0.indexes[0]"`, `resolveMotionEditRefs`), a contact-sheet render, seek, undo / redo) | `createAnimationEditorToolProvider`, `ANIMATION_EDITOR_AGENT_INSTRUCTIONS` | `useAnimationEditorTools` | `useAnimationEditorTools` |

</details>

<details>
<summary><strong>Video editor</strong> (15)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Video Projects (assets with kind, src, duration, size, sound and poster; video and audio tracks with mute, hide, lock and volume, listed top to bottom with earlier video tracks drawn on top; media clips with `in`, `speed` or a speed ramp (`timeRemap`: clip time to source time, eased glides and freeze frames), `volume`, `muted` and sound fade curves (linear, equal-power, s-curve, exponential, logarithmic, matching ffmpeg's `afade`); titles; colour clips; entrance and exit animations (fade, rise, drop, slide, zoom, pop, written out as keyframes); opacity, `fit` (contain / cover / fill / none), blend modes (13, shared by canvas, SVG and ffmpeg's `blend`), colour grades (exposure, contrast, saturation, hue, temperature, tint, as the same clamped matrix steps in CSS, SVG and ffmpeg; presets at a strength), transform, fades; markers; times in ms on a frame grid set by `fps`; `parseVideoProject` names the first bad field) | `VideoProject`, `parseVideoProject`, `createVideoProject` (`/video-editor`) | Via core | Via core |
| Video Edits (add / move clips refusing, overwriting or inserting where they land, trim either edge within the source with ripple, split (left keeps the fade in and transition, right gets the fade out), delete with ripple, slip, roll and slide clamped to the media, lift / extract a range and cut across tracks, sync-locked tracks that ripple together (refused when a gap would close over one of their clips), close gaps, rate stretch that keeps the source range, transitions, tracks, assets, markers, settings; all or nothing, one undo step, never adds an error; errors say what is wrong and how to fix it, with the next free place, the furthest a trim can go and "did you mean") | `applyVideoEdits`, `VIDEO_EDIT_OPS` | Via core | Via core |
| Transitions & Frames (crossfade, wipe, push, slide and iris over the cut using both clips' handles, dip through a colour that needs none; sound through a transition at equal power by default (`audioCurve`); `videoFrameAt` gives the layers back to front with source time, opacity, placement and wipe, and the sounds with gain after volumes, fades and transitions; SVG frames with posters or labelled placeholders, contact sheets, canvas drawing) | `videoFrameAt`, `videoProjectSvg`, `videoContactSheetSvg`, `drawVideoFrame` | `<VideoPreview>` | `<VideoPreview>` |
| Video Keyframes (clip `opacity`, `volume` and `transform` x / y / scale / rotation as a number or `{ keys: [{ t, v, ease }] }` in clip time; linear, hold, ease-in / out / in-out or `[x1, y1, x2, y2]` cubic-bezier; split partitions keys exactly, trims and rate stretches keep keys on their frames; ffmpeg export as piecewise-linear expressions; inspector keyframe toggle and add-at-playhead) | `videoValueAt`, `splitVideoAnimatable`, `videoKeyframeRows`, `videoKeyframeToggleEdit` | `<ClipInspector>` | `<ClipInspector>` |
| Video Sound Levels (a min / max peak pyramid per asset, decoded once with Web Audio and cached (`VideoAudioPeaksCache`, injectable loader), exact range queries at any zoom, per-pixel spans, a clip's waveform through its in point, speed, volume and fades as an SVG path, peak dBFS levels, silence detection) | `buildVideoAudioPeaks`, `videoAudioPeakRange`, `videoClipWaveformPath`, `videoAudioLevels`, `findVideoAudioSilences`, `VideoAudioPeaksCache` | Waveforms in `<VideoTimeline>` | Waveforms in `<VideoTimeline>` |
| Video Text-Based Editing (asset transcripts timed in the source, read from Whisper JSON, SubRip or WebVTT; words mapped through clips, in points and speed onto the timeline; find phrases, filler words (longest first) and pauses between words; cut ranges out last first as one undo step; a transcript panel: click a word to go to it, Shift-click to select and delete a run, remove fillers, tighten pauses, load transcripts) | `parseVideoTranscript`, `videoTimelineTranscript`, `findVideoTranscriptText`, `findVideoFillers`, `findVideoTranscriptPauses`, `videoRemoveRangesEdits` | `<TranscriptPanel>` | `<TranscriptPanel>` |
| Video Nested Sequences (phase 1: `project.sequences` of `{ id, name, tracks }` played by compound clips (`type: 'sequence'`, `sequence`, `in`) at normal speed; clip ids unique across the project and its sequences; checks for a missing sequence, a sequence that contains itself and a compound past its sequence's end, with handles for transitions into a compound; `videoFrameAt` makes a compound one group layer holding its sequence's frame, to which its opacity, transform, blend, grade, LUT, fades, transitions and animations apply, and mixes its sequence's sound in through its volume and fades; the canvas preview draws the group on an offscreen canvas per nesting level, SVG as an isolated `<g>` with the group filter, and ffmpeg as a sub-graph on a transparent frame placed with the per-clip chain (checked pixel by pixel against the preview's evaluation, blended and graded, on a real ffmpeg); trims, splits and slips of a compound move its `in`; edits inside sequences come later) | `VideoSequence`, `VideoSequenceClip`, `videoSequenceDuration`, `findVideoSequenceCycle`, `videoFrameLeafLayers`, `list_video_sequences` | `<VideoTimeline>` compound label, `<ClipInspector>` sequence row | `<VideoTimeline>` compound label, `<ClipInspector>` sequence row |
| Video Frame Cache (optional and host-side: decoded source frames keyed by the file the preview plays and the source frame, so clips of one asset share them and edits never invalidate them; prefetch of the window ahead of the playhead (behind when scrubbing back), nearest first, a few at a time; a memory budget; eviction of the frames furthest from the playhead, counting frames behind it as further, never the prefetch window; the preview draws cached frames while paused, scrubbing or mid-seek and keeps the frames it shows; a browser decoder on hidden `<video>` elements; cached stretches drawn under the ruler) | `VideoFrameCache`, `planVideoPrefetch`, `videoCacheEvictions`, `createVideoElementDecoder` | `<VideoTimeline>` cached strip | `<VideoTimeline>` cached strip |
| Video Proxies (`VideoAsset.proxies` of `{ scale, src }`; a preview scale on the controller (`auto` by the canvas's shown size, `full`, or a fraction) picks the smallest proxy at least that large, switching elements as it changes; ffmpeg commands that make proxies: scaled to even sizes, H.264 with a short keyframe interval and no B-frames for cheap seeks, sound kept, `faststart`, checked with a real ffmpeg for size, keyframes and timing; the export, EDL and source times always use the original; preview-size control and proxy badges) | `videoProxyFfmpeg`, `videoProxyPlan`, `videoAssetProxy`, `controller.setPreviewScale` | `<VideoTransport>` preview size, `<MediaBin>` badge | `<VideoTransport>` preview size, `<MediaBin>` badge |
| Video LUTs (3D `.cube` files read with title, domain and input range and errors that give the line; tetrahedral interpolation that keeps greys on the grey axis; a grade's `lut` runs after its settings and mixes in at a `strength`; loaded once per `src` and shared (`VideoLutCache`, injectable loader); the canvas preview runs LUT layers through the table on the CPU; SVG frames approximate it with curves and a colour matrix; the export uses `lut3d` (split and blend at part strength), checked against a real ffmpeg; looks and copying grades keep it; inspector path, file and strength controls) | `parseVideoCubeLut`, `applyVideoLut`, `applyVideoLutToPixels`, `videoLutFromFunction`, `videoLutToCube`, `VideoLutCache`, `videoLutEdits` | `<ClipInspector>` LUT row | `<ClipInspector>` LUT row |
| Video Scopes (a histogram per channel and luma, a Rec. 709 luma waveform and a vectorscope with colour-bar targets and the skin-tone line, from RGBA pixels, sampled to a fixed cost; exposure figures (luma mean, median, percentiles), the share crushed or blown (and per channel), saturation, average colour and notes on what to fix; the preview publishes its pixels (`controller.previewPixels`), so a scopes panel and agents read the frame it draws, waiting until every picture has loaded) | `videoHistogram`, `videoLumaWaveform`, `videoVectorscope`, `videoExposureStats`, `summarizeVideoScopes`, `videoScopeImage`, `VideoPreviewPixels` | `<VideoScopes>`, `<VideoEditor showScopes>` | `<VideoScopes>`, `<VideoEditor showScopes>` |
| Video Checks (missing assets, wrong track kind, overlaps, clips past their source, transitions without a cut, too long or without handles, fades or entrance and exit animations longer than the clip, animations a clip's own keys override, keyframes outside their clip, unknown durations, unused assets, markers past the end) | `checkVideoProject`, `VIDEO_ISSUE_CODES` | Issue list in `<VideoEditor>` | Issue list in `<VideoEditor>` |
| Video Editor & Playback (undoable edits, playback on an injectable clock, frame stepping, clip selection, split at the playhead, (ripple) delete the selection, snapping to edges, markers and the playhead else to frames, read-only; a browser engine that keeps one `<video>` / `<audio>` element per playing clip in step with the timeline and draws frames on a canvas) | `VideoEditorController`, `VideoPreviewEngine` | `useVideoEditor` & `<VideoEditor>` | `createVideoEditor` & `<VideoEditor>` |
| Video Timeline & Panels (ruler with timecode and markers, scrubbing, track headers with mute / hide / lock, clips drawn by kind with transition badges and waveforms (audio clips by default, `waveforms` prop), click and shift-click selection, drag to move across tracks with snapping, drag edges to trim (Alt to ripple), drag to insert (Alt) or overwrite (Shift), keyboard: Space, arrows, S, Delete, undo / redo; transport; clip inspector; media bin with file drop, probing and add-by-URL) | `videoRulerTicks`, `videoClipWaveformPath`, `planVideoClipDrag`, `videoDropTracks`, `videoAssetDropEdit`, `probeVideoMedia` | `<VideoTimeline>`, `<VideoTransport>`, `<ClipInspector>`, `<MediaBin>` | `<VideoTimeline>`, `<VideoTransport>`, `<ClipInspector>`, `<MediaBin>` |
| Video Export (an ffmpeg command, checked by rendering with a real ffmpeg: inputs trimmed to what each clip plays plus transition handles, scaled and placed as the preview places them, faded, overlaid in track order, titles with `drawtext` or, for ffmpeg builds without it, as images (`titleImage`, `videoTitleFrame`), wipes with `geq`, blend modes composited through the layer's alpha (checked pixel by pixel against the CSS formulas), grades as `lutrgb` / `colorchannelmixer` steps (checked against `applyVideoGrade`), speed ramps re-timed with `setpts` and `fps` and their sound in stepped `atempo` pieces (checked frame by frame on a real render), sound delayed, faded and mixed; loudness normalisation (EBU R128 `loudnorm`, one pass or a measuring pass then a linear second pass, checked against a real ffmpeg); a CMX 3600 EDL with dissolves, wipes, `M2` speed lines and clip names, in drop-frame timecode at 29.97 and 59.94 fps) | `toVideoFfmpeg`, `toVideoLoudnessMeasure`, `parseVideoLoudnessMeasurement`, `toVideoEdl`, `videoTitleFrame` | Via core | Via core |
| Video Agent Tools (59 tools: read the project and its nested sequences, what plays at a moment, gaps, check, sound levels and silences of a clip or asset, colour scopes of the rendered frame, transcripts (attach, read, find text, fillers and pauses, cut ranges), render a frame or contact sheet (SVG or PNG), export ffmpeg (with loudness normalisation), a loudness measuring pass or EDL, seek to a time, clip or marker; plan proxy files, attach proxies and set the preview size; read the preview's frame cache; settings, add / change / remove media, add / change / remove / reorder tracks, add / move (refuse, overwrite or insert) / trim / split / delete / change clips, slip / roll / slide, speed ramps and freeze frames, lift / extract a range, cut across tracks, sync lock, transitions, keyframes (set / remove per property), colour looks, LUTs (set / remove) and copying grades between shots, close gaps, markers, batched edits with dry run, undo / redo) | `createVideoEditorToolProvider` | `useVideoEditorTools` | `useVideoEditorTools` |

</details>

<details>
<summary><strong>Chart editor</strong> (18)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Chart Spec (bar, line, area, scatter, pie, donut; per-series types for combos; stacking none / stacked / 100%; horizontal bars; linear / smooth / step curves; points, data labels, palette, donut hole) with sentence validation | `ChartSpec`, `normalizeChartSpec` & `createChartSpec` (`/chart`) | `<ChartCanvas>` | `<ChartCanvas>` |
| DOM-free Chart Layout (nice ticks, rotated / thinned category labels, wrapped legends on any side, axis titles, gaps for blank values, monotone smooth curves, selection outlines, pluggable text measuring and themes) | `layoutChart` → `ChartScene` of rects, paths, circles, lines and text with click targets | `<ChartCanvas>` (follows its container's width) | `<ChartCanvas>` (follows its container's width) |
| Chart Controller (stable `getState`, `subscribe`, all-or-nothing `update`, selection, `toJSON` / `load`, shared or own `HistoryManager`) | `ChartController` | `useChartEditor`, `useChartController` & `useChartState` | `createChartEditor` |
| Chart Interaction (click to select title, axes, legend, series, points and categories; drag bars and points to new values as one undo step, stacked bars too; ← → ↑ ↓, Delete, Escape) | `startChartPointDrag`, `handleChartKey`, `chartValueAtPoint` & `describeChartSelection` | `<ChartCanvas>` | `<ChartCanvas>` |
| Chart Data Grid (rename, recolour, hide, add and delete series and categories; numbers as typed — `1,200`, `12%`, `(3)`, blank for a gap; TSV / CSV paste grows the grid) | `setValue`, `pasteCells`, `addSeries`, `addCategory`, `parseChartValue` | `<ChartDataGrid>` | `<ChartDataGrid>` |
| Chart Inspector (type, titles, stacking, orientation, curve, points, data labels, legend, axes with fixed bounds, grid lines and number formats, selected series colour / type / order) | `update`, `setAxis`, `setLegend`, `updateSeries`, `moveSeries` | `<ChartInspector>` & `<ChartEditor>` | `<ChartInspector>` & `<ChartEditor>` |
| Chart Data Import / Export (tables with series in columns or rows, CSV / TSV, colours kept by series name) and SVG Export | `chartDataFromTable`, `chartDataToTable`, `importCsv`, `chartToSvg` & `chartSceneToSvg` | Via core | Via core |
| Chart Commands (`chart.describe`, `update`, `setData`, `setValues` by series and category name, `addSeries`, `addTrendline`, `applyPreset`, `transpose`, `importCsv`, `importMermaid`, `exportSvg`, `exportMermaid`, `exportOoxml`, `recommend`, `checkColors`, …) | `createChartCommands` | `useChartCommands` | `useChartCommands` |
| Chart Agent Tools (28 tools, one per operation: read, render, check colours, recommend, trendline fits, presets, Mermaid / Office import and export, data and series edits, pointer drags and keys through the real interaction code; write tools hidden while read-only) | `createChartToolProvider` | `useChartToolProvider` | `useChartToolProvider` |
| Chart PNG Previews & Download (CSS-variable paints resolved before drawing, 2× with the longest side ≤ 1024 px; `render_chart { format: "png" }` returns the image with the layout warnings; Download PNG in the editor toolbar) | `rasterizeChartSvg`, `resolveChartSvgPaints`, `createChartRasterizer` & `downloadChartPng` | `useChartToolProvider` (rasterizes by default) & `<ChartEditor>` | `useChartToolProvider` (rasterizes by default) & `<ChartEditor>` |
| More Chart Types (bubble, radar, waterfall with totals and connectors, histogram with √n bins, box & whisker with Tukey fences, funnel, squarified treemap) | `layoutChart` families, `chartHistogram`, `chartBoxStats`, `chartSquarify` | `<ChartCanvas>` | `<ChartCanvas>` |
| Secondary Axis, Numeric-X Scatter, Date Axes & Bar Spacing (`yAxis2`, `series.axis`, `series.x` / `sizes`, `xAxis.kind: "date"` with calendar label steps, `gapWidth` / `overlap`, fixed tick `step`) | `ChartSpec`, `chartDateLabels` | `<ChartInspector>` | `<ChartInspector>` |
| Trendlines (linear, exponential, logarithmic, power, polynomial 2–6, moving average; forecast, fixed intercept, equation and R² labels) | `fitChartTrendline`, `addTrendline`, `trendlineFit` | `<ChartInspector>` | `<ChartInspector>` |
| Error Bars & Axis Scales (per-series fixed / percent / standard deviation / standard error / custom error bars, x error bars on scatter; logarithmic value and scatter-x axes with power ticks; reversed value and category axes; Office `c:errBars`, `c:logBase`, `maxMin`; agent tools via `update_chart` / `update_chart_series`) | `series.errorBars`, `axis.scale` / `logBase` / `reverse`, `chartErrorAmounts`, `niceLogScale`, `chartScaleToPixel` | `<ChartInspector>` | `<ChartInspector>` |
| Chart Formats, Markers, Labels & Colours (spreadsheet format codes, marker shapes, per-point colours, label position with fit checks and contrast, quick layouts and colour schemes, shaded palette cycling, colour-blind check) | `formatChartNumber`, `CHART_LAYOUT_PRESETS`, `CHART_COLOR_SCHEMES`, `checkChartColors` | `<ChartInspector>` | `<ChartInspector>` |
| Chart Text Formats (Mermaid `xychart-beta` / `pie` / `radar-beta` round trip with a `%% @pixerate` comment; Office `c:chartSpace` and chartex read / write; charts in DOCX imports, as `chart` nodes in documents, and in DOCX exports as native Word charts) | `chartToMermaid`, `chartFromMermaid`, `findMermaidCharts`, `chartFromOoxml`, `chartToOoxml` | Via core | Via core |
| Charts in Office Files (every chart in an `.xlsx` with sheet and anchor cell, `.pptx` with slide number, or `.docx`; DrawingML and chartex; `list_open_files`, `list_file_charts`, `get_file_chart`, `load_file_chart` agent tools) | `extractOfficeCharts`, `extractXlsxCharts`, `extractPptxCharts`, `createOfficeChartToolProvider` | `useOfficeChartToolProvider` | `useOfficeChartToolProvider` |
| Chart Streaming, Presence & Sparklines (lenient partial Mermaid / JSON, steady axes, tweened scenes; agent cursors that act out edits as one undo step; word-sized line / column / win-loss charts) | `ChartStream`, `blendChartScenes`, `ChartDirector`, `ChartPresence`, `layoutSparkline` | `<ChartStreamingView>`, `useChartDirector`, `<ChartSparkline>` | `<ChartStreamingView>`, `createChartDirector`, `<ChartSparkline>` |
| Chart Summaries & Accessibility (per-series min / max / mean / trend, layout warnings, plain-language description, SVG `<title>` and `<desc>`, recommendations from table shape) | `summarizeChart`, `describeChart`, `recommendChartTypes`, `chartFromTable` | Via core | Via core |

</details>

<details>
<summary><strong>Image editor</strong> (17)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Image Editor Canvas 2D Engine & Transformations | ✅ | Component & Hook | Component & Rune |
| Image Filters & Adjustments | ✅ | ✅ | ✅ |
| Image White Balance (Temperature / Tint, eyedropper) & Process Versions | ✅ | ✅ | ✅ |
| Image Adjustment Layers (Curves, Levels, Hue/Saturation, Vibrance, Color Balance, B&W, Photo Filter, …) | ✅ | `<AdjustmentLayersPanel>` & `<CurvesEditor>` | `<AdjustmentLayersPanel>` & `<CurvesEditor>` |
| Photoshop Blend Modes (layers & annotations), plus a `pigment` mode that mixes like paint (Kubelka-Munk, blue + yellow = green; layers, groups, adjustment layers, brush and fill; written to PSD as Normal with a warning) and four painterly modes of our own: `watercolor` (washes multiply per wavelength, so blue glazes yellow green), `tint` (colour on the backdrop's Oklab lightness), `highlight` (soft-shouldered coloured light) and `shadow` (shading with ambient fill); the paint editor writes them to PSD as the nearest standard mode with a warning | `blendPixel`, `mixPigmentRgb`, `BLEND_MODES`, `PAINTERLY_BLEND_MODES` & `standardBlendMode` | ✅ (layer blend menus; Standard / Paint groups in `<PaintLayersPanel>`) | ✅ (layer blend menus; Standard / Paint groups in `<PaintLayersPanel>`) |
| Image Histogram | `computeHistogram` | `<Histogram>` & `useImageHistogram` | `<Histogram>` & `createImageHistogram` |
| Image Adjustment Control Table & Agent Tools (adjustments, layers: add / change / reorder / remove, crop, rotation, flip, histogram, undo / redo, selections and masks) | `IMAGE_ADJUSTMENT_CONTROLS` & `createImageEditorToolProvider` | `<ControlSlider>` | `<ControlSlider>` |
| Image Layer Stack (tiled copy-on-write surfaces; pixel, adjustment, group and annotation layers with masks, clipping, blend modes, opacity and fill; per-tile compositor with prefix caches and dirty rectangles; immutable undo history with `maxHistoryBytes`; schema v3 with PNG layer assets, v1 / v2 documents rendered and written exactly as before; `list_layers` agent tool) | `LayerCompositor`, `TiledSurface`, `migrateToLayeredState`, `getLayers` | Via core (`useImageEditor` state) | Via core (`createReactiveImageEditor` state) |
| Image Layers Panel & Layer Operations (new / duplicate / delete / reorder and nest by drag, groups with pass-through, merge down / visible, flatten, layer via copy / cut, masks from reveal-all / hide-all / selection with apply, delete and disable, clipping, locks, opacity, fill, blend, develop and blur layer filters, offsets, thumbnails; 22 layer agent tools) | `addPixelLayer`, `mergeDown`, `layerPanelRows`, `runLayerMenuAction` & layer tools in `createImageEditorToolProvider` | `<LayersPanel>` (Layers tab in `<ImageEditor>`) | `<LayersPanel>` (Layers tab in `<ImageEditor>`) |
| Image Painting (Brush and Eraser with size, hardness, angle, roundness, spacing, opacity vs flow build-up, smoothing and pen pressure; mask painting; Edit › Fill / Clear; Move tool; selection-limited and transparency-locked painting; live tile previews, one undo step per stroke; shortcuts B / E / V, [ ], Shift+[ ], 0–9, D, X; `paint_stroke`, `fill_pixels`, `clear_pixels` agent tools) | `beginStroke`, `paintStroke`, `fillPixels`, `PaintGesture`, `handlePaintShortcut` | `<BrushOptionsBar>` (Paint tab in `<ImageEditor>`) | `<BrushOptionsBar>` (Paint tab in `<ImageEditor>`) |
| Mixer Brush (a reservoir loaded with paint plus a pickup well that takes up the layer's colour under each dab; wet, load, mix, load / clean after each stroke; RGB or Pigment mixing, so blue dragged through yellow goes green; selection-limited and transparency-locked; one undo step per stroke, deterministic replays; shortcut Shift+B; `paint_stroke` `tool: "mixer"`, `get_mixer_brush`, `load_mixer_brush`, `clean_mixer_brush` agent tools) | `MixerStroke`, `normalizeMixer`, `loadMixer`, `cleanMixer` (`/paint`) & `beginStroke({ tool: 'mixer' })`, `loadMixerBrush`, `cleanMixerBrush`, `setPaintOptions({ mixer })` | `<BrushOptionsBar>` Mixer tool with Wet / Load / Mix, Load / Clean, RGB / Pigment toggle | `<BrushOptionsBar>` Mixer tool with Wet / Load / Mix, Load / Clean, RGB / Pigment toggle |
| Pigment Colour Mixing (blue + yellow gives green, white gives tints: sRGB lifted to smooth 36-band reflectance spectra, Kubelka-Munk mixing with tinting strength, back to sRGB; deterministic, allocation-free per-dab path; read-only `mix_colors` agent tool returning the mix and the RGB average) | `mixPigments`, `lerpPigment`, `createPigment`, `lerpPigmentInto`, `rgbToReflectance` (`/paint`) & `mix_colors` in `createImageEditorToolProvider` | `mix_colors` via the image editor's tool provider; on the canvas through the Mixer Brush's Pigment toggle | `mix_colors` via the image editor's tool provider; on the canvas through the Mixer Brush's Pigment toggle |
| Image Layer Integrations (AI inpainting into a new layer and background removal as a layer mask in multi-layer documents, `target: 'new-layer' \| 'replace'`; Rasterize Layer for annotation layers and filtered pixel layers; selection sampling from all layers or the active layer; v3 layer assets in an external asset store with `toJSON({ assets: 'external', store })` / `loadJSONAsync`; `rasterize_layer` and `select_by_color { sample }` agent tools) | `applyInpaintedImage`, `rasterizeLayer`, `ImageEditorAssetStore` | AI tab result target & `<SelectionOptionsBar>` sample | AI tab result target & `<SelectionOptionsBar>` sample |
| Image Layer Effects (drop and inner shadow, outer and inner glow with colour or gradient, bevel & emboss in five styles and three techniques with gloss contour, Contour and Texture elements, satin, colour / gradient / pattern overlay, stroke outside / inside / centre in colour, gradient or pattern; each with its own enabled flag, blend, opacity and contour; master switch, Scale Effects and a document global light; fill opacity leaves effects alone; rendered in the per-tile compositor between a layer's content and its blend, from maps built once per layer region, so tiles equal a whole-image render; dirty rects and tile signatures grow by each effect's reach; on pixel, annotation and group layers, clipped layers too; built-in patterns; `list_layer_effects`, `add_layer_effect`, `update_layer_effect`, `remove_layer_effect`, `set_layer_effects_enabled`, `set_global_light` agent tools; an effects section in the layers panel with an fx badge per layer, the effect list with toggles and every setting) | `addLayerEffect`, `compositeLayerEffects`, `layerEffectControls`, `LayerEffects` (`/raster`) | `<LayerEffectsPanel>` (in `<LayersPanel>`) | `<LayerEffectsPanel>` (in `<LayersPanel>`) |
| Image Free Transform (an overlay with eight handles and a movable reference point, Photoshop's modifiers and an options bar with mode switch, X / Y, W / H %, angle, skews, interpolation, commit and cancel; a Warp mode that draws the mesh with its handles, drags anchors and handles or pulls inside, with the fifteen presets, bend, distortions, orientation and a 1 × 1 / 3 × 3 / 5 × 5 grid in the bar; scale free or proportional, rotate about a reference point, skew, distort, perspective and warp by preset or Bézier mesh, flip and quarter turns; of a pixel layer with its linked mask, an unlinked mask alone, the selected pixels as a floating piece committed back, a Layer via Copy, or just the selection outline; live previews sampled in blocks from a reduced copy, then one undo step resampled tile by tile into new copy-on-write surfaces with nearest, bilinear or Photoshop's Bicubic, premultiplied at transparent edges, pre-filtered when shrinking, front side only past the horizon; mask link flag (PSD mask flag bit 0); effects follow the transformed pixels and PSD export writes them; `get_transform_frame`, `transform_layer`, `warp_layer`, `transform_selection`, `flip_layer`, `rotate_layer_90` agent tools; homographies and warp meshes shared with the vector editor in `src/geom`) | `beginFreeTransform`, `transformLayer`, `transformSurface`, `warpSurface`, `FreeTransformTool` (overlay, handles, Photoshop modifiers, options bar model) | `<FreeTransformOptionsBar>` and the canvas overlay in `<ImageEditor>` (Ctrl/Cmd+T, Free Transform / Transform Selection buttons; mask link chain in `<LayersPanel>`) | `<FreeTransformOptionsBar>` and the canvas overlay in `<ImageEditor>` (Ctrl/Cmd+T, Free Transform / Transform Selection buttons; mask link chain in `<LayersPanel>`) |
| Image Shape Layers (vector components with a fill and a stroke: live rectangles with per-corner radii, ellipses, polygons, stars and lines with arrowheads, free paths from anchors or SVG path data; Photoshop's path operations combine, subtract, intersect and exclude, and Merge Shape Components; fill and stroke in colour, gradient or pattern with opacity; stroke width, inside / centre / outside alignment, caps, joins, miter limit and dashes; rendered without a canvas into the layer's tiles by an exact-area rasterizer on every change, so moves and Free Transform map the paths (live shapes stay live under affine maps) and never degrade; masks, clipping, blend modes, fill opacity and layer effects as on pixel layers; rasterize to pixels; v3 JSON keeps the vectors; pen, rectangle, ellipse, line and arrow annotations load as shape layers that render as before and stay editable through the annotation API; `get_shape_layer`, `add_shape_layer`, `update_shape`, `set_shape_component`, `add_shape_component`, `remove_shape_component`, `merge_shape_components` agent tools) | `addShapeLayer`, `setShapeStyle`, `setShapeComponent`, `renderShape`, `createShapeLayer`, `ShapeDrawGesture` | `<ShapeOptionsBar>` and the Shape tool in `<ImageEditor>` (drag to draw, Shift / Alt); shape thumbnails with a badge in `<LayersPanel>` | `<ShapeOptionsBar>` and the Shape tool in `<ImageEditor>` (drag to draw, Shift / Alt); shape thumbnails with a badge in `<LayersPanel>` |
| Image Type Layers (live point and paragraph text with per-run font family, weight, italic, size, colour, opacity, tracking, leading, baseline shift, underline and strike-through, and per-paragraph alignment (justify included), auto leading, indents and spacing; our own layout (line breaking, kerning from the shaper) over a pluggable `TextShaper`: the browser's fonts through Canvas 2D by default, or glyph outlines from fonts you load (`createOutlineTextShaper`, works without a DOM); missing fonts fall back with a warning; scale, rotate, skew and move through the text matrix; masks, effects, clipping and blend modes; Convert to Shape and rasterize; text annotations load as type layers drawn the same way; `list_fonts`, `get_text_layer`, `add_text_layer`, `set_text`, `set_text_style`, `set_paragraph_style`, `set_text_frame`, `convert_text_to_shape` agent tools) | `addTextLayer`, `setText`, `setTextStyle`, `setParagraphStyle`, `layoutText`, `createCanvasTextShaper`, `createOutlineTextShaper`, `TypeToolGesture`, `TextEditSession` | `<TypeOptionsBar>` and the Type tool in `<ImageEditor>` (click for point text, drag for a box, click text to edit it on the canvas: caret, selection, keys, IME); type thumbnails and a missing-font warning in `<LayersPanel>` | `<TypeOptionsBar>` and the Type tool in `<ImageEditor>` (click for point text, drag for a box, click text to edit it on the canvas: caret, selection, keys, IME); type thumbnails and a missing-font warning in `<LayersPanel>` |
| High Bit Depth (16-bit and 32-bit float layers alongside the 8-bit path: tiles carry 16-bit sRGB or 32-bit linear-light samples next to their 8-bit rendering, so every 8-bit consumer stays unchanged and fast; a document bit depth (Image › Mode 8 / 16 / 32) with lossless conversion up and rounding down, as one undo step; 16- and 32-bit PSD open and save without downconverting (Lr16 / Lr32, ZIP with prediction for float); a float compositor for the deep path (blend modes in sRGB at 16 bits and linear light at 32, masks, clipping, groups, adjustment layers in float) used by merges, `compositeDeepPixels` and the PSD merged image; v3 JSON keeps the deep samples; memory and speed benchmark; `set_bit_depth` agent tool and `bitDepth` in `get_image_info`) | `deepTile`, `readDeepRegion`, `writeDeepRegion`, `convertSurfaceDepth`, `surfaceFromDeepPixels`, `DeepCompositor` (`/raster`) & `setBitDepth`, `bitDepth`, `compositeDeepPixels` | `<LayersPanel>` Bits per channel menu | `<LayersPanel>` Bits per channel menu |
| Photoshop PSD / PSB (open: pixel, group and adjustment layers for our ten kinds, user masks with density and feather, 26 blend modes, opacity, fill, clipping, visibility and locks, layer effects (`lfx2` / `lfxs` / `lmfx`, legacy `lrFX`) with embedded patterns and the global light, each approximation a warning; shape layers as live shapes (`vsms` / `vmsk` paths with path operations, `vscg` fill, `vstk` stroke, `vogk` live shapes), type layers as live text (`TySh` with its EngineData; Photoshop's pixels kept until edited, missing fonts warned), fill layers as their stored pixels, CMYK, Lab, grayscale and indexed converted to RGB (16- and 32-bit files keep their depth), each loss a warning naming the layers; export: RGB PSD at the document's 8, 16 or 32 bits, PSB above 30 000 px, RLE, filters and depth masks baked, shape and type layers as Photoshop shape and type layers (blocks read written back byte for byte while unchanged), effects as `lfx2` (the block read written back byte for byte while unchanged) with the patterns they use; `inspect_psd`, `import_psd`, `export_psd` agent tools) | `loadPsd`, `toPsd`, `importPsd`, `exportPsd`, `readPsd` | `<LayersPanel>` Open PSD… / Export PSD | `<LayersPanel>` Open PSD… / Export PSD |
| Image Selections & Masks (magic wand, colour range, marquees, lasso, modes, grow/shrink/feather/border/smooth, guided-filter Refine Edge, Quick Mask, adjustment layer masks, RLE in the document, agent tools) | `SelectionGesture`, `magicWand`, `refineSelection`, `layerMaskFromSelection` | `<SelectionOptionsBar>` & `<RefineEdgePanel>` | `<SelectionOptionsBar>` & `<RefineEdgePanel>` |
| Vector Annotations (Pen, Rect, Circle, Arrow, Line, Text) | ✅ | ✅ | ✅ |
| Gleamforge Depth & Alpha Masking | ✅ | ✅ | ✅ |

</details>

<details>
<summary><strong>Paint editor</strong> (13)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Paint Editor Controller (canvas size and dpi, the shared layer stack with pixel layers and groups, one undo step per stroke or change, live stroke sessions on copy-on-write tiles, rendering through the shared compositor with the paper as its bottom layer) | `PaintEditorController`, `beginStroke`, `paintStroke`, `compositeTiles` | `<PaintEditor>`, `<PaintCanvas>` & `usePaintEditor` | `<PaintEditor>`, `<PaintCanvas>` & `createReactivePaintEditor` |
| Paper (generated grain height maps in eleven patterns, seed, scale, repeat or mirror tiling, colour and shading, grain depth, dry and wet tuning, absorption / permeability / roughness for later wet media; a library of twelve papers in six families; `list_papers`, `get_paper`, `set_paper` agent tools) | `PAPER_LIBRARY`, `PaperGrain`, `grainCatch`, `setPaper` | `<PaperPanel>` | `<PaperPanel>` |
| Dry Media Brushes (pencil, pastel, charcoal, airbrush, marker, ink pen, brush pen, erasers, blender, smudge, Mixer Brush on the shared engine; paper grain response that catches the peaks at light pressure; pressure, tilt, barrel rotation and velocity dynamics; separate position and pressure smoothing; fixed / follow-stroke / barrel rotation; seeded jitter that replays exactly; `paint_stroke` agent tool) | `BUILTIN_BRUSHES`, `PenDabWalker`, `DryStroke`, `PenSmoother` | `<BrushPanel>` & `<PaintCanvas>` (coalesced and predicted events, palm rejection) | `<BrushPanel>` & `<PaintCanvas>` (coalesced and predicted events, palm rejection) |
| Blending Tools & Brush Behaviours (a blender that mixes the colours under and near the tip through the pigment model, with strength and blend distance; a smudge that drags a patch of paint, with strength, length and RGB or pigment mixing; the Mixer Brush with full pen input and paper grain; pick-up and mix ratios for every wet-capable brush on the shared pick-up / mix exchange that wet media will reuse; dirty brushes that carry the last colour they touched; multi-coloured brushes with colours across the tip or per dab, in sequence or at random; recorded loads so pick-up strokes replay exactly; presets Blender, Smudge, Pigment smudge, Dirty round, Multi-colour flat, Palette dabber; `set_brush` `behavior` / `blender` / `smudge`, `get_mixer_brush`, `clean_mixer_brush`, `mix_colors` `model`) | `PaintExchange`, `TileMedium`, `blenderDab`, `SmudgeTip` (`/paint`) & `PaintDabStroke`, `brushEngineControls` | `<BrushPanel>` engine section (strength, blend distance, length, pick-up, mix, load, Pigment / RGB, dirty brush, multi-colour colours / order / softness, Load / Clean) and brush blend menu | `<BrushPanel>` engine section (strength, blend distance, length, pick-up, mix, load, Pigment / RGB, dirty brush, multi-colour colours / order / softness, Load / Clean) and brush blend menu |
| Brush Library (built-in presets, user brushes, save / remove, JSON import / export, thumbnails rendered from a test stroke on the current paper; `list_brushes`, `get_brush`, `set_brush`, `save_brush`, `remove_brush`, `export_brushes`, `import_brushes`, `render_brush_thumbnail` agent tools) | `setBrush`, `saveBrush`, `importBrushes`, `exportBrushes`, `renderBrushThumbnail` | `<BrushPanel>` | `<BrushPanel>` |
| Strokes as Data (every stroke recorded with brush, colour, raw pen samples, seed and symmetry copies; replay exactly or moved, scaled, rotated, flipped, recoloured, with another brush or layer, repeated, as one undo step; `list_strokes`, `replay_strokes` agent tools) | `getStrokes`, `replayStrokes`, `varyStroke` | Via core (`replayStrokes`); `useAgentToolProvider` | Via core (`replayStrokes`); `useAgentToolProvider` |
| Paint Layers & Fills (add, group, reorder, duplicate, merge down, remove; opacity, blend (pigment and the painterly watercolor, tint, highlight and shadow included), clipping, locks; flat or grain-following fills; clear; colour pick; `list_layers`, `add_layer`, `update_layer`, `list_blend_modes`, `set_active_layer`, `move_layer`, `duplicate_layer`, `merge_layer_down`, `remove_layer`, `fill_layer`, `clear_layer`, `pick_color` agent tools) | `addLayer`, `updateLayer`, `fillLayer`, `mergeDown`, `pickColor` | `<PaintLayersPanel>` (eyedropper in `<PaintCanvas>`) | `<PaintLayersPanel>` (eyedropper in `<PaintCanvas>`) |
| Paint View & Pen Input (zoom, pan, rotation and mirroring as view state only, pen azimuth and twist turned with the view; Pointer Events to pen samples with tilt, altitude / azimuth and twist, mouse pressure fix; palm rejection by drawing hand; `set_view`, `set_hand` agent tools) | `viewMatrix`, `screenToDocument`, `pointerToPenPoint`, `isPalmTouch` | `<PaintCanvas>` & `<PaintToolbar>` (R, M, Esc, wheel, Shift+wheel) | `<PaintCanvas>` & `<PaintToolbar>` (R, M, Esc, wheel, Shift+wheel) |
| Painting Guides: Symmetry (vertical, horizontal, diagonal and dual mirrors and n-segment kaleidoscopes with mirrored segments, about a movable, rotatable centre; every stroke paints its copies as one stroke and one undo step, recorded with the stroke so replays keep them; axes clipped to the canvas for drawing; `set_symmetry`, `get_guides` agent tools) | `setSymmetry`, `symmetryCopies`, `symmetryAxisSegments` | `<PaintToolbar>` & guide overlay in `<PaintCanvas>` | `<PaintToolbar>` & guide overlay in `<PaintCanvas>` |
| Perspective Guides (one to three vanishing points; pen strokes pick the guide line through their start that best fits their direction and snap to it, one-point keeping horizontals and verticals and two-point verticals; guide fans for drawing; `set_perspective_guide`, `paint_stroke` `snapToPerspective` agent tools) | `setPerspective`, `PerspectiveSnapper`, `perspectiveGuideLines` | `<PaintToolbar>` & guide overlay in `<PaintCanvas>` | `<PaintToolbar>` & guide overlay in `<PaintCanvas>` |
| Tracing & Reference Images, Colour Harmonies, Swatches & Mixing Pad (a tracing image under the paint in the view only, at an opacity, optionally the source of stroke colours; floating reference images to pick from; harmonies on the painter's RYB wheel or the RGB wheel; swatches saved with the document; a mixing pad painted with a pigment Mixer Brush and smeared with a pigment palette knife, picked with a sample size, measured mixes in parts with a fully mixed core, pads kept by name and saved with the document; `set_tracing_image`, `update_tracing_image`, `clear_tracing_image`, `add_reference_image`, `list_reference_images`, `update_reference_image`, `remove_reference_image`, `pick_reference_color`, `color_harmony`, `list_swatches`, `add_swatch`, `remove_swatch`, `mixing_pad_stroke`, `pick_mixing_pad_color`, `clear_mixing_pad`, `render_mixing_pad`, `mix_on_pad`, `save_mixing_pad`, `list_mixing_pads`, `load_mixing_pad`, `remove_mixing_pad` agent tools) | `setTracingImage`, `addReferenceImage`, `colorHarmony`, `MixingPad`, `mixOnPad`, `saveMixingPad` | `<ColorPanel>` (pad sample size, Mix in parts, Keep pad), `<PaintToolbar>` (tracing, references) & floating references in `<PaintCanvas>` | `<ColorPanel>` (pad sample size, Mix in parts, Keep pad), `<PaintToolbar>` (tracing, references) & floating references in `<PaintCanvas>` |
| Paint Documents & Export (JSON with PNG layer assets through the image editor's layer serializer, external asset stores, unknown fields kept for later phases; PNG in pure TypeScript, JPEG / WebP through a canvas or a host encoder, PSD through the shared PSD writer with the paper as a locked layer; `render_preview`, `export_image`, `export_psd`, `save_document`, `open_document`, `new_canvas`, `set_canvas`, `undo_paint`, `redo_paint` agent tools) | `toJSON`, `loadJSON`, `exportPng`, `exportImage`, `exportPsd` | `<PaintToolbar>` Save / Open / PNG / JPEG / PSD | `<PaintToolbar>` Save / Open / PNG / JPEG / PSD |
| Paint Agent Cursors (an agent's strokes painted live by its cursor on the canvas, paced by the points' times, as one undo step; fills rubbed across the sheet, replays starting from the strokes they copy; cursors placed through the view's zoom, rotation and mirroring; `paint_stroke`, `fill_layer` and `replay_strokes` act out through a `director`) | `PaintDirector`, `PaintPresence` & `createPaintEditorToolProvider({ director })` | `usePaintDirector` & `<PaintEditor presence>` / `<PaintCanvas presence>` | `createPaintDirector` & `<PaintEditor presence>` / `<PaintCanvas presence>` |

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
<summary><strong>Commands and agent tools</strong> (13)</summary>

| Feature | Core | React | Svelte |
| :--- | :---: | :---: | :---: |
| Dynamic Agent Tool Registry (MCP `tools/list` / `tools/call`, `listChanged`) | `ToolRegistry` | `useAgentToolProvider` | `useAgentToolProvider` |
| Command Registry (enablement with reasons, strict params, structured results) | `CommandRegistry` (`/commands`) | `useRegisterCommands` | `useRegisterCommands` |
| Shortcuts as Data (`Mod`, scopes, user overrides, per-platform conflict audit) | `ShortcutMap` & `formatShortcut` | `useCommandShortcuts` | `createCommandShortcuts` |
| Command Palette (fuzzy ranking, recents, shortcuts, disabled reasons) | `rankCommands` & `createCommandPaletteController` | `<CommandPalette>` & `useCommandPalette` | `<CommandPalette>` & `createCommandPalette` |
| Commands as Agent Tools (`list_commands`, `run_command`, `run_commands`) | `createCommandToolProvider` | Via core | Via core |
| MCP Server over any transport (`initialize`, `tools/list`, `tools/call`, cancellation, `list_changed`) | `createMcpServer` (`/tools`) | Via core | Via core |
| MCP Bridge to Live Editors (one Node MCP process, stdio, drives pages over a localhost WebSocket: origin allowlist, token, `editor` routing and `list_editors`, cancellation, timeouts, reconnect; `pixerate-mcp-bridge` CLI; no dependencies) | `createToolBridge` (`/bridge`, Node) & `connectToolBridge` (`/tools`) | `useToolBridge` | `useToolBridge` |
| Rich-Text Agent Tools (`find_text`, `replace_text`, `replace_range`, `set_selection`, positions via `get_text {blocks}`) | `createRichTextToolProvider` | Via core & `useAgentToolProvider` | Via core & `useAgentToolProvider` |
| Inline Agent Carets in Text (a named caret, selection and changed-text tint drawn as decorations where the rich-text tools read and write, as collaborators' carets look in Google Docs; optional typing playback that stays one undo step and rolls back if cancelled; `presence` option, on by default) | `AgentCaret`, `setAgentCaret`, `typeAgentText` & `createRichTextToolProvider({ presence })` | Via core & `useAgentToolProvider` | Via core & `useAgentToolProvider` |
| Canvas & Prompt Agent Tools (one strict tool per operation, created ids returned, ids checked against the snapshot) | `createEditorMcpToolProvider` & `validateAgentCommand` | Via core & `useAgentToolProvider` | Via core & `useAgentToolProvider` |
| Spreadsheet Agent Tools (`get_range` with merges, `set_cell`, `set_range`, insert/delete rows and columns, `merge_cells`, `unmerge_cells`, `transpose_range` on a range) | `createSpreadsheetToolProvider` | Via core & `useAgentToolProvider` | Via core & `useAgentToolProvider` |
| Screenshot Capture for Agents (`capture_view`: viewport, content, selection, canvas nodes by id or a rect, PNG or JPEG, with the rect and scale to map image pixels back; overlays such as selection boxes and agent cursors left out unless asked; canvas, image editor and any DOM element) | `createCaptureTool`, `createElementCaptureSurface` (`/tools`), `createCanvasCaptureToolProvider` (`/canvas`), `capture_view` in `createImageEditorToolProvider` | `useCanvasCapture` | `createCanvasCapture` |
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
| Generation Records & Recreate (template/model/asset hashes, `exact` / `latest`, drift report, variations, record store with filter / prune; agent tools `list_generations`, `get_generation`, `recreate_generation`, `vary_generation`) | `createGenerationRecord`, `recreateRequest`, `variationRequest`, `createGenerationRecordStore`, `createGenerationHistoryToolProvider` | `<GenerationHistory>` & `useGenerationRecords` | `<GenerationHistory>` & `createGenerationRecords` |

</details>

¹ Svelte doesn't have a prompt-editor equivalent of React's `usePromptEditor` yet. Configure the core extensions (`GradientText`, `TemplateSuggestions`, `SlashCommands`) and pass them to `EditableTextNodeEditor` via `extensions`, or use `createEditor({ plainTextMode: true })` from `@pixerate/editor`.

## Documentation

- [Architecture](docs/architecture.md)
- [Prompt grammar and resolution](docs/prompt-engine.md)
- [Canvas](docs/canvas.md)
- [Mermaid diagrams](docs/mermaid-diagrams.md)
- [MCP bridge](docs/mcp-bridge.md)
- [Parameters editor](docs/parameters.md)
- [Vector editor](docs/vector-editor.md)
- [Vector editor roadmap](docs/vector-roadmap.md)
- [Chart editor](docs/chart-editor.md)
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
