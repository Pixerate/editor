---
"@pixerate/editor": minor
---

Paint editor conformance contracts (#534): `paintContracts({ effects })` exports the paint domain for `@pixerate/conformance` (`domains/paint`): every paint provider's agent tools, the keyboard commands, the UI tables and a JSON Schema of a saved painting (`PAINT_DOCUMENT_JSON_SCHEMA`). The paint editor's keyboard shortcuts are now a table, `PAINT_SHORTCUTS`, with `paintShortcutFor(event)`; `handlePaintShortcut` dispatches from it, with the same keys as before.
