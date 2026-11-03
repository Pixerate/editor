---
"@pixerate/editor": minor
---

`brushContracts()` in `@pixerate/editor/brushes` returns the brush module as language-neutral contracts, so another implementation (the Swift port) ships the same brushes. The contracts cover:

- the brush, host profile and library file JSON Schemas (`BRUSH_PROFILE_JSON_SCHEMA` and `BRUSH_LIBRARY_FILE_JSON_SCHEMA` are new exports);
- the presets and the engine brushes they resolve to;
- per-host checks and v1 migrations;
- the library's agent tools and the brush editor sections.

`scripts/export-contracts.mjs` (`pnpm contracts`) writes them to the private `packages/conformance/domains/brushes`. A core test fails when the committed files differ from the code.
