---
name: pixerate-brushes
description: How to find, describe, create, change, check and share brushes in the Pixerate brush library through list_brush_presets, describe_brush, create_brush, update_brush, duplicate_brush, remove_brush, check_brush, export_brushes, import_brushes, import_brush_pack, preview_brush, add_brush_source and list_brush_sources - brushes made of facets (kind, medium and variety or tool, tip, marks, dynamics, behaviour, light, motion, colour), image tips and tip grain made from image sources, the built-in presets, and the host profiles that say what the paint editor, image editor, canvas and vector strokes can render. Use when asked to make, design, tweak, save, copy, delete, export, import or check a brush, make a brush from an image (a scanned mark, a leaf, a texture), give a brush grain, bring in a Photoshop .abr or Procreate .brush / .brushset pack, find a brush for a medium (pencil, ink, watercolour, oil, airbrush, highlighter), or make a brush work in another editor.
---

# Brushes

A brush is made of **facets** that say what it is and how it behaves, not which engine draws it.
Only `id`, `name`, `kind` and `tip.shape` are required; every other field takes the default of
the engine the facets pick, so a brush stores only what makes it what it is. The library holds the
built-in presets (read-only) and the user's brushes, shared by every editor that paints.

| Facet (field) | What it holds |
| --- | --- |
| Kind | `mark` lays a material; `tool` works on paint already down. |
| Medium and variety | Marks: what it lays (`paint`, `ink`, `dry`, `spray`) and what kind (`oil`, `watercolor`, `gouache`, `pencil`, `charcoal`, `airbrush`, `marker`, `highlighter`…). Descriptive, for finding brushes; a wet brush whose variety is `watercolor`, `gouache` or `oil` paints that medium. |
| Tool | Tools: `eraser`, `blender`, `smudge`, and on wet paint `water`, `dryer`, `blow`, `blot`, `wet-blend`, `wet-drag`. |
| Tip | `shape` (`round`, `flat`, `chisel` are ellipses set by `roundness` and `angle`; `bristle` has a tuft; `stamp` takes the shape of `stamps`: an editor stamp `editor:star`, any sticker ref from `find_stickers`, or an image source `source:<id>` from `list_brush_sources`), size in px, hardness (an image tip fades towards its edges below 1), spacing, opacity, flow, blend mode, and `grain`: texture inside each dab (`source`: a pattern such as `rough`, `canvas`, `sanded`, or `source:<id>`; `mode` `texturised` stays put on the canvas, `moving` rolls with the tip; `scale`, `depth`, `contrast`, `invert`). |
| Marks | `continuous` dabs (default; on a stamp tip every dab is the first stamp's shape, in the paint colour), `scatter` (a spray: droplets across the tip, `density`, `size`), `particles` (strands, springs, ribbons, sparks; textured dots from the stamps) or `objects` (each mark an editable sticker, in its own colours). |
| Dynamics | Pen feel: pressure to size and opacity, smoothing, tilt, velocity, jitter (`sizeJitter`, `angleJitter` for rotation, `opacityJitter`, `scatter`), rotation, `count` (dabs per spacing step, each jittered) and `flip` (mirror dabs at random: `x`, `y`, `xy`). |
| Behaviour | `surface` `dry`, `wet` (`wet` settings) or `thick` (`thick` impasto settings); paper `grain`; `exchange` (pick-up and mix; a `reservoir` makes a Mixer Brush); tool `strength`. |
| Light | Light the brush gives off (`amount`), plus suggested layer `spill` and `glow`. |
| Motion | Animation after painting (live effect paint, particle `waveSpeed`). |
| Live patterns | `livePatterns`: Gray-Scott reaction-diffusion patterns (`pattern`: `spots`, `stripes`, `coral`, `maze`, `worms`, `feed`, `kill`, `scale`, `contrast`, `secondColor`, `relief`) that grow in wet paint (`behaviour.surface: 'wet'`) and freeze when it dries. Built-in presets: `turing-wash`, `coral-ink`. |
| Colour | A `default` colour, a `palette` of up to 16, `own` (always its own colour). Each is a hex or `rgba()` colour, a light / dark pair `{ light, dark }`, a gradient or effect paint. A gradient default is always painted; a solid or light / dark default becomes the editor's colour when the brush is chosen (unless the user locked theirs), resolved for the colour scheme. Canvas strokes and vector brushstrokes take it too, when they are given no colour. Canvas and vector have the same lock (`canvas.setColorLocked`, `vector.setColorLocked`), and a canvas colour taken from a light / dark default follows the scheme like the paint editor's; vector strokes already made keep theirs. |

How media map to facets: a **pencil** or **charcoal** is `dry` with high `grain` and tilt;
**ink** is a hard round tip with pressure to size (a pen thins with velocity); **watercolour**
and **wet oil** are `paint` on `surface: 'wet'`; **impasto** is `surface: 'thick'`; an
**airbrush** is `spray`, soft and low flow; a **spray can** is `spray` with `marks` scatter; a
**ballpoint**, **gel pen** or **fineliner** is `ink` with a small hard tip (a fineliner without
pressure to size); **crayon** and **chalk** are `dry` with high `grain`; a **highlighter** is
`ink` / `highlighter`, a multiply chisel tip with a little light, `spill` radius 0, fluorescent
yellow by default; a **stamp brush** is a `stamp` tip with continuous marks; **particle** and
**sticker** brushes are `marks` particles or objects on a `stamp` tip. An **image brush** (a
scanned charcoal mark, a leaf, a dry-brush texture) is a `stamp` tip whose stamp is an image
source, usually with `tip.grain`, `angleJitter`, `flip` and a little `scatter` so repeats don't
show.

**Image sources** are the images tips and grain are made from, kept in the library with their
bytes (a grey mask, at most 512 px) and their licence. `add_brush_source` makes one from a PNG:
the marks are read from its transparency, its dark parts (a scan on paper) or its light parts
(white on black). Library files (`export_brushes`) and saved paintings carry the sources their
brushes name, so they paint and replay the same anywhere.

## Host profiles

Each host renders a part of this. `check_brush` says what a host refuses (errors) and what it
paints without (warnings), each with a fix; lists and writes use the current host.

| Host | Renders |
| --- | --- |
| Paint editor (`paint`) | Everything, image tips and tip grain included. |
| Image editor (`image`) | Dry dabs on round, flat and chisel tips, the Mixer Brush and the eraser; no wet or thick surface, particles, objects, stamp or image tips, light or motion; it paints without tip grain and `count`. Pick one with `set_brush_preset`. |
| Canvas (`canvas`) | Dry dab brushes along a path (no tools, wet, thick, particles, objects, stamp or image tips, or light); velocity, tip grain and `count` are ignored. Draw with one as `canvas.drawFreehand` `brush`. |
| Vector strokes (`vector`) | As canvas, plus wet paint (watercolour, gouache, wet oils: simulated in the stroke's own area, then dried), the Mixer Brush, and the smudge and blender tools (acting on the shapes beneath the stroke); light brushes paint as plain colour. The wet tools (water, hair dryer, blow, wet blend, wet drag, blot), thick paint, particles, objects and erasers are refused. Draw with one as `vector.addBrushstroke` `brushId`. |

Every host lists the presets its profile admits and the library's saved brushes it admits, and
each registers these tools with its own profile, so `list_brush_presets` shows that host's brushes.
People edit brushes in every host with the same brush editor, scoped the same way: it shows only
the controls the host uses (no velocity on canvas, no grain in the image editor), and what the
brush has for other hosts is kept on save. The tools follow the same rule (see Pitfalls).
A saved brush used in canvas or vector strokes is copied into the stroke, so the document renders
where the library is not; changing the brush in the library later doesn't change strokes already
drawn.

## Working method

1. **Find the nearest brush.** `list_brush_presets` with `medium`, `variety`, `kind` or `text`.
   It lists only what this host can render (`all: true` lists the rest with `renderable`).
2. **Read it.** `describe_brush` for the full spec, the engine it resolves to and its check.
3. **Make a brush.** `create_brush` with a new `id`, a `name`, `basedOn` the nearest preset and
   only the facets that change (objects merge; lists replace). Read `problems` (values clamped or
   dropped) and `warnings`. A brush the host can't render is refused and nothing is saved.
4. **Look at it.** `preview_brush` when the host has a renderer; otherwise paint a test stroke
   in the editor (`set_brush` with the new id, then `paint_stroke`).
5. **Tune it.** `update_brush` with the facets to change, or `unset` to drop whole facets. It
   returns the leaf paths `changed`. Built-in presets can't be changed: `duplicate_brush` first.
6. **From an image.** `add_brush_source` with the PNG (`channel` when `auto` picks the wrong
   part; keep the `licence` it came with), then `create_brush` with `tip: { shape: "stamp",
   stamps: ["source:<id>"] }` for an image tip, or `tip.grain.source` for grain.
   `list_brush_sources` lists them and which brushes use each.
7. **Bring in a pack.** `import_brush_pack` with the file (base64), its `fileName` and the
   `licence` it came with. Read `brushes` (with `renderable` for this host), `unsupported` (what
   was not mapped) and `licence`, then `preview_brush` a few and tune them with `update_brush`.
8. **Share it.** `export_brushes` writes a library file; `import_brushes` adds one (version 1
   files of the paint editor's older brushes are migrated). `check_brush` with `host` before
   handing a brush to another editor.

## Best practices

- Start from the nearest preset and change two or three facets; a brush from nothing gets
  engine defaults that rarely suit a medium.
- Test on the paper and colour the brush will be used on: grain response and glazes look
  different on smooth and rough paper.
- Give light brushes dark paper, and give highlighters a `light.spill` radius of 0 so the
  glow stays on the stroke.
- Keep `variety` truthful (it is how people find the brush) and add `tags` for the job
  (`lettering`, `foliage`).
- Give a brush a `colour.default` only when the medium has a typical colour (blue ballpoint,
  yellow highlighter): choosing the brush sets it as the user's colour. Use a light / dark pair
  when the right colour depends on the background (white chalk on a dark board, graphite on
  paper), and a `palette` for the other usual colours. Dark inks need a pair too (navy / light
  blue, near-black / near-white): a single dark default vanishes in a dark-scheme editor. Check
  each side against the background it is for (3:1 at least). `colour.own` only for brushes that
  must always paint their own (a rainbow marker).
- Previews and thumbnails pick their own colour against what they are drawn on (the brush's
  default when it reads there, else a colour for the medium). Don't give a brush a default just
  to make its preview visible: choosing the brush makes that default the user's colour.
- Stamp tips paint the sticker's shape in the paint colour; to keep a sticker's own colours, use
  `marks` objects instead.
- Image tips: crop the image to the mark and give it a transparent or plain background, so the
  dab is the mark and not its box. Spacing 0.2–0.4 for a continuous mark, above 1 for separate
  prints; add `angleJitter`, `flip` and `scatter` so the same image doesn't repeat visibly.
- Grain: `texturised` grain (default) is a texture the stroke reveals, like paper; `moving` grain
  belongs to the tip and rolls with it (a sponge, a roller). Depth 0.4–0.7 reads as texture;
  1 leaves only the peaks. Use `tip.grain` for the tool's texture and `behaviour.grain` for the
  paper's.

## Pitfalls

- **A facet the host refuses.** `create_brush` refuses it, and `update_brush` refuses a change
  that adds it, with the facet and fix; `check_brush` returns `degraded`, the brush with those
  facets stripped, to start from.
- **Tuning a brush in a host that can't paint all of it.** `update_brush` keeps what the brush
  already has for other hosts (a paint brush's light, changed from canvas) and lists it in
  `kept`; it is not stripped. To make a copy for this host only, `create_brush` from
  `check_brush`'s `degraded` brush instead.
- **Ids.** Built-in ids can't be reused or changed; a taken id is refused (update it instead).
- **Stamps.** Any marks take any sticker ref from `find_stickers`, or an editor stamp
  (`editor:star`…). A ref the host's sticker library can't load is refused with the closest
  refs. Only the paint editor renders stamp tips and scatter marks; canvas, vector and the image
  editor refuse them (`check_brush` says so).
- **Image sources.** A `source:<id>` the library doesn't have is refused, with the closest ids;
  add it first. Replacing a source's image (`overwrite`) changes every brush that names it, but
  not strokes already painted. Objects marks take stickers only, so an image source there is
  dropped (`problems` says so). Brush packs are often licensed for personal use only: keep the
  `licence` text with the source.
- **Brush packs.** Only the tips (and Procreate grain) are imported: dynamics, pencil curves,
  patterns, dual brushes and wet settings are listed in `unsupported`, so imported brushes paint
  with default feel; tune them. Imported image tips are stamp tips, so canvas, vector and the image
  editor can't paint them (`renderable` false). Packs are often for personal use only: pass and
  keep their `licence`; never redistribute a library file of imported brushes without checking it.
- **Out-of-range values** are refused by the schema (`tip.size` is 1..2500 px); a stored brush
  is clamped on import and reported in `problems`.
- **The paint editor paints from this library.** Its `set_brush` picks a brush by id here and
  lays facets over it without saving; `create_brush` / `update_brush` store one. A paint host
  registers these tools with its own preview (`createPaintBrushLibraryToolProvider`), so the
  paint editor has no list, save, export, import or thumbnail tools of its own.

## Workflow skills

- `pixerate-brushes-design`: from a description ("a soft pink highlighter", "chalk for the
  canvas") to a saved, checked brush.

## Tool reference

| Tool | Use |
| --- | --- |
| `list_brush_presets` | Find brushes this host renders: `kind`, `medium`, `variety`, `tool`, `tag`, `text`, `source` (all, builtin, user), `all`, `offset`, `limit`. Returns `brushes` (id, name, builtin, kind, medium, variety or tool, category, engine, tip, size, marks, surface, light) and `total`. Call first. |
| `describe_brush` | One brush by `id`: its full facet `brush` (with its `colour`: default, palette, own), `builtin`, `engine`, `category` and `check` for this host (stamp stickers included). Unknown ids are refused with the closest ones. |
| `create_brush` | Save a new brush: `id`, `name`, optional `basedOn`, and the facets, `colour` included (to keep an editor's current brush, pass the `brush` its `get_brush` returns). Normalised and checked for this host (and its sticker library, for stamp tips); refused brushes save nothing. Returns `id`, `brush`, `engine`, `problems`, `warnings`. |
| `update_brush` | Change a saved brush: facets to merge in, `unset` facets to drop. Refuses built-ins (duplicate first) and changes that add what the host can't render; keeps what the brush already had for other hosts. Returns `brush`, `changed` paths, `problems`, `warnings` and, when there are any, `kept` (facets this host can't use, left as they were). |
| `duplicate_brush` | Copy any brush, built-ins included, to a saved brush (`newId` default `<id>-copy`, `name`). Returns the new `id` and `brush`; then `update_brush` it. |
| `remove_brush` | Delete a saved brush for good (export it first to keep a copy). Built-ins are refused. Returns `removed`. |
| `check_brush` | Check a brush (`id`, or an unsaved `brush` spec) for a `host` (paint, image, canvas, vector). Returns `ok`, `issues` (facet, severity, reason, fix) and, when refused, `degraded`. |
| `export_brushes` | Library file (pixerate-brushes v2) of the saved brushes or the `ids` given. Returns `file`, for `import_brushes`. |
| `import_brushes` | Add a library `file` (v2, v1 migrated, or a bare list): built-in ids and taken ids are skipped unless `overwrite`. Returns `added`, `replaced`, `skipped`, `problems`. |
| `preview_brush` | Only when the host renders previews: a sample stroke with a brush (`id`, `width`, `height`, `color`) as an image. |
| `add_brush_source` | Add an image (`name`, `image` PNG data: URL, optional `id`, `channel` auto / alpha / darkness / lightness, `invert`, `licence`, `origin`, `overwrite`) as a source for image tips and grain. Returns `id`, `ref` (`source:<id>`), `width`, `height`, `problems`, `replaced`. Then `create_brush` / `update_brush` with the ref in `tip.stamps` or `tip.grain.source`. |
| `import_brush_pack` | Import a Photoshop `.abr` or Procreate `.brush` / `.brushset` (`file` base64 or a data: URL, `fileName`, optional `format`, `prefix`, `licence`, `overwrite`). Returns `format`, `brushes` (id, name, `renderable` here), `sources`, `skipped`, `unsupported`, `licence`, `problems`. Then `preview_brush` and `update_brush` to tune. |
| `list_brush_sources` | The library's image sources (`text`, `offset`, `limit`). Returns `sources` (id, ref, name, width, height, licence, origin, `usedBy` brush ids) and `total`. Call before naming a `source:` ref. |
