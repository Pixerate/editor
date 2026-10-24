# @pixerate/editor-react

React bindings for [`@pixerate/editor`](https://www.npmjs.com/package/@pixerate/editor): a prompt editor with live template highlighting and autocomplete, a rich-text editor, a read-only token renderer, plus spreadsheet, image editor and node-graph canvas components.

```bash
npm install @pixerate/editor-react @pixerate/editor react react-dom
# only if you use @pixerate/editor-react/canvas:
npm install @xyflow/react @dagrejs/dagre
```

Each feature has its own entry: `@pixerate/editor-react/spreadsheet`, `/image-editor` and `/canvas`. The spreadsheet and image editor entries import only React and the matching `@pixerate/editor` subpath, so they bundle no TipTap, markdown or canvas code.

Requires React 18 or later.

## Prompt editor

```tsx
import { useState } from "react";
import { usePromptEditor, EditorContent, TemplateRenderer } from "@pixerate/editor-react";

const templates = [{ name: "golden_hour", body: "warm 35mm volumetric lighting" }];

export function PromptStudio() {
  const [prompt, setPrompt] = useState("A photo of {subject} in {{golden_hour}}");

  const editor = usePromptEditor({
    content: prompt,
    onContentChange: setPrompt,
    templates,
    placeholder: "Write your prompt…",
  });

  return (
    <>
      <EditorContent editor={editor} />
      {/* Lightweight read-only preview, no TipTap instance */}
      <TemplateRenderer content={prompt} templates={templates} resolve />
    </>
  );
}
```

`usePromptEditor` keeps the editor in plain-text mode. It animates `{{template}}` tags, opens template autocomplete on `{{`, detects slash commands (`onSlashCommandMatch`) and normalizes pasted text to plain paragraphs. `content` sets the initial text.

## Rich text editor

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

`useEditor` is TipTap's `useEditor` preloaded with `createRichTextPreset()`: headings, lists, task lists, links, text alignment, colors and highlights, and images. Mentions and markdown are opt-in via `richTextOptions: { mention: true, markdown: true }`.

## Comments and tracked changes

```tsx
import { Comments, TrackChanges } from "@pixerate/editor";
import { CommentsPanel, ReviewToolbar, CommentButton, BubbleMenu } from "@pixerate/editor-react";

const editor = useEditor({ extensions: [Comments.configure({ author: me }), TrackChanges.configure({ author: me })] });

<ReviewToolbar editor={editor} />        {/* toggle tracking, prev/next, accept/reject (all), current change description */}
<BubbleMenu editor={editor}><CommentButton editor={editor} /></BubbleMenu>
<CommentsPanel editor={editor} />        {/* threads: reply, resolve, delete, click to select */}
```

`ReviewToolbar` steps through insertions, deletions, formatting and block changes and shows the current one's author and description (e.g. "Ada: Changed Paragraph to Heading 2"); hide it with `showDescription={false}` or restyle it with `descriptionClassName`. `useComments(editorOrStore)` and `useTrackChanges(editor)` expose the same state for custom UIs (each change has `type` and `description`).

`FindReplaceBar` is a Word-style find bar for editors with the `FindReplace` extension (`useEditor({ richTextOptions: { findReplace: true } })`): it appears on Mod+F / Mod+H (or `editor.commands.openFindReplace()`), with find and replace fields, option toggles (match case, whole words, wildcards, regex, plus prefix/suffix/ignore punctuation/white space under "More options"), a "3 of 12" counter, previous/next, Replace and Replace all. Enter / Shift+Enter step, Enter in the replace field replaces, Mod+Enter replaces all, Escape closes. Pass `alwaysOpen` to keep it visible. `useFindReplace(editor)` exposes the state and commands for custom UIs.

Tables are on by default in `useEditor` (`richTextOptions: { table: false }` turns them off). `<TableToolbar editor={editor} />` shows row, column, merge/split, header and alignment buttons while the selection is in a table (disabled buttons explain why in their tooltip; `items` picks the buttons, `showWhenOutside` keeps it visible). `<TableBubbleMenu editor={editor} />` shows the same toolbar in a bubble menu next to the cursor, and `<InsertTableGrid editor={editor} onInsert={…} />` is a Word-style size picker. `useTableMenu(editor)` exposes the table state and `run(action, params)` for custom UIs.

`useEditor({ fileImport: true, richClipboard: true })` imports dropped/pasted `.md`, `.html`, `.txt`, `.rtf` and `.docx` files (plus any adapter you register, e.g. PDF or zipped exports) at the drop position and copies lossless slices between editors. `useFileImport(editor)` returns `{ openFilePicker, importFiles, accept, isImporting, error }` for an import button. `usePromptEditor({ fileImport: true })` imports dropped files as plain text.

`useAgentToolProvider(registry, provider)` registers an agent tool provider (see `ToolRegistry` in `@pixerate/editor/agent`) while the component is mounted. Memoize the provider:

```tsx
const provider = useMemo(() => editor && createRichTextToolProvider(editor, { id: "doc" }), [editor]);
useAgentToolProvider(registry, provider);
```

## More exports

| Import | Exports |
| :--- | :--- |
| `@pixerate/editor-react` | `usePromptEditor`, `useEditor`, `EditorContent`, `BubbleMenu`, `TemplateRenderer`, `useHistory`, `useHistoryDirty`, `useHistoryShortcuts`, `useNavigationGuard`, `useDismissGuard`, `EditorSlotsProvider` / `useEditorSlots`, `SpreadsheetEditor` / `useSpreadsheetEditor`, `FormulaHints`, `DirtyTracker` |
| `@pixerate/editor-react/spreadsheet` | `SpreadsheetEditor` (virtualised for large sheets, `virtualize` prop), `useSpreadsheetEditor`, `useSpreadsheetViewport`, `useSpreadsheetTableInteractions`, `FormulaHints`, `SpreadsheetContextMenu`, `SpreadsheetGroupRow`, `SheetTabs`, `NameManager` (also re-exported from the root entry) |
| `@pixerate/editor-react/image-editor` | `ImageEditor`, `useImageEditor`: crop, rotate/flip, adjustments, annotations, depth masks, Select & Mask (`SelectionOptionsBar`, `RefineEdgePanel`: magic wand, marquees, lasso, Refine Edge, layer masks), and `onInpaint` / `onRemoveBackground` AI hooks |
| `@pixerate/editor-react/paint-editor` | `PaintEditor`, `usePaintEditor`: natural-media painting with `PaintCanvas` (pen pressure, tilt and twist, coalesced and predicted events, palm rejection, view rotation and mirroring), `PaintToolbar` (tools, symmetry, perspective, tracing and reference images, save / open, PNG / JPEG / PSD), `BrushPanel` (library with thumbnails), `PaperPanel`, `ColorPanel` (wheel, harmonies, swatches, mixing pad) and `PaintLayersPanel` |
| `@pixerate/editor-react/commands` | `CommandPalette`, `useCommandPalette` (`hotkey: "Mod+K"`), `useCommandShortcuts`, `useRegisterCommands` over a `CommandRegistry` from `@pixerate/editor/commands` (also re-exported from the root entry) |
| `@pixerate/editor-react/persistence` | `useAutosave` (crash-recovery snapshots bound to a history / dirty flag, flushed on `pagehide`, with a recovery check on mount), `useEditorAutosave` (the same for any editor's `EditorDocument`, e.g. `useMermaidDiagram().editorDocument`; `restore` loads the snapshot into the editor) and `<RecoveryPrompt>` (also re-exported from the root entry) |
| `@pixerate/editor-react/generation` | `GenerationSettings` (controls generated from a model's capabilities, reference slots by role, plan adjustments), `useGenerationPlan`, `JobProgress`, `useJobProgress` over `@pixerate/editor/generation` (also re-exported from the root entry) |
| `@pixerate/editor-react/vector` | `VectorEditor` (toolbar, canvas and style panel), `VectorCanvas` (SVG canvas forwarding pointer, wheel, keyboard and clipboard events), `VectorToolbar`, `VectorStylePanel`, `VectorSceneNodes`, `VectorGradientDefs`, `useVectorEditor`, `useVectorEditorController`, `useVectorEditorState` and `useVectorCommands` over `@pixerate/editor/vector` (see [the vector editor guide](../../docs/vector-editor.md)) |
| `@pixerate/editor-react/chart` | `ChartEditor` (toolbar, chart, inspector and data grid), `ChartCanvas` (SVG chart with selection, drag-to-edit and keyboard editing), `ChartDataGrid`, `ChartInspector`, `useChartEditor`, `useChartController`, `useChartState` and `useChartCommands` over `@pixerate/editor/chart` (see [the chart editor guide](../../docs/chart-editor.md)) |
| `@pixerate/editor-react/parameters` | `ParametersPanel` (a whole schema with groups, presets, undo / reset / randomize and keyframe diamonds), `useParameters`, `useParametersController`, `useParametersState`, `useParameterCommands`, and the field controls `ParameterFieldControl`, `ParameterSlider`, `ParameterToggle`, `ParameterSelect`, `ParameterColor`, `ParameterVector`, `ParameterImage`, `ParameterText`, `KeyframeDiamond` over `@pixerate/editor/parameters` (see [the parameters guide](../../docs/parameters.md)) |
| `@pixerate/editor-react/color` | `ColorPicker` (interactive hex/rgb/hsl/oklch picker with alpha, swatches, eyedropper, recent history), `DualColorPicker` (dual light/dark mode color picker with theme preview and switch), `useColorScheme` (system preference detection and toggle) (also re-exported from the root entry) |
| `@pixerate/editor-react/gradient` | `GradientEditor` (interactive stops bar, midpoints, presets, angle dial, type selector, sRGB/linear-RGB/OKLab interpolation), `FillPicker` (solid vs gradient fill switcher with popup editor), `useGradientController` |
| `@pixerate/editor-react/canvas` | `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasDocking`, `useCanvasShortcuts`, `useCanvasExplosion`, `useStreamingCanvas`, `AgentPresenceLayer`, plus the pure layout helpers from `@pixerate/editor/canvas` |

Spreadsheet persistence: `useSpreadsheetEditor` exposes `document` (and passes it to `onDocumentChange`) with the defined names its formulas use in `document.names`, so saving that document and passing it back as `document` restores workbook, sheet-scoped and LAMBDA names. For several sheets, save `controller.getWorkbook()` instead.

## Styling (Tailwind CSS required)

The components are styled with [Tailwind CSS](https://tailwindcss.com) utility classes and ship no stylesheet of their own. To style them:

1. **Let Tailwind scan the package**, or the classes will be purged.

   Tailwind v4, in your CSS:

   ```css
   @source "../node_modules/@pixerate/editor-react/dist";
   ```

   Tailwind v3, in `tailwind.config.js`:

   ```js
   content: ["./src/**/*.{ts,tsx}", "./node_modules/@pixerate/editor-react/dist/**/*.{js,cjs}"],
   ```

2. **Define the theme colors.** `SpreadsheetEditor`, `BubbleMenu`, `TemplateRenderer` and the slot components use [shadcn/ui](https://ui.shadcn.com)-style tokens: `background`, `foreground`, `muted`, `muted-foreground`, `border`, `input`, `primary`, `popover`, `popover-foreground` and `destructive`. Projects already using shadcn/ui have these. Otherwise, define them as colors in your Tailwind theme.

`ImageEditor` uses a fixed dark (slate) palette and only needs step 1. Without Tailwind, the components work but render unstyled. Pass `className` to override.

## License

MIT
