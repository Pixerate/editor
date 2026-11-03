# @pixerate/conformance

Language-neutral contracts generated from `@pixerate/editor`, so another implementation (the Swift
port in `packages/swift`, #533) can ship the same behaviour and check itself against it.

This data-only package is generated: never edit its files by hand. `scripts/export-contracts.mjs`
writes them from the built core, and the files are committed. A core test
(`packages/core/tests/brush-contracts.test.ts`) fails when the committed files differ from what the
code exports. After changing a contract's source, run:

```bash
pnpm --filter @pixerate/editor build
```

```bash
pnpm contracts
```

`node scripts/export-contracts.mjs --check` writes nothing and exits 1 when a file is out of date.

The package is private for now (not published to npm). Read it from the repository.

## Domains

### `domains/brushes`

The brush model of `@pixerate/editor/brushes` (`brushContracts()`).

- `manifest.json`: the domain, `formatVersion` (bumped when a file changes shape, not when its data
  changes), limits, counts and the other files.
- `brush.schema.json`: the JSON Schema of a brush, made of facets. Every preset validates against
  it.
- `profile.schema.json`: the JSON Schema of a host profile (what a host can render).
- `library-file.schema.json`: a `pixerate-brushes` version 2 library file. Its brushes are
  `brush.schema.json` brushes. Readers also take version 1 files, which are migrated.
- `presets.json`: the built-in presets, in library order, as facet brushes.
- `resolved.json`: for each preset, the engine it resolves to, its library category, and the flat
  engine brush (`resolveBrush`) a renderer paints with. An implementation's resolver must produce
  these exactly.
- `profiles.json`: the host profiles `paint`, `image`, `canvas` and `vector`.
- `checks.json`: for each preset and host, whether the host renders it (`ok`) and the facets it
  refuses (`error`) or paints without (`warning`). The reasons and fixes are in the code; their
  wording is not part of the contract.
- `migrations.json`: version 1 brushes (the flat engine form older files and documents hold).
  Each comes with the facet brush it migrates to and the engine brush that resolves to.
- `tools.json`: the brush library's agent tools as an MCP tool list (name, title, description,
  strict `inputSchema`, all four annotations) for the paint host, and under `hosts` the tool
  names each host offers. `preview_brush` is there only where the host renders previews. Other
  hosts have the same tools with their own name in the descriptions.
- `editor-sections.json`: what the brush editor shows (`brushEditorSections`) for a few presets
  on every host: the ordered sections and their controls, values and ranges, as React and Svelte
  render them.

## Format

Every file is JSON, written with two-space indents and a final newline, so a change shows up as
a small diff. Objects keep the key order of the code. Lists are in library order.
