# @pixerate/editor

UI-agnostic core of the Pixerate editor toolkit: a prompt-template grammar with recursive resolution and sourcemaps, plain-text and markdown serializers, headless [TipTap](https://tiptap.dev) extensions, and framework-free controllers for rich text, spreadsheets, images and node-graph canvases.

Framework bindings: [`@pixerate/editor-react`](https://www.npmjs.com/package/@pixerate/editor-react) · [`@pixerate/editor-svelte`](https://www.npmjs.com/package/@pixerate/editor-svelte)

```bash
npm install @pixerate/editor
# only if you use @pixerate/editor/canvas (or the agent canvas planner):
npm install @dagrejs/dagre
```

## Prompt grammar

Prompts use three token types:

| Syntax | Token | Example |
| :--- | :--- | :--- |
| `{{name}}` | template, replaced by its body (recursively) | `{{golden_hour}}` |
| `{variable}` | variable, filled from a values map | `{subject}` |
| `__instruction__` | instruction, a styled directive for the model | `__award_winning__` |

```ts
import {
  tokenizePrompt,
  resolveTemplates,
  resolveVariables,
  resolveTemplatesWithMapping,
  mapResolvedOffsetToRaw,
  TEMPLATE_LOOP_ERROR,
} from "@pixerate/editor/grammar";

const templates = [
  { name: "mood", body: "cinematic cyber-noir" },
  { name: "scene", body: "rainy street, {{mood}}" },
];

tokenizePrompt("Shot of {{scene}} with {subject}");
// [{ type: "text", … }, { type: "template", value: "scene", start: 8, end: 17, … }, …]

resolveTemplates("Shot of {{scene}}", templates);
// "Shot of rainy street, cinematic cyber-noir"

resolveVariables("Hello {user}", { user: "Ada" }); // "Hello Ada"

// Map offsets in the resolved text back to the source (for error highlighting, carets, …)
const { text, map } = resolveTemplatesWithMapping("Shot of {{scene}}", templates);
mapResolvedOffsetToRaw(text.length, map); // 17, the end of "{{scene}}"
```

- **Cycles and depth.** A tag that would recurse into itself is replaced with `TEMPLATE_LOOP_ERROR` (`"[Template loop detected]"`), and tags nested deeper than `maxDepth` (default `10`) with `TEMPLATE_DEPTH_ERROR`. The rest of the prompt still resolves, so check with `result.includes(TEMPLATE_LOOP_ERROR)`.
- **Versions.** Templates may carry `versions` and `latestVersion`. Pin specific versions with `resolveTemplates(text, templates, { bindings: { name: "v1" } })`.

## Serializers

```ts
import {
  plainTextToTipTapHtml,
  htmlToPlainText,
  getEditorText,
  markdownToTipTapHtml,
  getEditorMarkdown,
  extractMentionsFromDoc,
} from "@pixerate/editor/serializers";
```

- `plainTextToTipTapHtml` / `htmlToPlainText` round-trip multi-line plain text through TipTap paragraphs without leaking HTML.
- `markdownToTipTapHtml` renders markdown for TipTap. Raw HTML embedded in the markdown is sanitized against an allowlist (event handlers, `style` and `javascript:` URLs are removed). Pass `{ allowUnsafeHtml: true }` only for fully trusted input.

## Editor controller and extensions

`createEditor` wraps a TipTap `Editor` with plain-text / markdown modes, token callbacks and dirty tracking. It works with any view layer, or with none.

```ts
import { createEditor, createRichTextPreset, GradientText } from "@pixerate/editor";

const controller = createEditor({
  element: document.querySelector("#editor"),
  plainTextMode: true,
  content: "A photo of {subject} in {{golden_hour}}",
  extensions: [...createRichTextPreset(), GradientText],
  onTokensChange: (tokens) => console.log(tokens),
});

controller.insertText("__award_winning__ "); // at the selection; literal text, never parsed as HTML
controller.isDirty(); // true
```

Extensions (`@pixerate/editor/extensions`): `createRichTextPreset`, `GradientText`, `TemplateSuggestions`, `SlashCommands`, `LoadingNode`, `Mention` / `createMentionExtension`, `Image`, `Markdown`, `SmilieReplacer`, `ColorHighlighter`, `FontSize`.

## Comments and tracked changes

```ts
import { Comments, CommentStore, TrackChanges, getTrackedChanges } from "@pixerate/editor";

const me = { id: "u1", name: "Ada" };
const store = new CommentStore({ threads: savedJson }); // persistence is up to you
const editor = new Editor({
  extensions: [
    ...createRichTextPreset(),
    Comments.configure({ store, author: me }),
    TrackChanges.configure({ author: me, enabled: false }),
  ],
});

editor.commands.addComment({ body: "Is this right?" }); // on the selection
editor.commands.resolveComment(id); // also deleteComment, setActiveComment, focusComment
store.subscribe((snapshot) => save(store.toJSON()));

editor.commands.toggleTrackChanges();
getTrackedChanges(editor); // [{ id, type: "insertion" | "deletion", author, from, to, text, … }]
editor.commands.acceptChange(id); // rejectChange, acceptAllChanges, rejectAllChanges: one undo step each
```

- **Comments** are `comment` marks holding a thread id; thread content lives in the headless `CommentStore` (`subscribe` / `getSnapshot`, cached snapshots, `toJSON` / `load`). Threads whose text is deleted are flagged `orphaned` and re-attach on undo.
- **Track changes** marks typed and pasted text with an `insertion` mark and keeps deleted text with a `deletion` mark (struck through). Deleting your own insertion really deletes it. IME composition is tracked once it ends. Not tracked: formatting-only changes, block-structure changes (splitting/joining paragraphs, lists) and edits inside code blocks. Set the `TRACK_CHANGES_SKIP_META` transaction meta to apply a change untracked (e.g. `setContent`).
- **Serializers** render tracked content as if all changes were accepted: `getEditorText`, `htmlToPlainText` and `getEditorMarkdown` drop deleted text by default. Pass `{ trackedChanges: "original" }` (as if rejected) or `"all"` (both). `resolveTrackedChanges(doc, view)` returns a resolved document. TipTap's own `editor.getText()` still includes deleted text.
- Both extensions are also available as `createRichTextPreset({ comments: true, trackChanges: true })`. Mark styles use Tailwind classes; override them via `commentClass` / `activeClass` and `insertionHTMLAttributes` / `deletionHTMLAttributes`.

## File import and rich clipboard

An import adapter registry maps file types (MIME types and extensions) to converters. Built-in `document` adapters cover markdown (`.md`, `.markdown`, `.mdown`, `.mkdn`, `.mkd`, `.Rmd`, `.md.txt`), HTML (sanitized with the same allowlist as markdown), plain text (`.txt`) and RTF (best-effort text extraction). The longest matching extension wins, then exact MIME types, then `priority`, then the most recent registration.

```ts
import { importFile, registerImportAdapter, getImportAccept } from "@pixerate/editor";

const { adapterId, result } = await importFile(file); // result: { html, text }
input.accept = getImportAccept("document");

// DOCX, PDF, zipped exports or CSV → spreadsheet are pluggable:
registerImportAdapter({
  id: "docx",
  label: "Word",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  extensions: [".docx"],
  target: "document",
  async import(_file, ctx) {
    const html = await myDocxToHtml(await ctx.readArrayBuffer());
    return { html, text: htmlToPlainText(html) };
  },
});
```

`FileImport` (or `createRichTextPreset({ fileImport: true })`) inserts dropped or pasted files at the drop position, and `FileImportController` / `pickImportFiles` back file-picker buttons. `RichClipboard` (or `richClipboard: true`) also writes copied content as `application/x.pixerate.document+json` (ProseMirror slice JSON plus a schema signature) and prefers it on paste when the schemas match, falling back to HTML / plain text. Both are opt-in, and `EditorController` keeps them on plain text in `plainTextMode`.

## Agent tool registry

`ToolRegistry` (`@pixerate/editor/agent`) collects MCP-shaped tools from live providers, for example one per mounted editor or spreadsheet. `listTools()` and `callTool()` return MCP `tools/list` / `tools/call` result shapes, arguments are validated against each tool's `inputSchema`, and `onListChanged` fires (coalesced) when providers come and go. Colliding names are namespaced as `<providerId>__<name>`.

```ts
import { ToolRegistry, createRichTextToolProvider, createSpreadsheetToolProvider } from "@pixerate/editor/agent";

const registry = new ToolRegistry();
const unregister = registry.register(createRichTextToolProvider(controller, { id: "doc" }));
registry.register(createSpreadsheetToolProvider(sheet, { id: "sheet", namespace: "sheet" }));
registry.onListChanged((tools) => server.sendToolListChanged());

await registry.callTool("insert_text", { text: "Hello" }); // { content: [...], structuredContent }
```

`createEditorMcpToolProvider` exposes the static tools (`get_editor_state`, `edit_canvas`, `edit_prompt`, `view_editor`) through the registry, and `planToolCall` turns any tool call into planner steps (`step:tool_call` for registry tools).

### Document structure and autocorrect

Opt-in preset options add Word/Pages-style document structure:

```ts
const extensions = createRichTextPreset({
  outline: true,          // stable heading ids + live outline (getOutline, createOutlineStore)
  tableOfContents: true,  // editor.commands.insertTableOfContents(); markdown `[[toc]]`
  footnotes: true,        // editor.commands.insertFootnote({ content }); markdown `[^1]`
  bookmarks: true,        // editor.commands.setBookmark({ name })
  crossReferences: true,  // editor.commands.insertCrossReference({ targetType, targetId })
  autocorrect: { exceptions: [...DEFAULT_AUTOCORRECT_EXCEPTIONS, "approx."] },
});
```

`Autocorrect` takes a `rules` list (`defaultAutocorrectRules`, or compose `smartQuoteRules`, `symbolRules`, `fractionRules`, `capitalizeSentenceRules`, `twoInitialCapitalsRules`, `smilieAutocorrectRules` and your own `{ id, find, replace }` rules). Undo right after a correction restores what was typed; nothing is corrected in code or inside prompt tokens. It replaces the Typography extension in the preset. `getDocumentStructureCommandItems(editor, query)` returns ready-made slash-menu/toolbar items for the installed extensions.

## Other modules

Each module is also available as a subpath import:

| Import | Contents |
| :--- | :--- |
| `@pixerate/editor/grammar` | Tokenizer, resolver, sourcemaps. No TipTap or DOM dependencies, so it is safe for Node.js, workers and serverless functions. |
| `@pixerate/editor/serializers` | Plain text, markdown and mention serializers |
| `@pixerate/editor/extensions` | Headless TipTap extensions |
| `@pixerate/editor/history` | `HistoryManager`: a command-pattern undo/redo stack |
| `@pixerate/editor/spreadsheet` | `SpreadsheetController`, formula parser/evaluator and dependency graph, formula function registry (`registerFormulaFunction`, `listFormulaFunctions`, `searchFormulaFunctions`, `getFormulaSignature`) and autocomplete helpers (`getFormulaHints`, `applyFormulaSuggestion`) |
| `@pixerate/editor/image-editor` | `ImageEditorController` and Canvas 2D renderer: crop, adjustments, annotations, depth masks and AI hooks. Needs a DOM/canvas environment. |
| `@pixerate/editor/canvas` | Node-graph layout (needs the optional `@dagrejs/dagre` peer), placement, trajectories, displacement, clipboard and streaming layout helpers |
| `@pixerate/editor/agent` | MCP tool schemas, a planner for agent-driven canvas edits, and the dynamic `ToolRegistry` with editor/spreadsheet tool providers |

The root entry (`@pixerate/editor`) re-exports everything except canvas, agent and image editor, including TipTap. Import from the narrowest subpath you need: `grammar`, `history`, `spreadsheet` and `image-editor` have no third-party imports, so a spreadsheet-only app bundles no TipTap, markdown or dagre code. The package is marked `sideEffects: false`, so unused root exports are also tree-shaken.

## License

MIT
