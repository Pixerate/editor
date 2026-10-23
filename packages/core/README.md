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
getTrackedChanges(editor); // [{ id, type: "insertion" | "deletion" | "format" | "block", author, from, to, text, description, … }]
editor.commands.acceptChange(id); // rejectChange, acceptAllChanges, rejectAllChanges: one undo step each
```

- **Comments** are `comment` marks holding a thread id; thread content lives in the headless `CommentStore` (`subscribe` / `getSnapshot`, cached snapshots, `toJSON` / `load`). Threads whose text is deleted are flagged `orphaned` and re-attach on undo.
- **Track changes** marks typed and pasted text with an `insertion` mark and keeps deleted text with a `deletion` mark (struck through). Deleting your own insertion really deletes it. IME composition is tracked once it ends. Insertions and deletions inside code blocks are tracked too (`trackCodeBlocks: false` turns that off). Set the `TRACK_CHANGES_SKIP_META` transaction meta to apply a change untracked (e.g. `setContent`).
- **Tracked formatting** (`trackFormatting`, on by default): adding or removing marks (bold, italic, links, highlight, font size, …) on existing text records a `formatChange` mark holding the author, id and the `before` / `after` formatting, shown as a dotted underline. Descriptions read `Formatted: Bold`, `Removed formatting: Italic` or `Changed formatting: Font size`. Accept keeps the new formatting; reject restores the old. Adjacent or repeated formatting by the same author merges into one change, changing it back drops the record, and formatting a tracked insertion stays part of the insertion. Review marks, comments and bookmarks are never formatting (add more with `ignoredMarks`).
- **Tracked block changes** (`trackBlocks`, on by default): changing a textblock's type or attributes (paragraph ↔ heading, heading level, code block, alignment) or its wrappers (bulleted/numbered/task lists, indenting, outdenting, quotes) stores the previous state in a `blockChange` node attribute on `blockTypes` (paragraph, heading, code block), shown with a margin bar. Descriptions read `Changed Paragraph to Heading 2`, `Wrapped in Bulleted list`, `Changed alignment to Center`. Reject restores the type, attributes and nesting. Paragraph splits and joins are not tracked (a split-off block does not inherit the record). `describeFormatChange` and `describeBlockChange` build the descriptions.
- **Serializers** render tracked content as if all changes were accepted: `getEditorText`, `htmlToPlainText` and `getEditorMarkdown` drop deleted text and use the new formatting and block types by default. Pass `{ trackedChanges: "original" }` (as if rejected) or `"all"` (both). `resolveTrackedChanges(doc, view)` returns a resolved document. TipTap's own `editor.getText()` still includes deleted text.
- Both extensions are also available as `createRichTextPreset({ comments: true, trackChanges: true })`. Mark styles use Tailwind classes; override them via `commentClass` / `activeClass` and `insertionHTMLAttributes` / `deletionHTMLAttributes` / `formatChangeHTMLAttributes` / `blockChangeClass`.

## Find and replace

```ts
import { createRichTextPreset, getFindReplaceState } from "@pixerate/editor";

const editor = new Editor({ extensions: [...createRichTextPreset({ findReplace: true })] }); // or FindReplace.configure({...})

editor.commands.setSearch({ query: "([A-Z][a-z]@), ([A-Z][a-z]@)", replacement: "\\2 \\1", options: { wildcards: true } });
editor.commands.findNext(); // findPrevious, replaceCurrent, replaceAll (one undo step), clearSearch
editor.commands.openFindReplace({ mode: "replace" }); // what Mod+F / Mod+H do; closeFindReplace hides it
getFindReplaceState(editor); // { open, mode, query, replacement, options, matches, currentIndex, error, truncated, lastReplaceCount }
```

- **Options** (`FindOptions`): `matchCase`, `wholeWord`, `matchPrefix`, `matchSuffix`, `ignorePunctuation`, `ignoreWhitespace`, `wildcards`, `regex`, `literal` (no `^` codes).
- **Special characters** (Word): `^p` paragraph mark (a pattern with `^p` reads sibling paragraphs together; `^p` in the replacement splits the paragraph), `^t` tab, `^l` line break, `^?` any character, `^#` digit, `^$` letter, `^w` white space, `^^` caret, `^+` / `^=` em / en dash, `^s` non-breaking space, `^13` / `^u8212` character codes. In Replace with: `^&` found text, `^c` clipboard (`getClipboardText` option).
- **Wildcards** (Word): `?`, `*` (shortest run within a paragraph), `[a-z]`, `[!x]`, `{n}`, `{n,}`, `{n,m}`, `@` (one or more), `<` / `>` word start / end, `( )` groups used as `\1`–`\9` in Replace with. Wildcard search always matches case.
- **Bounded**: special and wildcard patterns run on a linear-time matcher (no catastrophic backtracking); every search also has a time budget (`timeLimitMs`, 250 ms) and match cap (`maxMatches`, 10 000), reported as `truncated`. Raw `regex` mode uses JavaScript's `RegExp`, rejects nested repetition such as `(a+)+` and is only bounded between matches. Invalid patterns are reported as `error: { code, message }`, never thrown.
- **Track changes**: tracked-deleted text is skipped (a match never spans a deletion, but word boundaries see the live text), and replacements made while tracking become tracked deletions and insertions.
- Matches are decorated with `pixerate-find-match` and the current one also with `pixerate-find-match-current` (`matchClass` / `currentMatchClass`); style them in your CSS. `createFindReplaceCommands(editor)` returns command-registry specs (`findReplace.open`, `.next`, `.find`, `.replaceAll`, …).

## Tables

`createRichTextPreset()` includes tables by default (TipTap's `table`, `tableRow`, `tableHeader`, `tableCell`): resizable columns (`colwidth`), header rows, columns and cells, `colspan` / `rowspan` (kept from pasted HTML and from DOCX / PDF import), cell `align` and `backgroundColor`, and table node selection. Configure them with `table: { resizable, cellMinWidth, allowTableNodeSelection, HTMLAttributes, ... }`, or pass `table: false` to leave tables out of the schema (pasted and imported tables are then flattened into paragraphs, as before).

```ts
import { createTableCommands, getTableState, runTableAction, getTableActionState } from "@pixerate/editor";

runTableAction(editor, "insertTable", { rows: 3, cols: 4, withHeaderRow: true });
getTableActionState(editor, "mergeCells"); // true, or why not: "Select two or more adjacent cells to merge."
getTableState(editor); // { inTable, rows, columns, row, column, headerRow, headerColumn, headerCell, cellAlignment, actions: { … } }
registry.register(createTableCommands(editor)); // table.insertTable, table.addRowAfter, table.mergeCells, … (palette & agents)
```

- **Actions** (`TABLE_ACTIONS`): `insertTable` (no nesting), `addRowBefore` / `addRowAfter` / `deleteRow`, `addColumnBefore` / `addColumnAfter` / `deleteColumn`, `deleteTable`, `mergeCells` / `splitCell`, `toggleHeaderRow` / `toggleHeaderColumn` / `toggleHeaderCell`, `goToNextCell` / `goToPreviousCell` (Tab / Shift+Tab), `setCellAlignment` (`{ align }`) and `setCellBackground` (`{ color }`, sanitized). `createTableStore(editor)` is the external store the React and Svelte toolbars use; `DEFAULT_TABLE_TOOLBAR` lists their buttons. `createRichTextToolProvider` adds an `edit_table` agent tool when the schema has tables.
- **No nested tables**: pasting a table (HTML, markdown or the rich clipboard) on its own while the cursor is in a cell fills the cells from that cell, growing the table when needed (a cell selection is filled and clipped as before); pasted content that contains a table among other blocks, and imported files with tables (`importFilesIntoEditor`, `FileImport`), are inserted after the outermost table, and the cell keeps its content. A guard moves any table another edit puts into a cell (`insertContent`, `insertTable`) after the table; tracked changes still record the insertion. Documents that already contain nested tables load and stay unchanged (initial content, `setContent`, undo, collaboration); set `ALLOW_NESTED_TABLES_META` on a transaction to opt out of the guard.
- **Export**: `getEditorText` writes each row as a line of tab-separated cells. Markdown (`markdown: true`) writes a GFM pipe table (column alignment from the header cells, `|` escaped) when the first row is all header cells, nothing spans and every cell holds one paragraph; otherwise the table is written as HTML, which parses back. GFM tables in markdown input become tables.
- **Track changes**: edits inside cells are tracked like any text. Inserting or deleting rows, columns (their cells) or a whole table is tracked as a whole-block change (`blockChange` with `operation`): rejecting an insertion or accepting a deletion removes the rows/cells/table; deleting rows you inserted yourself removes them. Header toggles are tracked as block changes (reject restores the cell type). Cell attributes (alignment, background, widths) are not tracked, and merging or splitting cells is refused while tracking. `compareDocuments` compares tables row by row and cell by cell.
- Style the tables in your CSS (`.tableWrapper`, `table`, `th`, `td`, `.selectedCell`, `.column-resize-handle`; the table has the `pixerate-table` class).

## File import and rich clipboard

An import adapter registry maps file types (MIME types and extensions) to converters. Built-in `document` adapters cover markdown (`.md`, `.markdown`, `.mdown`, `.mkdn`, `.mkd`, `.Rmd`, `.md.txt`), HTML (sanitized with the same allowlist as markdown), plain text (`.txt`), RTF (best-effort text extraction) and DOCX (`.docx`, `.docm`, `.dotx`). The longest matching extension wins, then exact MIME types, then `priority`, then the most recent registration.

```ts
import { importFile, registerImportAdapter, getImportAccept } from "@pixerate/editor";

const { adapterId, result } = await importFile(file); // result: { html, text }
input.accept = getImportAccept("document");

// Other formats are pluggable:
registerImportAdapter({
  id: "odt",
  label: "OpenDocument text",
  mimeTypes: ["application/vnd.oasis.opendocument.text"],
  extensions: [".odt"],
  target: "document",
  async import(_file, ctx) {
    const html = await myOdtToHtml(await ctx.readArrayBuffer());
    return { html, text: htmlToPlainText(html) };
  },
});
```

### DOCX, PDF and zipped exports (no extra dependencies)

- **DOCX** (built in): `docxImportAdapter` reads `word/document.xml` (located via `_rels/.rels`), styles, numbering, relationships and footnotes / endnotes with the platform `DOMParser`, and maps headings (`Heading1`–`6`, `Title`, outline levels), bold / italic / underline / strike / super- and subscript, hyperlinks (including `HYPERLINK` fields), nested bulleted / numbered lists, tables (`colspan` / `rowspan`, header rows), line breaks, tabs and embedded PNG / JPEG / GIF / WebP images (as data URLs; dropped by the editor when the image extension is off). Output goes through `sanitizeImportedHtml`. **Tracked changes are imported as if accepted** (`w:ins` kept, `w:del` dropped); `createDocxImportAdapter({ trackedChanges: "original" })` imports them as if rejected. Text boxes, shapes, charts, equations, comments and layout are not imported. Without a global `DOMParser` (plain Node) it throws `ImportError("unsupported_environment")`; pass one with `createDocxImportAdapter({ DOMParser })`. Other options: `images`, `maxImageSize` (10 MiB), `zip` limits.
- **PDF** (opt-in, bring your own pdf.js): `registerImportAdapter(createPdfImportAdapter(pdfjs))` with any object shaped like `pdfjs-dist` (`getDocument({ data }).promise`, `page.getTextContent()`). Text items are grouped into lines by baseline and into paragraphs by larger-than-usual vertical gaps or blank lines; options `paragraphGap`, `maxPages`, `documentParams`. Text only. `pdfTextItemsToParagraphs` is exported for custom adapters.
- **Zipped exports** (opt-in): `registerImportAdapter(zipImportAdapter)` imports a `.zip` of markdown / HTML / text / DOCX files (Notion, Confluence, Obsidian exports) with the registry's other adapters — index / README files first, then natural path order — with a heading per file (Notion ids stripped from titles). The result adds `files` and `skipped` (unsupported types, nested archives, failures). Not registered by default because `.zip` is a generic container: claiming every dropped archive would steal drops from other handlers. `createZipImportAdapter({ headings, headingLevel, maxFiles, registry, zip })` customizes it.
- **ZIP reader**: `readZip(bytes, { maxEntries, maxTotalSize, unsafePaths })` parses the central directory (ZIP64 included) and lazily extracts stored / deflate entries via `DecompressionStream("deflate-raw")` (browsers, Node 18+), verifying CRC-32. It rejects encrypted entries, `..` / absolute names and archives over the entry or uncompressed-size caps (default 10 000 entries / 256 MiB, enforced on inflated bytes) with typed `ZipError`s. DOCX reads use 100 MiB / 5 000 entries.

`FileImport` (or `createRichTextPreset({ fileImport: true })`) inserts dropped or pasted files at the drop position, and `FileImportController` / `pickImportFiles` back file-picker buttons. `RichClipboard` (or `richClipboard: true`) also writes copied content as `application/x.pixerate.document+json` (ProseMirror slice JSON plus a schema signature) and prefers it on paste when the schemas match, falling back to HTML / plain text. Both are opt-in, and `EditorController` keeps them on plain text in `plainTextMode`.

## Agent tool registry

`ToolRegistry` (`@pixerate/editor/agent`) collects MCP-shaped tools from live providers, for example one per mounted editor or spreadsheet. `listTools()` and `callTool()` return MCP `tools/list` / `tools/call` result shapes, arguments are validated against each tool's `inputSchema`, and `onListChanged` fires (coalesced) when providers come and go.

Each provider is a toolset. Its tools are exposed as `<namespace>__<name>`, where the namespace is the provider's `namespace` or else its `id` (`doc__get_text`, `sheet__set_range`), so a name never changes when another editor mounts. `callTool`, `hasTool` and `getTool` also take the bare name when only one tool has it. Pass `namespace: ''` on a provider for bare names (prefixed with the id only on a collision), or `new ToolRegistry({ namespaces: 'on-collision' })` for that across the registry. Providers also carry a `title`, `description` and `skill`, which `registry.toolsets()` reports.

```ts
import { ToolRegistry, createRichTextToolProvider, createSpreadsheetToolProvider } from "@pixerate/editor/agent";

const registry = new ToolRegistry();
const unregister = registry.register(createRichTextToolProvider(controller, { id: "doc" }));
registry.register(createSpreadsheetToolProvider(sheet, { id: "sheet", namespace: "sheet" }));
registry.onListChanged((tools) => server.sendToolListChanged());

await registry.callTool("doc__insert_text", { text: "Hello" }); // { content: [...], structuredContent }
```

### Large catalogues: scoped views and discovery

With every editor mounted the registry holds hundreds of tools, which costs a model context and makes the right one harder to pick. `registry.view(options)` is a filtered tool source to serve instead:

- `toolsets: ['chart']` (or a predicate) shows only those toolsets; call `view.setToolsets()` as the user switches editors.
- `readOnly: true` shows only tools annotated `readOnlyHint`. Tools outside a view are refused with the reason.
- `discovery: { skills }` lists only `list_toolsets`, `search_tools`, `enable_tools`, `disable_tools` and (with skill files) `get_skill` at first. The agent searches by task, enables the tools it needs, and the view announces each change through `onListChanged`. `searchTools(tools, toolsets, query)` is the ranking `search_tools` uses.

```ts
import { createMcpServer, toolsetInstructions } from "@pixerate/editor/tools";
import { loadSkillFiles } from "@pixerate/editor/bridge"; // Node; in a browser import the .md files as text

const skills = loadSkillFiles();
const view = registry.view({ discovery: { skills } });
const server = createMcpServer(view, { name: "my-app", version: "1.0.0", instructions: toolsetInstructions, skills, send });
```

`createMcpServer({ skills })` also serves the skills as MCP prompts and `skill://<name>/SKILL.md` resources. `useToolRegistryView` (React and Svelte) makes a view for a component's lifetime, and `useToolBridge` accepts one.

Built-in providers:

| Provider | Tools |
| :--- | :--- |
| `createRichTextToolProvider(editor, { id })` | `get_text` (`format`, `blocks: true` for every paragraph's positions), `find_text`, `insert_text`, `replace_text` (all matches or the n-th, one undo step), `replace_range`, `replace_selection`, `set_selection`, `format_text` (inline marks: bold, italic, links, colour…), `set_block_type` (paragraph, heading, lists, quote, code block), `set_text_align` (each as far as the schema supports it), `edit_table` (when tables are on). Read-only editors get `get_text` and `find_text`. |
| `createSpreadsheetToolProvider(controller, { id })` | `get_range`, `set_cell`, `set_range` (2D block, one undo step, refuses read-only targets), `insert_rows`, `delete_rows`, `insert_columns`, `delete_columns`, `merge_cells`, `unmerge_cells`, `transpose_range` (on an A1 range, not the user's selection) |
| `createEditorMcpToolProvider({ id, getSnapshot, applySteps })` | `get_editor_state`, `canvas_add_node`, `canvas_remove_nodes`, `canvas_connect`, `canvas_update_node`, `canvas_layout`, `canvas_select`, `canvas_highlight`, `prompt_insert_text`, `prompt_replace_range`, `prompt_set_variable`, `prompt_select`, `view_editor` (with `captureView`) |
| `createCanvasComponentToolProvider`, `createCommandToolProvider`, `createImageEditorToolProvider`, `createGenerationToolProvider` | See the canvas, commands, image editor and generation docs |

Text tools take ProseMirror document positions, not plain-text offsets: `find_text` and `get_text { blocks: true }` return them. The canvas tools check node ids against `getSnapshot()` (unknown ids, an id that already exists, self-edges and unordered ranges are tool errors the model can fix) and return what they created: `{ applied, steps, created: { nodes: [{ id, position }], edges: [{ id, source, target }] } }`. Pass `toolStyle: "combined"` for the older `edit_canvas` / `edit_prompt` tools with an `operation` argument, and `surfaces: { canvas: false }` to expose only the prompt tools. `planToolCall` turns any tool call into planner steps (`step:tool_call` for registry tools), and `validateAgentCommand` runs the same checks for hosts that drive the planner directly.

Tool `inputSchema`s are validated by `validateJsonSchema`, which supports `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minItems` / `maxItems`, `uniqueItems`, `minimum` / `maximum`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf`, `minLength` / `maxLength`, `pattern`, `anyOf`, `oneOf`, `allOf`, `not` and local `$ref`s (`#/$defs/...`). Other keywords are ignored.

### Serving the registry over MCP

`createMcpServer(registry, { name, version, send })` (in `/tools`, no dependencies) answers MCP JSON-RPC messages from any transport: stdio lines, a WebSocket, `postMessage` or an HTTP handler. It handles `initialize` (protocol version negotiation), `ping`, `tools/list`, `tools/call`, with `skills` `resources/list` / `resources/read` / `prompts/list` / `prompts/get`, and `notifications/cancelled` (aborts the call's `signal`), and sends `notifications/tools/list_changed` through `send` once the client is initialized.

```ts
import { createMcpServer } from "@pixerate/editor/tools";

const server = createMcpServer(registry, { name: "my-app", version: "1.0.0", send: (msg) => socket.send(JSON.stringify(msg)) });
socket.onmessage = async (event) => {
  const response = await server.handle(event.data);
  if (response) socket.send(JSON.stringify(response));
};
```

### Without TipTap: `@pixerate/editor/tools`

`@pixerate/editor/agent` loads TipTap, ProseMirror and (through the canvas planner) dagre, because the rich-text, spreadsheet and canvas providers live there. Hosts that only need the registry, such as a canvas-only app or an effect editor exposing commands, can import it from `@pixerate/editor/tools`, which has no third-party imports:

```ts
import { createToolRegistry } from "@pixerate/editor/tools";
import { createCommandToolProvider } from "@pixerate/editor/commands";

const registry = createToolRegistry();
registry.register(createCommandToolProvider(commands, { id: "effects" }));

const list = registry.listTools(); // MCP tools/list result
const result = await registry.callTool(name, args); // MCP tools/call result
```

It exports `ToolRegistry`, `createToolRegistry`, `ToolRegistryError`, the tool types (`AgentTool`, `AgentToolProvider`, `AgentToolHandler`, `ToolCallContext`, `McpToolDefinition`, `McpToolResult`, `McpListToolsResult`, `ToolCallError`), `validateJsonSchema` / `SchemaValidationError`, the static tool definitions (`EDITOR_MCP_TOOLS`, `EDITOR_CANVAS_TOOLS`, `EDITOR_PROMPT_TOOLS`) and `createMcpServer`. `/agent` re-exports all of it, so existing imports keep working. `createEditorMcpToolProvider` stays in `/agent` because its `layout` operation runs dagre.

### Agent skills

The package ships an [Agent Skill](https://agentskills.io) per editor domain in `skills/` (`pixerate-chart`, `pixerate-video-editor`, ...) plus `pixerate-agent-tools` for what they share. Each tells a model when and how to use every tool and command of its domain and the practice an expert would follow. Copy them into your agent's skills folder:

```bash
cp -R node_modules/@pixerate/editor/skills/* .claude/skills/
```

See [`skills/README.md`](./skills/README.md) for the list.

## Commands, shortcuts and the command palette

`@pixerate/editor/commands` gives every action one id that menus, keyboard shortcuts, the command palette and agents all run, so they share enablement and parameter validation. It has no third-party imports.

```ts
import {
  CommandRegistry,
  createHistoryCommands,
  createArrangeCommands,
  createCommandToolProvider,
  formatShortcut,
} from "@pixerate/editor/commands";

const commands = new CommandRegistry({ history }); // `history` makes `undoable` commands one undo step
commands.register(createHistoryCommands(history)); // history.undo (Mod+Z), history.redo (Mod+Shift+Z, Mod+Y off macOS)
commands.register(createArrangeCommands(arrange, { getSelectedIds })); // canvas.alignLeft (Alt+A), … scoped to "canvas"
commands.register({
  id: "doc.insertDate",
  label: "Insert Date",
  group: "Insert",
  shortcut: "Mod+Shift+D",
  params: { type: "object", properties: { format: { type: "string" } } },
  enabled: (ctx) => (ctx.editable ? true : "The document is read-only."),
  run: (ctx, { format }) => ctx.insertDate(format),
});

commands.execute("doc.insertDate", { fmt: "iso" });
// { ok: false, code: "invalid_params", message: 'Unknown parameter "fmt" for command "doc.insertDate"; expected "format".' }
commands.list({ scope: "canvas" }); // entries with shortcuts, enabled and disabledReason
window.addEventListener("keydown", (e) => commands.handleKeyDown(e, { scopes: ["canvas"] }));
formatShortcut("Mod+Shift+Z", "mac"); // "⇧⌘Z" ("Ctrl+Shift+Z" on Windows / Linux)
```

- **Results**: `execute` never throws. It returns `{ ok: true, result }` or `{ ok: false, code: "unknown_command" | "disabled" | "invalid_params" | "failed", message }`. `enabled(ctx, params)` returns `true` or a reason string, and receives the params the caller passed, so a command that acts on the selection can still run on ids passed in params. `executeAsync` awaits async commands.
- **Shortcuts** (`registry.shortcuts`, a `ShortcutMap`): chords are platform-neutral (`Mod` is ⌘ on macOS and Ctrl elsewhere) and match `event.code`, so Option/Alt chords work on macOS. Letter keys follow Latin layouts such as AZERTY. Bindings can be scoped (`scope: "canvas"`), and scoped bindings win over global ones. Events from inputs and editors are ignored unless `allowInEditable` is set. `setOverride` / `getOverrides` store user remaps, and `findConflicts(platform)` reports chords that collide on a platform (e.g. `Mod+Y` and `Ctrl+Y` collide off macOS).
- **Palette**: `rankCommands(query, entries, { recents })` does subsequence fuzzy ranking over label, group, keywords and id. Exact matches come first, and an empty query lists recent commands first. `createCommandPaletteController(registry)` holds the palette state that the React and Svelte `<CommandPalette>` components render.
- **Agents**: `createCommandToolProvider(registry)` adds `list_commands`, `run_command` and `run_commands` to a `ToolRegistry`, with complete MCP annotations. `run_commands` runs steps in order but is **not atomic**: steps that succeeded before a failure stay applied. To get all-or-nothing behaviour, register one `undoable` command that runs the steps.

## Generation models, planning and provenance

`@pixerate/editor/generation` describes generative models as data, checks a request against a model before it is sent, and records what produced each output. It reaches only the grammar and the agent tool-registry modules, so it has no third-party imports.

```ts
import {
  planGenerationRequest,
  capabilitiesToJsonSchema,
  createGenerationToolProvider,
  createProvenance,
  recreateRequest,
  estimateJobProgress,
  expectedDurationFor,
  type ModelCapabilities,
} from "@pixerate/editor/generation";

const model: ModelCapabilities = {
  id: "img-xl",
  media: "image",
  prompt: { maxLength: 1000 }, // counted after templates/variables resolve (countResolved defaults to true)
  negativePrompt: true,
  aspectRatios: { options: ["9:16", "1:1", "16:9"], default: "1:1" },
  quality: { options: ["draft", "standard", "high"] },
  count: { max: 4, options: [1, 2, 4] },
  references: { roles: { style_ref: { max: 2 }, character_ref: { max: 1 } }, maxTotal: 2 },
  params: { guidance: { type: "number", min: 1, max: 10, step: 0.5 } },
  timing: { baseMs: 12_000, perItemMs: 4_000 },
};

const plan = planGenerationRequest({ aspectRatio: "21:9", count: 3 }, model, { strategy: "downgrade", resolvedPrompt });
// plan.request: { model: "img-xl", aspectRatio: "16:9", count: 2 }
// plan.adjustments: [{ field: "aspectRatio", from: "21:9", to: "16:9", kind: "snapped", reason }, { field: "count", … }]
```

- **Strategies**: `nearest` (default) snaps enum values to the closest option, clamps and rounds ranges, truncates text and reference lists, and drops unsupported fields and references, reporting each change. Ties go to the higher value, or to the lower one with `downgrade`. `upgrade` also breaks ties upwards but does not drop references the model cannot use: that is an error, as is a text-only model given image references. `error` changes nothing and reports every mismatch. Missing required references, unsupported modes (`edit` / `inpaint`) and a model mismatch are always errors. Planning is pure and deterministic.
- **Schema and agents**: `capabilitiesToJsonSchema(model)` builds a strict request schema (enums, `minimum` / `maximum`, `maxItems`, and descriptions for per-role limits) that `validateJsonSchema` checks. `createGenerationToolProvider({ models, generate, estimate? })` adds `list_models`, `plan_generation` and `estimate_generation` (read-only) and `generate` (destructive) to a `ToolRegistry`. `generate` requires an `idempotencyKey`: a retry with the same key and arguments returns the first result (or joins it while it is still running) instead of generating again. `createGenerationHistoryToolProvider({ store, models?, templates?, assets? })` lets an agent use the generation history: `list_generations`, `get_generation`, and `recreate_generation` / `vary_generation`, which return a request (with drift) to pass to `generate` rather than spending themselves. `mergeCapabilities(remote, overlay)` keeps server capability values and takes only presentation fields (`name`, `description`, `badges`, `icon`, `group`) and overlay-only models from the overlay.
- **Provenance**: `createProvenance({ rawPrompt, templates, bindings, values, model, plan })` pins the exact bodies and versions of every template the prompt reached, and records the variable values, the resolved prompt with its source map, the planned settings, adjustments and references. `serializeProvenance` / `parseProvenance` are versioned. `recreateRequest(provenance)` returns the request that was sent, and `replayProvenancePrompt` re-resolves the prompt from the pinned bodies.
- **Lookups and progress**: `createBatchResolver({ fetch, maxBatch, delayMs })` batches and dedupes lookups; a failed batch resolves its keys as empty instead of retrying. `estimateJobProgress({ startedAt, now, expectedMs })` returns a time-based percent that stays at or below 95 until `done`, and a label such as `~2m left` or `Almost done…`. `expectedDurationFor(model, request)` uses the model's `timing`.
- **Forms**: `getGenerationControls(model)` and `getReferenceSlots(model, request)` describe the controls that the React and Svelte `<GenerationSettings>` render.

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

## Image selections and masks

`@pixerate/editor/image-editor` has Photoshop-style selections. A selection is a `SelectionMask`: one 8-bit coverage value per source pixel (natural image pixels, the same space as the crop box), with `bounds`, treated as immutable.

```ts
const editor = new ImageEditorController({ image });
await editor.magicWand({ x: 120, y: 80 }, { tolerance: 32, contiguous: true, mode: "add" });
editor.selectEllipse({ x: 40, y: 40, width: 200, height: 120 }, { mode: "subtract", feather: 2 });
editor.modifySelection("grow", 4); // grow | shrink | feather | border | smooth

// A coarse AI segmentation (any size, white = selected), snapped to the image's edges.
await editor.loadSelectionFromImage(maskDataUrl);
await editor.refineSelection({ radius: 12, smartRadius: true, contrast: 20 });

// Use it as an adjustment layer mask; density and feather stay editable.
const id = editor.addAdjustmentLayer("hueSaturation");
editor.applySelectionAsLayerMask(id, { feather: 3 });
editor.setAdjustmentLayerMaskProps(id, { density: 0.6 });
```

- **Tools**: `magicWand` (scanline span fill with an explicit stack; RGB or perceptual ΔE tolerance; contiguous or global; optional `sampleMerged`), `colorRange` (samples, fuzziness, localized clusters), `toneRange`, `hueRange`, `rectSelection`, `ellipseSelection`, `polygonSelection` (anti-aliased).
- **Modes**: `replace`, `add` (max), `subtract`, `intersect` (min), on 8-bit values; Shift / Alt map to add / subtract (`selectionModeFromModifiers`).
- **Modify**: grow / shrink through an exact Euclidean distance transform, border, smooth (box + threshold), feather (Gaussian, σ = radius, three box passes above σ 8). All linear in the pixel count.
- **Refine Edge**: `refineSelection(pixels, mask, { radius, smartRadius, smooth, feather, contrast, shiftEdge })`, a colour guided filter in a band around the edge, confined to the mask's bounds plus a halo.
- **Layer masks**: `AdjustmentLayer.mask` (`{ width, height, rle, density?, feather?, enabled? }`) scales the layer's opacity per pixel; it is resampled through the crop / rotation / flips like the image. `selectionFromLayerMask` loads it back.
- **Document**: `toJSON()` adds `selection` (run-length encoded, `r1:` + base64) only when something is selected, and layers only carry `mask` when they have one, so selection- and mask-free documents serialize exactly as before. Selections are part of undo history. `renderMask()` / `toMaskDataURL()` include the selection for inpainting.
- **Viewport**: marching ants by default, `quickMask` tints the unselected area; `RenderOptions.selectionDisplay` overrides, `draftSelectionPath` shows a shape being drawn. `SelectionGesture` turns pointer events into selections for UIs.
- **Agent tools**: `createImageEditorToolProvider` adds `get_selection`, `select_region`, `select_by_color`, `modify_selection`, `refine_selection` and `apply_selection_as_mask`, plus `get_image_info`, `get_histogram`, `update_adjustment_layer`, `move_adjustment_layer`, `remove_adjustment_layer`, `set_crop`, `reset_crop`, `set_rotation`, `flip_image`, `undo_image` and `redo_image`.
- **Pixels**: the tools read the source image through a canvas; pass `setSamplePixels(imageData)` (or `{ pixels }` per call) where there is no canvas or the image is cross-origin.

## Spreadsheet sheets, defined names and LAMBDA

A `SpreadsheetController` is a workbook. Created from one `document` it has a single sheet and behaves as before (`controller.document` is the active sheet); pass `workbook` for several sheets.

```ts
import { SpreadsheetController } from "@pixerate/editor/spreadsheet";

const sheet = new SpreadsheetController({ document: { name: "Sales" } });
sheet.addSheet({ name: "Summary" });            // activates it; returns its id
sheet.defineName("Revenue", "=Sales!$F$2:$F$11");
sheet.defineName("WithTax", "=LAMBDA(x, x*1.2)");
sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, "=WithTax(SUM(Revenue))");
sheet.renameSheet("Sales", "Sales 2026");        // formulas become ='Sales 2026'!…
sheet.getWorkbook();                             // { sheets, activeSheetId, names }: save every sheet
```

**Saving.** Either save `getWorkbook()` (every sheet, with all names in `names`) and load it with `{ workbook }` / `loadWorkbook`, or keep saving the document passed to `onDocumentChange` and load it with `{ document }` / `loadDocument`: each sheet document's `names` holds the workbook-scoped names plus that sheet's own sheet-scoped names (any `sheetId` there means "this sheet"), so a single-sheet app round-trips names (LAMBDA names included) without changes. When a workbook is loaded, `workbook.names` wins over names repeated in `sheets[*].names`, and names found only in sheet documents are added (first sheet wins). `getWorkbook()` keeps names in `names` only. Documents and workbooks saved before names existed load as before.

Formulas reference other sheets (`Sheet2!A1`, `'My Sheet'!A1:B2`, `Data!A1#`) and 3-D ranges (`SUM(Sheet1:Sheet3!A1)`). Deleting a sheet turns references to it into `#REF!`; inserting or deleting rows and columns rewrites references from every sheet. Names can be workbook- or sheet-scoped (`{ sheet }`), are validated like Excel (`validateDefinedName`), and `renameName` rewrites the formulas using them. `LAMBDA` values can be called inline (`=LAMBDA(x, x+1)(2)`), stored with `LET` or a name (recursion is capped at 1000 calls with `#NUM!`), or passed to `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL` and `MAKEARRAY`. Undo restores the sheet a step changed (switching to it) or, for sheet and name operations, the whole workbook.

## Spreadsheet conditional formatting and data validation

Rules live in the sheet's `document.table` (`conditionalFormats`, highest priority first, and `dataValidations`), so they are saved, undone and redone with the sheet, and their ranges and formulas follow inserted and deleted rows and columns.

```ts
import { SpreadsheetController, createConditionalFormatRule } from "@pixerate/editor/spreadsheet";

const sheet = new SpreadsheetController({ document });
const all = { startRow: 1, startCol: 0, endRow: 20, endCol: 3 };
sheet.addConditionalFormat({ type: "expression", formula: "=$D2>100", style: { fill: "#c6efce" }, ranges: [all] });
sheet.addConditionalFormat(createConditionalFormatRule({ kind: "dataBar", ranges: [{ ...all, startCol: 3, endCol: 3 }] }));
sheet.getConditionalFormat(4, 3); // { fill, dataBar: { fraction, color, gradient }, ... } or undefined

sheet.addDataValidation({ ranges: [{ ...all, endCol: 0 }], type: "list", formula1: "North,South,East,West", errorStyle: "warning" });
sheet.startEditing(1, 0, "Mars");
const result = sheet.commitEditing(); // { status: "confirm", prompt } — the editor stays open
sheet.resolveValidationPrompt("cancel"); // or "accept" (warning / information) / "retry"
sheet.findInvalidCells(); // "circle invalid data"
```

`evaluateConditionalFormats(sheet, rules)` and `validateCellInput(sheet, rules, row, col, input)` also work on any grid through the small `ConditionalFormatSheet` / `DataValidationSheet` interfaces. Rule formulas are written for the top-left cell of the first range and shift for other cells; custom validation formulas see the value being entered. `setCellValue`, paste and import never validate (as in Excel); `commitEditing` and `commitCellInput` do.

## Large spreadsheets: incremental recalculation and virtualised rendering

The dependency graph stores each range a formula reads once, in an interval index per column (wide ranges in a per-sheet index), instead of one key per cell, so `=SUM(A1:A50000)` and `=SUM(A:A)` are one entry each. An edit finds the formulas reading the cell in O(log n + k), recalculates only that dirty subgraph in topological order (a range read by many formulas is resolved once per recalculation), and still detects cycles, re-spills dynamic arrays, follows sheet-qualified, 3-D and defined-name references and recalculates volatile functions (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, `RANDARRAY`) on every edit. CSV import, `loadWorkbook` and large pastes register the cells and evaluate each formula once; a single-cell edit is undone without a whole-sheet snapshot. `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` read their ranges without materialising blank cells.

```ts
sheet.setCellValue(rowId, colId, "42");
sheet.getRecalculationStats(); // { evaluated: 1, planned: 2, passes: 1 }: deterministic work counts
sheet.depGraph.getIndexStats(); // { formulas, cellEdges, rangeEntries, volatile }
```

`measureSpreadsheetView`, `getSpreadsheetViewWindow` and `getSpreadsheetScrollToCell` work out which displayed rows and columns to render for a scroll position (frozen rows and columns always, merges crossing the edge whole) and how far to scroll to show the active cell. The React and Svelte `SpreadsheetEditor` use them for sheets with more than 200 displayed rows or 60 columns (`virtualize` prop: `'auto'`, `true` or `false`). `packages/core/tests/spreadsheet-recalc.bench.test.ts` measures 50k-cell sheets (`SPREADSHEET_BENCH=1`).

## Other modules

Each module is also available as a subpath import:

| Import | Contents |
| :--- | :--- |
| `@pixerate/editor/grammar` | Tokenizer, resolver, sourcemaps. No TipTap or DOM dependencies, so it is safe for Node.js, workers and serverless functions. |
| `@pixerate/editor/serializers` | Plain text, markdown and mention serializers |
| `@pixerate/editor/extensions` | Headless TipTap extensions |
| `@pixerate/editor/history` | `HistoryManager`: a command-pattern undo/redo stack with gesture merge keys, undo marks, a byte budget and a History-panel listing; `DirtyTracker` / `bindDirtyToHistory` |
| `@pixerate/editor/spreadsheet` | `SpreadsheetController`, formula parser/evaluator and dependency graph, formula function registry (`registerFormulaFunction`, `listFormulaFunctions`, `searchFormulaFunctions`, `getFormulaSignature`) and autocomplete helpers (`getFormulaHints`, `applyFormulaSuggestion`) |
| `@pixerate/editor/image-editor` | `ImageEditorController` and Canvas 2D renderer: crop, adjustments, annotations, depth masks, selections and layer masks, and AI hooks. Needs a DOM/canvas environment (the selection algorithms themselves are pure). |
| `@pixerate/editor/animation` | The keyframe model without canvas nodes: `AnimationTrack` / `AnimationKeyframe`, easing (`resolveEasing`, `evaluateEasing`, `cubicBezierAt`, `springAt`, presets, `parseCssEasing`, `easingToCss`), `evaluateTrack`, `interpolateAnimationValue`, `normalizeKeyframes`, OKLab colour mixing, `AnimationPlayer` and the `Clock` / `ManualClock` / `realClock` time sources (no third-party imports) |
| `@pixerate/editor/canvas` | Node-graph layout (needs the optional `@dagrejs/dagre` peer), placement, trajectories, displacement, clipboard and streaming layout helpers, and node keyframe animation (re-exports everything in `/animation`) |
| `@pixerate/editor/agent` | MCP tool schemas, a planner for agent-driven canvas edits, and the dynamic `ToolRegistry` with editor/spreadsheet tool providers |
| `@pixerate/editor/tools` | `ToolRegistry`, tool types, `validateJsonSchema` and the static MCP tool definitions, without TipTap or dagre (no third-party imports) |
| `@pixerate/editor/commands` | `CommandRegistry`, `ShortcutMap`, palette ranking, `createCommandToolProvider` and built-in history / arrange / spreadsheet commands (no third-party imports) |
| `@pixerate/editor/persistence` | Autosave and crash recovery (`createAutosaveController`, `createRecoveryPolicy`, `createRevisionTracker`), storage adapters (memory, localStorage, IndexedDB, OPFS), document migration (`migrateDocument`, `loadSections`, `LoadReport`), and the editor document contract: `EditorDocument` / `defineEditorDocument`, files (`serializeEditorDocument`, `parseEditorDocument`), `createEditorAutosave`, named saves (`createEditorDocumentStore`) and the shared agent tools (`createDocumentToolProvider`) (no third-party imports) |
| `@pixerate/editor/generation` | Model capability descriptors, `planGenerationRequest`, `capabilitiesToJsonSchema`, `createGenerationToolProvider`, provenance, `createBatchResolver` and job-progress estimates (no third-party imports) |
| `@pixerate/editor/compare` | `diffSequences` (Myers + patience), `compareDocuments` and `compareHtml`: two versions of a document as tracked changes (also re-exported from the root entry) |
| `@pixerate/editor/export` | Word export: `exportDocx`, `exportDocxBlob`, `createDocxParts`, `DocxExportController`, plus the zip writer and XML escapers it uses (no third-party imports; also re-exported from the root entry) |
| `@pixerate/editor/tokens` | Design tokens: collections, modes, aliases, `TokenStore`, `resolveToken`, W3C Design Tokens JSON and CSS custom-property export (no third-party imports) |
| `@pixerate/editor/vector` | Headless vector editor: `VectorDocument` (Bézier paths with corner / smooth / symmetric anchors, groups, gradients), `VectorEditorController` (select, direct select, pen, pencil and shape tools driven by pointer / key events; transforms, booleans, align, group, undo, viewport), scene and overlay render data, DOM-free `parseVectorSvg` / `vectorDocumentToSvg` and `createVectorCommands` for agents (no third-party imports; see [the vector editor guide](../../docs/vector-editor.md)) |
| `@pixerate/editor/chart` | Headless chart editor: `ChartSpec` (bar, line, area, scatter, pie, donut, combos, stacking) with `normalizeChartSpec`, the DOM-free `layoutChart` scene (drawing primitives with click targets), `ChartController` (data and presentation edits, selection, drag gestures, undo), `chartToSvg`, CSV / table import and `createChartCommands` for agents (no third-party imports; see [the chart editor guide](../../docs/chart-editor.md)) |
| `@pixerate/editor/parameters` | Schema-driven parameters editor for effects, shaders, generators and component props: `ParameterSchema` (number, int, boolean, choice, color, vector, image and text fields; groups; `showIf`), `ParametersController` (validation, undo with merged slider gestures, reset, randomize, presets, keyframe hooks), `createParameterCommands` for agents and `parameterSchemaFromShaderControls` (no third-party imports) |

The root entry (`@pixerate/editor`) re-exports everything except animation, canvas, agent, commands, persistence, generation, tokens, parameters, vector, chart and image editor, including TipTap. Import from the narrowest subpath you need: `grammar`, `history`, `animation`, `spreadsheet`, `commands`, `persistence` and `image-editor` have no third-party imports, so a spreadsheet-only app bundles no TipTap, markdown or dagre code. The package is marked `sideEffects: false`, so unused root exports are also tree-shaken.

## Keyframe animation without the canvas

`@pixerate/editor/animation` is the keyframe model on its own: no dagre, TipTap or canvas nodes. Use it to animate anything you can describe as a track of numbers or CSS colours.

```ts
import { evaluateTrack, createAnimationPlayer, ManualClock, type AnimationTrack } from "@pixerate/editor/animation";

const opacity: AnimationTrack = {
  keyframes: [
    { time: 0, value: 0, easing: "ease-out" },
    { time: 600, value: 1, easing: { type: "spring", stiffness: 170, damping: 26 } },
    { time: 1200, value: 0.5 },
  ],
};
evaluateTrack(opacity, 300); // eased value at 300 ms
evaluateTrack({ keyframes: [{ time: 0, value: "#ff0000" }, { time: 1000, value: "transparent" }] }, 500, "color"); // OKLab mix

const player = createAnimationPlayer({ clock: new ManualClock(), duration: 1200, loop: "ping-pong", onTime: (t) => console.log(evaluateTrack(opacity, t)) });
```

`@pixerate/editor/canvas` re-exports all of it, and adds node tracks (`evaluateAnimation`, `applyAnimation`), editing, timeline and export helpers on top.

## Autosave, crash recovery and document migration

```ts
import {
  createAutosaveController,
  createIndexedDbAdapter,
  createRevisionTracker,
  formatRecoveryMessage,
} from "@pixerate/editor/persistence";

const revisions = createRevisionTracker({ history, dirty: bindDirtyToHistory({ history, getValue }) });
const autosave = createAutosaveController({
  storage: createIndexedDbAdapter("my-app"), // or createLocalStorageAdapter / createOpfsAdapter / createMemoryStorage
  key: "doc-42",
  getSnapshot: () => doc,
  revision: revisions.revision,
  savedRevision: revisions.savedRevision,
  name: "Quarterly plan",
});
revisions.subscribe(() => autosave.notify());

const recovered = await autosave.checkRecovery(); // { snapshot, meta: { time, name, revision } } | null
if (recovered && confirm(formatRecoveryMessage(recovered.meta))) load(recovered.snapshot);
else if (recovered) await autosave.discardRecovery();
autosave.ready(); // hydration gate: nothing is written before this
addEventListener("pagehide", () => autosave.flushNow());
// after an explicit save: autosave.markClean() retires the snapshot, but only one this session wrote
```

Snapshots are written `debounceMs` after the last edit and at least every `interval` while edits keep coming; failed writes retry with exponential backoff (`retryBaseMs` doubling to `retryMaxMs`). `createRecoveryPolicy` is the pure, clock-injected state machine behind it.

`migrateDocument(json, { currentVersion, steps: { 1: (doc) => … } })` upgrades stored JSON one version at a time and returns a `LoadReport`: `migratedFrom`, `readOnly` (a newer version, or a failed step: show it but never save over it) and `unknownKeys`. `loadSections(doc, { key: { parse, defaults } })` falls back to defaults one section at a time and keeps unknown keys; `loadDocument` does both. `loadImageEditorDocument(json)` (`@pixerate/editor/image-editor`) applies them to `SerializedImageEditorState`.

## History gestures, marks and dirty tracking

```ts
import { HistoryManager, bindDirtyToHistory } from "@pixerate/editor/history";

const history = new HistoryManager({ maxDepth: 200, maxBytes: 32 << 20, sizeOf: (c) => c.byteSize ?? 0 });

// A drag is one undo step, however long it lasts. Any other recorded command,
// undo, redo or endGesture() ends it.
history.executeMerged(setOpacity(0.4), { key: "opacity-slider" });
history.executeMerged(setOpacity(0.5), { key: "opacity-slider" });

// Hold a gesture: every merged execute until endGesture() joins one step.
history.beginGesture("automation-pass");
/* ... */
history.endGesture();

// Escape-cancel: take back everything since the drag started, with no redo left behind.
const mark = history.mark();
/* ... drag ... */
history.revertTo(mark); // returns the number of steps reverted (0 if the mark is gone)

// History panel
history.getEntries(); // [{ id, label, index, current, undone }]
history.goTo(2); // undo / redo until entry 2 is current; goTo(-1) undoes everything

// Dirty vs saved: undoing back to the saved state is clean again.
const dirty = bindDirtyToHistory({
  history,
  getValue: () => doc,
  normalize: ({ selection, viewport, ...rest }) => rest, // selection/zoom never dirty
});
dirty.suppress(() => loadFromDisk()); // programmatic loads don't mark dirty (re-entrant)
dirty.markClean(); // after saving
dirty.dirty; // feed to useNavigationGuard / createNavigationGuard
```

Tag-only `executeMerged(cmd)` keeps its 300 ms time-window coalescing. React exposes the same API through `useHistory()` (`entries`, `goTo`, `mark`, `revertTo`, `beginGesture`, `endGesture`) and `useHistoryDirty()`; Svelte through `createHistory()` and `createHistoryDirty()`.

## License

MIT
