# @pixerate/markdown-conformance

Shared Markdown editing fixtures and format-command manifest.

This data-only package serves as the single source of truth for Markdown editing behaviour and format commands shared between `@pixerate/editor` (web / TipTap / ProseMirror) and [Swash](https://github.com/surrealroad/Swash) (a native Swift Markdown editor).

## Contents

- `manifest.json`: Single source of truth for formatting commands (ids, labels, groups, shortcuts, surfaces, conditions) and supported code languages.
- `schema/`: JSON Schemas for validating `manifest.json` and fixture files.
  - `manifest.schema.json`
  - `fixture.schema.json`
- `fixtures/`: Test fixtures specifying `"this Markdown + this selection + this command → this Markdown + this selection"`:
  - `inline-toggle.json`: Bold, italic, strikethrough, inline code.
  - `links.json`: Link wrapping, modifying URL, unwrapping.
  - `blocks.json`: Headings 1–6, paragraphs, blockquotes, lists, task lists.
  - `code-blocks.json`: Fenced code blocks with/without language tags.
  - `newline.json`: Return/Enter key behavior (list continuation, empty list exit, split paragraph).
  - `indent-outdent.json`: List indent and outdent (Tab / Shift+Tab).
  - `backspace.json`: Backspace behavior at block boundaries and selections.

## Selection Markers

Selections are represented inline using distinct Unicode markers rather than character offsets:

- `‸` (`U+2038` CARET): Collapsed caret position.
- `⟦` (`U+27E6` MATHEMATICAL LEFT WHITE SQUARE BRACKET) and `⟧` (`U+27E7` MATHEMATICAL RIGHT WHITE SQUARE BRACKET): Selection range boundaries.

Every `input` and `expected` string must contain exactly one selection (either a single `‸` or a single matching `⟦...⟧` pair).

## Manifest Format

The manifest describes formatting commands exposed in UI surfaces (such as bubble menus, format menus, command palettes, and keyboard shortcut bars):

```json
{
  "commands": [
    {
      "id": "format.bold",
      "label": "Bold",
      "group": "Format",
      "shortcut": "Mod+B",
      "surfaces": ["bubble", "menu"],
      "enabledWhen": ["notInCode"]
    }
  ],
  "codeLanguages": [
    { "id": "javascript", "label": "JavaScript", "shortLabel": "JS" }
  ]
}
```

### Surfaces
- `bubble`: Contextual bubble/floating menu over selection.
- `menu`: Application or format menubar.
- `palette`: Command palette.
- `keyboardBar`: Mobile or touch keyboard accessory bar.

### EnabledWhen Conditions
- `notInCode`: Enabled when selection/cursor is not inside inline code or a code block.
- `inTable`: Enabled when cursor is inside a table cell.
- `hasSelection`: Enabled only when a non-empty text selection exists.

## Fixture Format

```json
{
  "$schema": "../schema/fixture.schema.json",
  "cases": [
    {
      "id": "bold-partial-word",
      "description": "Bolding part of a word wraps just the selection",
      "command": "format.bold",
      "input": "Hello ⟦wor⟧ld",
      "expected": "Hello **⟦wor⟧**ld"
    }
  ]
}
```

### Fields
- `id` (required): Unique kebab-case identifier within the entire corpus.
- `command` (required): A command id from `manifest.json` (e.g. `format.bold`) or the `edit.*` editing namespace (`edit.newline`, `edit.indent`, `edit.outdent`, `edit.backspace`).
- `params` (optional): Arguments passed to the command, conforming to the command's parameter schema.
- `input` (required): Starting Markdown document with inline selection marker.
- `expected` (required): Expected resulting Markdown document with inline selection marker.
- `expectedNoop` (optional): `true` if the command should make no change.
- `description` (optional): Human-readable summary of the test case.
- `skip` (optional): `{ "editor"?: string, "swash"?: string }` reasons why an editor skips this fixture.
- `variants` (optional): `{ "editor"?: string, "swash"?: string }` alternate expected output if the implementation intentionally differs.

## How Consumers Run It

### In `@pixerate/editor` (TypeScript / Vitest)
The test runner in `packages/core/tests/markdown-conformance.test.ts`:
1. Loads each fixture file.
2. Imports the `input` string into a TipTap editor configured with `createRichTextPreset({ markdown: true })`.
3. Resolves the marker positions and sets the ProseMirror selection.
4. Executes the command matching `command` via the editor's command registry or TipTap chain.
5. Serializes the result via `getEditorMarkdown(editor)` and restores selection markers.
6. Asserts equality against `variants.editor ?? expected` (or skips if `skip.editor` is present).

### In Swash (Swift / XCTest)
A Swift test suite imports this package from npm, parses each JSON fixture, initializes a `SwashDocument`, applies the corresponding action, and compares the resulting source and selection.
