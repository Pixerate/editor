# @pixerate/editor

UI-agnostic core of the Pixerate editor toolkit: a prompt-template grammar with recursive resolution and sourcemaps, plain-text and markdown serializers, headless [TipTap](https://tiptap.dev) extensions, and framework-free controllers for rich text, spreadsheets, images and node-graph canvases.

Framework bindings: [`@pixerate/editor-react`](https://www.npmjs.com/package/@pixerate/editor-react) · [`@pixerate/editor-svelte`](https://www.npmjs.com/package/@pixerate/editor-svelte)

```bash
npm install @pixerate/editor @tiptap/core @tiptap/pm
```

`@tiptap/core` and `@tiptap/pm` (`^2.11.5`) are peer dependencies, so your app and the editor share one ProseMirror instance.

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

## Other modules

Each module is also available as a subpath import:

| Import | Contents |
| :--- | :--- |
| `@pixerate/editor/grammar` | Tokenizer, resolver, sourcemaps. No TipTap or DOM dependencies, so it is safe for Node.js, workers and serverless functions. |
| `@pixerate/editor/serializers` | Plain text, markdown and mention serializers |
| `@pixerate/editor/extensions` | Headless TipTap extensions |
| `@pixerate/editor/history` | `HistoryManager`: a command-pattern undo/redo stack |
| `@pixerate/editor/spreadsheet` | `SpreadsheetController`, formula parser/evaluator and dependency graph |
| `@pixerate/editor/image-editor` | `ImageEditorController` and Canvas 2D renderer: crop, adjustments, annotations, depth masks and AI hooks. Needs a DOM/canvas environment. |
| `@pixerate/editor/canvas` | Node-graph layout (dagre), placement, trajectories, displacement, clipboard and streaming layout helpers |
| `@pixerate/editor/agent` | MCP tool schemas and a planner for agent-driven canvas edits |

The root entry (`@pixerate/editor`) re-exports grammar, serializers, extensions, the editor controller, spreadsheet, history and dirty tracking. Canvas, agent and image editor are **subpath-only**, so the root entry never loads dagre or the Canvas 2D renderer. The root entry does import TipTap, so in backends import from `@pixerate/editor/grammar`.

## License

MIT
