---
name: adding-brushes
description: How to add or change a built-in brush preset, or add a new brush facet (a new kind of paint behaviour), in this repo's brush library (packages/core/src/brushes, its Swift port and conformance contracts). Use when editing presets.ts or the brush types, schema, normalize, resolve or profiles; when asked to add, design or ship a built-in brush, paint type or brush family; or when a new paint behaviour needs a brush to carry it. Not for making a user's brush through the tools at runtime, which the shipped skills pixerate-brushes and pixerate-brushes-design cover.
---

# Adding brushes to the library

A built-in brush is a facet spec in `BRUSH_PRESETS` (`packages/core/src/brushes/presets.ts`). The
paint editor resolves it (`resolveBrush`), every host lists the presets its profile admits, and the
Swift port reads the same list from the conformance contracts. So most presets are a change to one
TypeScript file plus regenerated contracts. A brush that needs something no facet expresses yet
is a new **facet**, which touches far more (see below).

Two kinds of reader use what you write: people painting, and **agents** calling the brush tools.
An agent finds presets with `list_brush_presets`, bases its own brushes on them and learns them
from the shipped skills. A preset isn't done until an agent can find it and the skills say what
it's for (AGENTS.md section 4).

## Which job is this?

| Job | Do |
| --- | --- |
| A new preset from facets that exist | **Adding a preset** below. |
| A brush needs a behaviour no facet has (a new material, a new reaction) | **Adding a facet** below, then a preset that uses it. |
| Changing what a preset paints | As adding a preset; the contracts diff (`resolved.json`) shows exactly what changed. Don't rename an id that has shipped: documents and saved strokes name presets by id. |
| Making a brush for a user through the tools | Not this skill: load `packages/core/skills/pixerate-brushes/SKILL.md` and `pixerate-brushes-design/SKILL.md`. |

## Design it with the tools first

Draft the brush the way an agent or a user would, before writing it into `presets.ts`. Follow the
working method in `pixerate-brushes-design` (nearest preset, change only what matters, check each
host, look at it), through the real tools in Node:

```ts
import { createBrushLibrary, createBrushLibraryToolProvider, PAINT_PROFILE } from '@pixerate/editor/brushes';
import { paintBrushPreviewRenderer } from '@pixerate/editor/paint-editor';
import { ToolRegistry } from '@pixerate/editor/tools';
const tools = new ToolRegistry();
tools.register(createBrushLibraryToolProvider(createBrushLibrary(), { profile: PAINT_PROFILE, renderPreview: paintBrushPreviewRenderer() }));
// create_brush { id, name, basedOn, …facets } → preview_brush { id, width: 512, height: 160 } → check_brush { id, host }
```

`packages/evals/src/host.ts` (`createBrushSession`, `strokePng`) does this for every host, and
writes previews you can open. Look at the stroke at 512 × 160: that's what agents and the eval see.
Then copy the facets that differ from engine defaults into the preset.

## Adding a preset

1. **Write it in `presets.ts`**, next to its family. Unique kebab-case `id` and a plain `name`;
   `kind`, `medium`, `variety` and `family`; then only what differs from the engine's defaults.
   Use our own settings, never another product's.
   - **`family` must be what the facets derive** (`resolveFamily` in `resolve.ts`):
     `brush-library.test.ts` checks every preset. A preset that belongs elsewhere on purpose goes
     in that test's `OWN` list with the reason.
   - **Colour:** a `colour.default` only when the brush has a colour of its own; a light / dark pair
     when it depends on the paper (chalk, white ink). A `palette` for a family of colours. With no
     default, it paints in the user's colour and previews in the medium's fallback.
   - **Tip:** `round`, `flat` and `chisel` are one ellipse; what shows is `roundness`, `angle` and
     `dynamics.rotation`. Name the shape for people, but set the numbers.
2. **Check every host.** `check_brush` with `host` paint, image, canvas and vector. Hosts list only
   the presets they admit, so a dry dab brush appears in canvas and vector strokes too. Make sure
   that is what you want, and that its preview reads in each (`renderCanvasBrushPreview`,
   `renderVectorBrushPreview`).
3. **Regenerate the contracts** after building core:
   `pnpm --filter @pixerate/editor build`, then `node scripts/export-contracts.mjs` (writes
   `packages/conformance/domains/brushes/presets.json`, `resolved.json`, `checks.json` and the
   manifest's count), then `node scripts/record-conformance.mjs`: scenarios that list presets
   (`paint/fixtures/dry-brush-presets.json`, `vector/fixtures/strokes-and-corners.json` for a dry
   brush) are re-recorded. Commit the diffs. The Swift port reads
   `presets.json`, so a preset of existing facets needs no Swift code, but run `swift test`.
4. **Test it.** `brushes.test.ts`, `brush-library.test.ts`, `brush-contracts.test.ts` and
   `paint-contracts.test.ts` must pass.
   - `brush-library.test.ts` ("host profiles") keeps hand-written lists of the presets canvas and
     vector strokes take, in preset order. A new dry dab preset goes into `ADDED`; a wet, Mixer,
     smudge or blender preset goes into `VECTOR_MEDIA`. Put it where it sits in `presets.ts`.
   - Add a test for anything the preset does that no other one does.
5. **Tell agents about it.**
   - Where a skill lists a family's presets (the facet table in `pixerate-brushes`,
     `pixerate-paint-editor/references/*.md`, a workflow skill's decision table or recipes), add
     the id.
   - A preset that is a better starting point for a common request (a new medium, a fixed
     classic) belongs in `pixerate-brushes-design`'s decision table.
   - The tests check tool names, not advice: reread the prose.
6. **Measure a new kind of brush.** Add a reference task to `REFERENCE` in
   `packages/evals/src/tasks.ts` (a sentence in `brief` if a still stroke can't show what it does),
   then `node src/cli.ts --model oracle` from `packages/evals`, which must score 100. A live run
   (`--task ref-<id> --samples 3`) shows whether models can make it from the skills.
7. **Changeset:** `@pixerate/editor`, minor for a new preset, patch for a fix.

## Adding a facet

A facet is a new field on `Brush`: what it means, how it's checked, stored, edited, painted,
refused by hosts that can't paint it, ported and explained. Recent examples to copy the shape of:
`ghost` (#685), `thermochromic` and `fluorescence` (#641), `culture` (#717).

| Where | What |
| --- | --- |
| `brushes/types.ts` | The field, documented with units and ranges. |
| `brushes/schema.ts` | Its JSON Schema with a `description` on every property (agents read these through `create_brush`). |
| `brushes/normalize.ts`, `migrate.ts` | Clamp and default it; migrate stored files if the format changes. |
| `brushes/patch.ts` | Patchable by `update_brush` (`BRUSH_PATCH_PROPERTIES`; unsettable if it can be removed). |
| `brushes/resolve.ts` | Map it to the engine, and to a `family` if it defines a new one (`resolveFamily`). |
| `brushes/profiles.ts` | Each host's support (full, ignored with a warning, refused with a fix) and the `checkBrush` line. |
| `brushes/ui.ts`, `preview.ts` | The brush editor's controls (scoped by host) and, if it changes how a stroke reads, preview colours. |
| `paint-editor/*`, `paint/*` | The engine that paints it, with its own tests. |
| React and Svelte `BrushPanel` | The same controls in both (AGENTS.md section 3). |
| `packages/swift/Sources/PixeratePaint/Brushes/*`, `Editor/Brushes.swift` | The Swift port, matching TS results and pixels. |
| Generated files | Rebuild core, `node scripts/export-contracts.mjs`, `node scripts/record-conformance.mjs`, `pnpm gen:swift`. Commit the diffs. |
| `parity/features.json` | Its row, then `node scripts/parity.mjs`. |
| Skills and docs | A row in `pixerate-brushes`'s facet table, `pixerate-paint-editor/references/brush-facets.md` (and its own reference file if it's big), `pixerate-brushes-design`'s decision table if it changes how a request is met, and `docs/paint-editor.md`. |
| A preset | At least one, as above, so agents can find and base on it. |

## Checks before pushing

```bash
pnpm --filter @pixerate/editor build
pnpm test
pnpm typecheck
node scripts/export-contracts.mjs --check
node scripts/record-conformance.mjs --check
swift build && swift test
(cd packages/evals && node src/cli.ts --model oracle)
```

## Pitfalls

- **A family that doesn't match the facets.** Presets set `family` explicitly, and the library
  test fails when facets derive another. Fix the facets, or list the exception in `OWN`.
- **Grading by name.** The tip's shape name, a `variety` or a description changes nothing a stroke
  shows; agents (and the eval) judge brushes by their facets and their preview.
- **Hosts you didn't mean.** A new dry dab preset also appears in canvas, vector and image
  editor lists. Check each host's preview, or give it something those hosts refuse.
- **Stale contracts.** Editing `presets.ts` without re-running the export script fails
  `brush-contracts.test.ts` and the Swift CI job.
- **A preset only people can find.** If no skill mentions it, an agent only meets it through
  `list_brush_presets`, by medium or family. Say in the skills when it is the right base.
