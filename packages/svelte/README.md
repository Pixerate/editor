# @pixerate/editor-svelte

Svelte 5 bindings for [`@pixerate/editor`](https://www.npmjs.com/package/@pixerate/editor): a rich-text editor component, bubble menu, read-only token renderer, plus spreadsheet and image editor components and rune-based node-graph canvas helpers.

```bash
npm install @pixerate/editor-svelte @pixerate/editor svelte
# only if you use @pixerate/editor-svelte/canvas:
npm install @xyflow/svelte
```

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

## Read-only token renderer

```svelte
<script lang="ts">
  import { TemplateRenderer } from "@pixerate/editor-svelte";
  const templates = [{ name: "golden_hour", body: "warm 35mm volumetric lighting" }];
</script>

<TemplateRenderer content={"A photo of {subject} in {{golden_hour}}"} {templates} resolve />
```

## More exports

| Import | Exports |
| :--- | :--- |
| `@pixerate/editor-svelte` | `EditableTextNodeEditor`, `BubbleMenu`, `TemplateRenderer`, `initiateEditor`, `createReactiveEditor`, `createHistory`, `createHistoryShortcuts`, `navigationGuard` (action), `createNavigationGuard`, `SpreadsheetEditor`, `FormulaBar`, `createReactiveSpreadsheet`, `DirtyTracker` |
| `@pixerate/editor-svelte/image-editor` | `ImageEditor`, `createReactiveImageEditor`: crop, rotate/flip, adjustments, annotations, depth masks, and `onInpaint` / `onRemoveBackground` AI hooks |
| `@pixerate/editor-svelte/canvas` | Runes for `@xyflow/svelte`: `createCanvasGraph`, `createCanvasClipboard`, `createCanvasDocking`, `createCanvasShortcuts`, `createCanvasInteractions`, `createCanvasExplosion`, `createCanvasNodeSync`, `createCanvasMultiDrag`, `createStreamingCanvas`, `AgentPresenceLayer`, `FloatingHorizontalScrollbar`, plus layout helpers |

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
