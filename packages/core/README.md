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
| `@pixerate/editor/history` | `HistoryManager`: a command-pattern undo/redo stack with gesture merge keys, undo marks, a byte budget and a History-panel listing; `DirtyTracker` / `bindDirtyToHistory` |
| `@pixerate/editor/spreadsheet` | `SpreadsheetController`, formula parser/evaluator and dependency graph, formula function registry (`registerFormulaFunction`, `listFormulaFunctions`, `searchFormulaFunctions`, `getFormulaSignature`) and autocomplete helpers (`getFormulaHints`, `applyFormulaSuggestion`) |
| `@pixerate/editor/image-editor` | `ImageEditorController` and Canvas 2D renderer: crop, adjustments, annotations, depth masks and AI hooks. Needs a DOM/canvas environment. |
| `@pixerate/editor/canvas` | Node-graph layout (needs the optional `@dagrejs/dagre` peer), placement, trajectories, displacement, clipboard and streaming layout helpers |
| `@pixerate/editor/agent` | MCP tool schemas, a planner for agent-driven canvas edits, and the dynamic `ToolRegistry` with editor/spreadsheet tool providers |
| `@pixerate/editor/commands` | `CommandRegistry`, `ShortcutMap`, palette ranking, `createCommandToolProvider` and built-in history / arrange / spreadsheet commands (no third-party imports) |

The root entry (`@pixerate/editor`) re-exports everything except canvas, agent, commands and image editor, including TipTap. Import from the narrowest subpath you need: `grammar`, `history`, `spreadsheet`, `commands` and `image-editor` have no third-party imports, so a spreadsheet-only app bundles no TipTap, markdown or dagre code. The package is marked `sideEffects: false`, so unused root exports are also tree-shaken.

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
