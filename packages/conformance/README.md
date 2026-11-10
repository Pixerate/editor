# @pixerate/conformance

Language-neutral contracts generated from `@pixerate/editor`, so another implementation (the Swift
port in `packages/swift`, #533) can ship the same behaviour and check itself against it: what each
domain offers (tools, commands, UI tables, document schemas) and recorded scenarios of what its
tools do (see [Scenarios](#scenarios)).

This data-only package is generated: never edit its files by hand. `scripts/export-contracts.mjs`
writes them from the built core, and the files are committed. Core tests
(`packages/core/tests/brush-contracts.test.ts`, `paint-contracts.test.ts`, `vector-contracts.test.ts`) fail when the committed
files differ from what the code exports. After changing a contract's source, run:

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

### `domains/paint`

The paint editor of `@pixerate/editor/paint-editor` (`paintContracts()`).

- `manifest.json`: the domain, `formatVersion`, the saved document's kind and versions (the
  envelope's `formatVersion`, the painting's `format` and `version`), counts and the other files.
- `tools.json`: the agent tools of every paint provider as MCP tool lists (name, title,
  description, `inputSchema`, all four annotations), under `providers` with each provider's id,
  title and skill: the editor (`createPaintEditorToolProvider`, with its guide, wet, thick, replay,
  sticker, pigment, sticker library and layer style tools), effects
  (`createPaintEffectsToolProvider`, listed with the fake effect provider so the file does not
  depend on a catalogue), the brush library and proposals. Positions are document pixels; a host
  that sets an `origin` takes canvas coordinates instead.
- `commands.json`: the keyboard commands both editors handle (`PAINT_SHORTCUTS`): `id`, `label`,
  `group`, `keys` (`Mod` is Ctrl or Cmd), the agent `tool` that does the same where there is one,
  and `params` (none take any).
- `ui.json`: the tables React and Svelte render: the tool bar (`tools`), brush options, the blend
  menu, every layer style with its controls at their defaults, the slider tables (paper, wet
  paint, light, stroke, sticker), the "Brush a path" tapers, the mixing pad sample sizes, wet
  engine options and the label tables.
- `document.schema.json`: a saved painting, the `pixerate.editor-document` envelope of kind `paint`
  around a `pixerate-paint` document. Objects are open, because readers keep fields they don't know
  and write them back. Layers are the image editor's serialized layers. Each stroke's `brush`
  refers to the brushes domain's `brush.schema.json`.

### `domains/vector`

The vector editor of `@pixerate/editor/vector` (`vectorContracts()`, #618).

- `manifest.json`: the domain, `formatVersion`, the saved document's kind and envelope
  `formatVersion`, counts and the other files.
- `commands.json`: every command agents run with `run_command` (`createVectorCommands`): `id`,
  `label`, `group`, `keywords`, `description`, `params` (the JSON Schema `run_command` checks),
  `shortcut` as written (`Mod` is Ctrl or Cmd), `scope`, `undoable`, `readOnly` and `hidden`.
- `tools.json`: the agent tools as MCP tool lists: the command tools (`list_commands`,
  `run_command`, `run_commands`, from `createCommandToolProvider` with bare names; `run_command`'s
  `id` enum is every command), effects (`createVectorEffectsToolProvider`, listed with the fake
  effect provider) and generation (`createVectorGenerationToolProvider` with
  `FAKE_VECTOR_ART_MODELS`).
- `ui.json`: the tables React and Svelte render: the tool bar (order, groups, glyphs, shortcuts),
  the menus (blend modes, effects, filters, path and pathfinder actions, edit toggles, envelope
  styles, mask types, text alignment, font weights), the effect, filter and lens control specs with
  their defaults, the width-profile presets, the label tables and the overlay theme.
- `document.schema.json`: a saved drawing, the `pixerate.editor-document` envelope of kind
  `vector` around a `VectorDocument`. Objects are open; nodes are described by their common fields
  and `type` (path, group, text or instance).

The vector editor has no pixel renderer of its own (React and Svelte draw its render data as
SVG), so its scenarios compare results, documents, render data and SVG export, never `pixels`.
Its host's render data is the scene the canvases draw: `getVectorSceneRenderData` of the
controller's state with the default options (id prefix `ve-`, no viewport culling).
`createVectorConformanceHost` makes node ids from a counter (`n1`, `n2`, …), which makes them
part of the contract, and lays out text with the metric shaper (`createMetricTextShaper`).
Generation runs `fakeVectorArtGenerator`, a fixed SVG from the prompt.

## Format

Every file is JSON, written with two-space indents and a final newline, so a change shows up as
a small diff. Objects keep the key order of the code. Lists are in library order.

## Scenarios

`domains/<domain>/fixtures/*.json` are recorded tool calls: each scenario starts a fresh editor
(`setup`, such as the canvas size), calls tools in order, and records what every call returned. An
implementation passes when it replays every scenario and gets the same results. The format is
`schema/fixture.schema.json`.

A step is `{ tool, arguments?, document?, render?, pixels?, ignore?, expect }`:

- `tool` is the unprefixed tool name, called with `arguments` through a registry that validates
  them against the tool's `inputSchema`.
- `expect.result` is the call's `structuredContent`, or `{ "error": { "code", "message", "details"? } }`
  with `expect.isError: true` when it failed. Error messages and validation details are part of the
  contract: agents act on them.
- With `document: true`, `expect.document` is the saved document after the call (for paint, the
  `pixerate.editor-document` envelope).
- With `render: true`, `expect.render` is the host's render data after the call: what the canvases
  draw, for editors whose picture is data rather than pixels (the vector editor's scene, its
  document-space paths, groups and paint servers). It is normalized and compared like a result. A
  host without render data fails such a step; implementations that don't read the flag ignore it.
- With `pixels`, `expect.pixels` is the composited canvas after the call (`paper: false` leaves the
  paper out): a PNG under `fixtures/png/`, its size, the SHA-256 of its RGBA bytes, and the most
  another implementation may differ by: `maxDelta` in any channel of any pixel and `meanDelta` over
  all channels (0–255). This core matches the hash exactly.
- With `reload: true`, the host saves the document (the editor's own `toJSON`, assets inline) and
  opens the save again (`loadJSON`, which clears the history) before the call, as an app reopening a
  painting does. With `load`, it opens that saved document instead. `expect.loaded` is what opening
  reported: the normalized problems (parts that could not be read), or `{ "error": message }` when
  the document was refused. Paint scenarios end with a reload, so every saved feature is checked
  through save → load → save in both implementations.
- `ignore` lists JSON pointers left out of the result because they describe one implementation (the
  wet engine's backend); a `*` segment is every element or member.

A scenario with `skip: { "swift": "reason" }` is reported as skipped by that implementation.

### Normalization

Results, documents and render data are compared after these rules, which every implementation applies the same
way (`normalizeConformanceValue` in `@pixerate/editor/tools`):

1. **Generated ids.** Ids an implementation makes in its own format (in this core: layers `pl…`,
   layer styles `fx_…_…`, image editor layers `<prefix>_…_…`, all from the clock) are numbered `@1`,
   `@2`, … in the order first seen. The walk is depth first, object keys sorted by UTF-16 code
   units, each key before its value, and the numbering carries across the scenario's steps. Ids
   from counters or names (`s1`, `st1`, `ref1`, `pad1`, `stencil1`, `paint-proposal-1`, brush ids)
   are not generated ids: they must match as they are.
2. **Placeholders.** Every known generated id becomes its placeholder wherever it appears: as a
   whole string, an object key, or inside a longer string (an error message), longest ids first.
   In `arguments`, a string `@n` is replaced by the real id it stands for before the call.
3. **Binary.** A string starting with `data:`, or at least 200 characters of base64, becomes
   `"<binary>"`: the PNG encoder is not part of the contract (pixels are compared separately).
4. **Clock times.** An ISO 8601 date-time string becomes `"<time>"`.
5. **Keys.** Object keys are sorted; numbers compare as numbers, equal within a relative
   `1e-9` (`conformanceValuesMatch`, `CONFORMANCE_NUMBER_TOLERANCE`): maths functions such as
   `Math.sin` may differ in their last bits between CPUs, and recordings are replayed on others.

### Recording

```bash
pnpm --filter @pixerate/editor build
```

```bash
pnpm conformance:record
```

`scripts/record-conformance.mjs` replays each scenario twice on fresh editors and refuses a step
whose output differs between the runs (pass a `seed` to anything random). It writes `expect` into
each step and the PNGs, and removes PNGs no step records. `--check` writes nothing and exits 1 when
a recording is out of date. `packages/core/tests/paint-conformance.test.ts` replays every scenario
against the source, and fails when a paint tool is not used by any scenario: a new tool needs a
scenario in the same change. `vector-conformance.test.ts` does the same for vector, and also fails
when a vector command is not run by any scenario (through `run_command` or a step of
`run_commands`): a new command needs a scenario too.

To add a scenario, write `{ "$schema", "id", "description", "setup", "steps": [{ "tool", "arguments" }] }`
with the steps you want compared (`document`, `render`, `pixels`), then record it.

Vector scenarios run commands as `{ "tool": "run_command", "arguments": { "id": "vector.addShape",
"params": { … } } }`. Node ids come from a counter (`n1`, `n2`, … in creation order), so later steps
use them as they are, without placeholders. They never take `pixels`; compare results, documents,
render data (`render: true`, at points where the scene holds varied content) and `vector.exportSvg`. Give `generate_vector_art` and `regenerate_vector_art` a `seed`, or the
fake generator's seed is random. Each scenario also makes one deliberate mistake (an unknown id, a
value out of range), because error messages are part of the contract.
