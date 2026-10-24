# @pixerate/editor-svelte

Svelte 5 bindings for [`@pixerate/editor`](https://www.npmjs.com/package/@pixerate/editor): a rich-text editor component, bubble menu, read-only token renderer, plus spreadsheet and image editor components and rune-based node-graph canvas helpers.

```bash
npm install @pixerate/editor-svelte @pixerate/editor svelte
# only if you use @pixerate/editor-svelte/canvas:
npm install @xyflow/svelte @dagrejs/dagre
```

Each feature has its own entry: `@pixerate/editor-svelte/spreadsheet`, `/image-editor` and `/canvas`. The spreadsheet and image editor entries import only Svelte and the matching `@pixerate/editor` subpath, so they bundle no TipTap, markdown or canvas code.

Requires **Svelte 5** (the components use runes). Components ship as `.svelte` sources, so they are compiled by your bundler and work with SvelteKit SSR.

## Rich text editor

```svelte
<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { EditableTextNodeEditor, BubbleMenu } from "@pixerate/editor-svelte";

  let editor = $state<Editor>();
  let html = $state("<p>Start editing…</p>");
</script>

<EditableTextNodeEditor
  bind:editor
  content={html}
  placeholder="Type anything…"
  onUpdate={() => (html = editor?.getHTML() ?? html)}
/>

{#if editor}
  <BubbleMenu {editor}><!-- your formatting buttons --></BubbleMenu>
{/if}
```

`content` sets the initial document. Read later changes from the bound `editor` (for example in `onUpdate`), as above. The editor is preloaded with `createRichTextPreset()`. Pass `markdown`, `image`, `uploadImage`, `extensions` or `richTextOptions` to configure it.

`fileImport` imports dropped/pasted `.md`, `.html`, `.txt`, `.rtf` and `.docx` files (plus any adapter you register, e.g. PDF or zipped exports) at the drop position, and `richClipboard` copies lossless slices between editors (both opt-in). `createFileImport(() => editor)` returns reactive `isImporting` / `error` plus `openFilePicker()` and `importFiles()` for an import button.

`useAgentToolProvider(registry, () => editor && createRichTextToolProvider(editor, { id: "doc" }))` registers an agent tool provider (see `ToolRegistry` in `@pixerate/editor/agent`) for the component's lifetime. Call it during component initialisation.

## Read-only token renderer

```svelte
<script lang="ts">
  import { TemplateRenderer } from "@pixerate/editor-svelte";
  const templates = [{ name: "golden_hour", body: "warm 35mm volumetric lighting" }];
</script>

<TemplateRenderer content={"A photo of {subject} in {{golden_hour}}"} {templates} resolve />
```

## Comments and tracked changes

```svelte
<script lang="ts">
  import { Comments, TrackChanges } from "@pixerate/editor";
  import { EditableTextNodeEditor, CommentsPanel, ReviewToolbar } from "@pixerate/editor-svelte";
  let editor = $state();
  const extensions = [Comments.configure({ author: me }), TrackChanges.configure({ author: me })];
</script>

<ReviewToolbar {editor} />
<EditableTextNodeEditor bind:editor {extensions} />
<CommentsPanel {editor} />
```

`ReviewToolbar` steps through insertions, deletions, formatting and block changes and shows the current one's author and description (e.g. "Ada: Formatted: Bold"); hide it with `showDescription={false}` or restyle it with `descriptionClass`. Put `<CommentButton {editor} />` inside a `BubbleMenu` to comment on the selection. `createComments(editorOrStore)` and `createTrackChanges(editor)` are rune (and Svelte store) adapters for custom UIs.

Tables are on by default in `createRichTextPreset` (`table: false` turns them off). `<TableToolbar {editor} />` shows row, column, merge/split, header and alignment buttons while the selection is in a table (disabled buttons explain why in their tooltip; `items` picks the buttons, `showWhenOutside` keeps it visible). `<TableBubbleMenu {editor} />` shows it in a bubble menu next to the cursor, and `<InsertTableGrid {editor} oninsert={…} />` is a Word-style size picker. `createTableMenu(editor)` is the rune adapter for custom UIs.

`<FindReplaceBar {editor} />` is a Word-style find bar for editors with the `FindReplace` extension (`createRichTextPreset({ findReplace: true })`): it appears on Mod+F / Mod+H (or `editor.commands.openFindReplace()`), with find and replace fields, option toggles, a "3 of 12" counter, previous/next, Replace and Replace all; Enter / Shift+Enter step, Mod+Enter in the replace field replaces all, Escape closes (`onclose`). `createFindReplace(editor)` is the rune (and Svelte store) adapter for custom UIs.

## More exports

| Import | Exports |
| :--- | :--- |
| `@pixerate/editor-svelte` | `EditableTextNodeEditor`, `BubbleMenu`, `TemplateRenderer`, `initiateEditor`, `createReactiveEditor`, `createHistory`, `createHistoryDirty`, `createHistoryShortcuts`, `navigationGuard` (action), `createNavigationGuard`, `SpreadsheetEditor`, `FormulaBar`, `FormulaHints`, `createReactiveSpreadsheet`, `DirtyTracker` |
| `@pixerate/editor-svelte/spreadsheet` | `SpreadsheetEditor` (virtualised for large sheets, `virtualize` prop), `FormulaBar`, `FormulaHints`, `SpreadsheetContextMenu`, `SpreadsheetGroupRow`, `SheetTabs`, `NameManager`, `createReactiveSpreadsheet`, `createSpreadsheetViewport` (also re-exported from the root entry) |
| `@pixerate/editor-svelte/image-editor` | `ImageEditor`, `createReactiveImageEditor`: crop, rotate/flip, adjustments, annotations, depth masks, Select & Mask (`SelectionOptionsBar`, `RefineEdgePanel`: magic wand, marquees, lasso, Refine Edge, layer masks), and `onInpaint` / `onRemoveBackground` AI hooks |
| `@pixerate/editor-svelte/paint-editor` | `PaintEditor`, `createReactivePaintEditor`: natural-media painting with `PaintCanvas` (pen pressure, tilt and twist, coalesced and predicted events, palm rejection, view rotation and mirroring), `PaintToolbar` (tools, symmetry, perspective, tracing and reference images, save / open, PNG / JPEG / PSD), `BrushPanel` (library with thumbnails), `PaperPanel`, `ColorPanel` (wheel, harmonies, swatches, mixing pad) and `PaintLayersPanel` |
| `@pixerate/editor-svelte/commands` | `CommandPalette`, `createCommandPalette` (`hotkey: "Mod+K"`; call `destroy()` when done), `createCommandShortcuts`, `useRegisterCommands` over a `CommandRegistry` from `@pixerate/editor/commands` (also re-exported from the root entry) |
| `@pixerate/editor-svelte/persistence` | `createAutosave` (crash-recovery snapshots bound to a history / dirty flag, flushed on `pagehide`; call `destroy()` when done), `createEditorAutosave` (the same for any editor's `EditorDocument`, e.g. `createMermaidDiagram().editorDocument`; `restore` loads the snapshot into the editor) and `<RecoveryPrompt>` (also re-exported from the root entry) |
| `@pixerate/editor-svelte/generation` | `GenerationSettings` (controls generated from a model's capabilities, reference slots by role, plan adjustments; `onchange` / `onaddreference`), `createGenerationPlan(() => request, () => caps)`, `JobProgress`, `createJobProgress` (call `destroy()` when done) over `@pixerate/editor/generation` (also re-exported from the root entry) |
| `@pixerate/editor-svelte/vector` | `VectorEditor` (toolbar, canvas and style panel), `VectorCanvas` (SVG canvas forwarding pointer, wheel, keyboard and clipboard events), `VectorToolbar`, `VectorStylePanel`, `VectorSceneNodes`, `VectorGradientDefs`, `createVectorEditor` (call `destroy()` when done) and `useVectorCommands` over `@pixerate/editor/vector` (see [the vector editor guide](../../docs/vector-editor.md)) |
| `@pixerate/editor-svelte/chart` | `ChartEditor` (toolbar, chart, inspector and data grid), `ChartCanvas` (SVG chart with selection, drag-to-edit and keyboard editing), `ChartDataGrid`, `ChartInspector`, `createChartEditor` (call `destroy()` when done) and `useChartCommands` over `@pixerate/editor/chart` (see [the chart editor guide](../../docs/chart-editor.md)) |
| `@pixerate/editor-svelte/parameters` | `ParametersPanel` (a whole schema with groups, presets, undo / reset / randomize and keyframe diamonds), `createParameters` (call `destroy()` when done), `useParameterCommands`, and the field controls `ParameterFieldControl`, `ParameterSlider`, `ParameterToggle`, `ParameterSelect`, `ParameterColor`, `ParameterVector`, `ParameterImage`, `ParameterText`, `KeyframeDiamond` over `@pixerate/editor/parameters` (see [the parameters guide](../../docs/parameters.md)) |
| `@pixerate/editor-svelte/color` | `ColorPicker` (interactive hex/rgb/hsl/oklch picker with alpha, swatches, eyedropper, recent history), `DualColorPicker` (dual light/dark mode color picker with theme preview and switch), `createColorScheme` (system preference detection and toggle) (also re-exported from the root entry) |
| `@pixerate/editor-svelte/gradient` | `GradientEditor` (interactive stops bar, midpoints, presets, angle dial, type selector, sRGB/linear-RGB/OKLab interpolation), `FillPicker` (solid vs gradient fill switcher with popup editor), `createGradientController` |
| `@pixerate/editor-svelte/canvas` | Runes for `@xyflow/svelte`: `createCanvasGraph`, `createCanvasClipboard`, `createCanvasDocking`, `createCanvasShortcuts`, `createCanvasInteractions`, `createCanvasExplosion`, `createCanvasNodeSync`, `createCanvasMultiDrag`, `createStreamingCanvas`, `AgentPresenceLayer`, `FloatingHorizontalScrollbar`, plus layout helpers |

Spreadsheet persistence: `createReactiveSpreadsheet` exposes `document` (and passes it to `onDocumentChange`) with the defined names its formulas use in `document.names`, so saving that document and passing it back as `document` restores workbook, sheet-scoped and LAMBDA names. For several sheets, save `controller.getWorkbook()` instead.

Prop types are exported alongside each component, for example `EditableTextNodeEditorProps`, `BubbleMenuProps`, `ImageEditorProps` and `SpreadsheetEditorProps`.

## Styling (Tailwind CSS required)

The components are styled with [Tailwind CSS](https://tailwindcss.com) utility classes and ship no global stylesheet. To style them:

1. **Let Tailwind scan the package**, or the classes will be purged.

   Tailwind v4, in your CSS:

   ```css
   @source "../node_modules/@pixerate/editor-svelte/dist";
   ```

   Tailwind v3, in `tailwind.config.js`:

   ```js
   content: ["./src/**/*.{svelte,ts}", "./node_modules/@pixerate/editor-svelte/dist/**/*.{svelte,js}"],
   ```

2. **Define the theme colors.** `SpreadsheetEditor`, `FormulaBar`, `TemplateRenderer` and the editor use [shadcn-svelte](https://www.shadcn-svelte.com)-style tokens: `background`, `foreground`, `muted`, `muted-foreground`, `border`, `input`, `primary`, `popover`, `popover-foreground` and `destructive`. Projects already using shadcn-svelte have these. Otherwise, define them as colors in your Tailwind theme.

`ImageEditor` uses a fixed dark (slate) palette and only needs step 1. Component-scoped styles, such as the editor placeholder, are included automatically.

## License

MIT
