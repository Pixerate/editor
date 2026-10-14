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
      <BubbleMenu editor={editor}>{/* your formatting buttons */}</BubbleMenu>
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

<ReviewToolbar editor={editor} />        {/* toggle tracking, prev/next, accept/reject (all) */}
<BubbleMenu editor={editor}><CommentButton editor={editor} /></BubbleMenu>
<CommentsPanel editor={editor} />        {/* threads: reply, resolve, delete, click to select */}
```

`useComments(editorOrStore)` and `useTrackChanges(editor)` expose the same state for custom UIs.

`useEditor({ fileImport: true, richClipboard: true })` imports dropped/pasted `.md`, `.html`, `.txt` and `.rtf` files at the drop position and copies lossless slices between editors. `useFileImport(editor)` returns `{ openFilePicker, importFiles, accept, isImporting, error }` for an import button. `usePromptEditor({ fileImport: true })` imports dropped files as plain text.

`useAgentToolProvider(registry, provider)` registers an agent tool provider (see `ToolRegistry` in `@pixerate/editor/agent`) while the component is mounted. Memoize the provider:

```tsx
const provider = useMemo(() => editor && createRichTextToolProvider(editor, { id: "doc" }), [editor]);
useAgentToolProvider(registry, provider);
```

## More exports

| Import | Exports |
| :--- | :--- |
| `@pixerate/editor-react` | `usePromptEditor`, `useEditor`, `EditorContent`, `BubbleMenu`, `TemplateRenderer`, `useHistory`, `useHistoryShortcuts`, `useNavigationGuard`, `useDismissGuard`, `EditorSlotsProvider` / `useEditorSlots`, `SpreadsheetEditor` / `useSpreadsheetEditor`, `FormulaHints`, `DirtyTracker` |
| `@pixerate/editor-react/spreadsheet` | `SpreadsheetEditor`, `useSpreadsheetEditor`, `useSpreadsheetTableInteractions`, `FormulaHints`, `SpreadsheetContextMenu`, `SpreadsheetGroupRow` (also re-exported from the root entry) |
| `@pixerate/editor-react/image-editor` | `ImageEditor`, `useImageEditor`: crop, rotate/flip, adjustments, annotations, depth masks, and `onInpaint` / `onRemoveBackground` AI hooks |
| `@pixerate/editor-react/canvas` | `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasDocking`, `useCanvasShortcuts`, `useCanvasExplosion`, `useStreamingCanvas`, `AgentPresenceLayer`, plus the pure layout helpers from `@pixerate/editor/canvas` |

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
