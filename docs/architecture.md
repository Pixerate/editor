# Architecture & Design Principles

`@pixerate/editor` is architected using a 3-layer modular design that cleanly separates domain grammar logic, editor engine integration, and framework view adapters.

```
┌────────────────────────────────────────────────────────┐
│                   Layer 3: UI Adapters                 │
│    @pixerate/editor-react    │   @pixerate/editor-svelte   │
│   (usePromptEditor, Menu)    │  (Runes, EditableText)   │
└────────────────────────────────────────────────────────┘
                           ▲
                           │
┌────────────────────────────────────────────────────────┐
│            Layer 2: Headless TipTap Plugins            │
│   GradientText, SlashCommands, Presets, Smilies, etc.   │
└────────────────────────────────────────────────────────┘
                           ▲
                           │
┌────────────────────────────────────────────────────────┐
│             Layer 1: Pure Core (Domain)                │
│   Grammar, AST Tokenizer, Recursive Resolver, Map,     │
│             Plain-text Serializer (Zero DOM)           │
└────────────────────────────────────────────────────────┘
```

---

## Layer 1: Pure Core Domain (`@pixerate/editor`)

The core domain layer has **zero browser or DOM dependencies**:
- **Tokenizer (`src/grammar/tokenizer.ts`)**: Consumes a raw prompt string and converts it into a structured Token AST (`Token[]`), preserving raw offsets and content slices.
- **Recursive Resolver (`src/grammar/resolver.ts`)**: Resolves nested template calls (`{{a}} -> {{b}} -> text`) while preventing infinite loops using visited-set cycle detection. It also binds specific template versions when requested.
- **Bidirectional Sourcemap (`src/grammar/sourcemap.ts`)**: Tracks exact character indices between raw prompt inputs and resolved outputs. This allows errors or highlighting in resolved text to map back to the author's input.
- **Serializers (`src/serializers/plain-text.ts`)**: Implements deterministic string <-> TipTap ProseMirror HTML conversion that guarantees newline preservation without leaking HTML tags.
- **PDF Layout Analysis (`src/import/pdf-layout.ts`)**: `analyzePdfLayout(pages)` turns positioned text runs (and optional ruling lines) into headings, paragraphs, lists and tables in reading order. Pipeline: runs → baseline fragments (split at gaps over ~1 em) → running headers/footers and page numbers removed (text repeated at page edges on ≥ half the pages) → ruled tables (connected rules form grids; stacked same-width rules bound booktabs tables) → reading order (vertical gutters no narrow fragment crosses; bands between full-width lines are read column by column when both sides read like prose, otherwise handed to aligned-column table detection) → lines → blocks (headings ranked by font-size/bold style against the body size, bullets and numbers with nesting by indent, paragraphs split by pitch, first-line indent and short sentence-final lines, de-hyphenation, paragraphs continued across columns and pages). Every step sorts or sweeps, so it stays near O(N log N). The PDF adapter (`createPdfImportAdapter`) feeds it from pdf.js (text items, font weights from `commonObjs`, rules from the operator list) and attaches the `PdfStructureReport` as `DocumentImport.structure`; `adapterOptions: { pdf: { structure: false } }` restores the plain paragraph import.

Because this layer is pure TypeScript, it executes with ultra-low latency in:
- Node.js scripts
- Cloud Functions (e.g. Firebase Functions / serverless microservices)
- Web Workers
- Browser environments

---

## Layer 2: Headless ProseMirror / TipTap Extensions

This layer extends `@tiptap/core` with specialized plugins that work across any view framework:
- **`GradientText`**: An inline decoration plugin that matches tokens in the ProseMirror document and paints animated linear gradients over `{{template}}` tags.
- **`SlashCommands`**: A keyboard and input plugin that listens for `/` and exposes trigger callbacks to UI popups.
- **`TemplateSuggestions`**: Triggers autocomplete suggestion popups when the user types `{{`.
- **`LoadingNode`**: An inline atom node representing asynchronous AI expansion or template loading.
- **`createRichTextPreset`**: A preconfigured extension bundle built on StarterKit (headings, lists, code blocks, strike) plus task lists, links, text alignment, colors, highlights, typography and images, with opt-in mentions and markdown.
- **`SmilieReplacer` & `ColorHighlighter`**: Auto-replaces ASCII emoticons with Unicode emoji, and decorates hex colors (e.g. `#ff0055`) with visual color swatches.
- **`TrackChanges` moves**: with tracking on, a cut followed by a paste of the same text (same author, nothing edited in between), or a drag within the document, of at least a sentence (`isMoveSized`, configurable with `isMove`) is recorded as one move: the source keeps the `deletion` mark and the destination gets the `insertion` mark, both with the same `moveId` (`data-move-id`). `getTrackedChanges` lists it once (`type: "move"`, `move.from` / `move.to`); `acceptMove` removes the source and keeps the destination, `rejectMove` restores the source and removes the destination, taking an emptied top-level paragraph with it. Exports treat the ends like insertions and deletions. `compareDocuments({ detectMoves: true })` records a uniquely identical top-level paragraph deleted in one place and inserted in another the same way.
- **`ParagraphStyles`**: a `StyleRegistry` (`createStyleRegistry`) of paragraph and character styles with `basedOn` chains (bounded and cycle-safe), `next` styles, linked character styles and document defaults, resolved defaults → style chain → character style → direct formatting. Blocks name their style with `styleId` (`data-style`); headings without one are Heading N and paragraphs Normal, so existing HTML is unchanged. The registry renders a scoped stylesheet (`toCSS`) that the extension injects. Commands: `setParagraphStyle`, `clearParagraphStyle`, `setCharacterStyle`, `updateParagraphStyleFromSelection`, `createParagraphStyleFromSelection`; Enter at the end of a paragraph applies the style's `next`. UI bindings read `createParagraphStylesStore`.

---

## Layer 3: Framework View Adapters

### `@pixerate/editor-react`
- **`usePromptEditor`**: A hook that packages all prompt editing logic into a single line of React code. It handles controlled/uncontrolled state, plain text clipboard paste normalization, milestone tracking, and token callbacks.
- **`<EditorContent />`**: Renders the TipTap DOM tree.
- **`<BubbleMenu />`**: Floating context toolbar that appears when text is selected.
- **`<TemplateRenderer />`**: A lightweight, read-only React component that parses prompt syntax into styled badges without instantiating a TipTap editor.

### `@pixerate/editor-svelte`
- **`initiateEditor`**: A factory function creating a reactive TipTap instance configured with rich-text presets.
- **`createReactiveEditor`**: A Svelte 5 runes-based wrapper providing fine-grained reactivity (`$state`).
- **`<EditableTextNodeEditor />`**: A drop-in Svelte component with built-in bubble menu, placeholder support, and drag-and-drop event containment.
- **`<TemplateRenderer />`**: A read-only Svelte 5 component for displaying tokenized prompts.

---

## Key Design Invariants

1. **Plain Text is the Single Source of Truth for Prompts**: AI prompt editors must never store HTML tags in database records. The editor operates on pure string content, converting to TipTap nodes on mount and serializing back to pure strings on change.
2. **Deterministic Token Parsing**: Given the same prompt string, the tokenizer will always return identical token ranges and types.
3. **Graceful Circular Reference Handling**: In case of circular template references (`A -> B -> A`), the engine guarantees termination within a single pass, replacing the recursing tag with `"[Template loop detected]"` (and leaving the rest of the prompt intact) without throwing an unhandled exception or crashing the browser.
