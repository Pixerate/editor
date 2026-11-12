---
name: pixerate-brushes-design
description: The brush design workflow in the Pixerate brush library - turning a description ("a soft pink highlighter", "chalk for canvas strokes", "make this brush work in the vector editor") into a saved brush, by picking the nearest preset, changing only the facets that matter, checking it against the host that will use it and previewing it. Use when asked to make, design, customise, adapt or port a brush, or when create_brush, check_brush or list_brush_presets are available. Load with pixerate-brushes, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-brushes
---

# Designing a brush

A brush is a preset with a few facets changed. The presets already hold good settings for each
medium (pencil grain, ink velocity, watercolour water), so the fastest good brush starts from
the nearest one and changes two or three facets: the colour, the tip, how it feels. What a brush
may use depends on the editor that will paint with it: check it against that host before saving.

This skill is the method. `pixerate-brushes` has the full tool reference.

## Goal and quality bar

- The brush is saved under a clear `id` and `name`, with a truthful `medium` and `variety`.
- `check_brush` for the host it is for returns `ok: true`; any warnings are understood.
- It differs from its base preset only where the request asks (`describe_brush` shows it).
- Built-in presets are untouched.

## Inputs to confirm

Ask when you cannot tell from the request; say what you assumed when you can.

- **Host:** which editor will use it (paint by default; canvas strokes take only dry dab brushes,
  vector strokes dry and wet dab brushes, the Mixer Brush, smudge and blender; the image editor no
  wet, thick or particle brushes).
- **Medium and character:** what it imitates (pencil, ink, chalk, watercolour, marker…), and
  the size, softness and texture.
- **Colour:** a default colour or palette, or the user's own colour (the default).

## Working method

1. **Find the base.** `list_brush_presets` with `medium` or `variety`, or `text`. Pick the
   closest; `describe_brush` it to read its facets.
   **Check:** the base's `check` is `ok` for the target host (or `check_brush` with `host`).
2. **Create from it.** `create_brush` with a new `id`, `name`, `basedOn` and only the facets
   that change: `variety` for what it is now, `colour.default` / `colour.palette`, `tip`
   (size, hardness, roundness, angle), `dynamics`, `behaviour.grain`.
   **Check:** `problems` is empty or understood; nothing refused.
3. **Check it for the host.** `check_brush` with `id` and `host`. A refusal names the facet and
   fix; its `degraded` brush is a good next spec.
   **Check:** `ok: true`. With a house style, `check_brush_style` with `ids: [id]` too: the
   medium, colours and image-source licences are the house's.
4. **Look at it.** `preview_brush` when available; then `update_brush` to tune (each call
   returns the paths `changed`).
   **Check:** `describe_brush` shows the intended facets.

## Decision table

| Situation | Approach |
| --- | --- |
| A colour variant of a preset | `basedOn` it, set `colour.default` (and a `palette`), keep everything else. |
| For canvas strokes | Base on a dry preset (pencil, pastel, charcoal, marker, ink); no wet surface, particles, stickers or tools; no light. |
| For vector strokes | As canvas, but a wet surface (watercolour, gouache, wet oil), the Mixer Brush and the smudge and blender tools work too; no thick paint, particles, stickers, erasers or wet tools. |
| A brush that must work in another editor | `check_brush` with that `host`, then `create_brush` from its `degraded` brush under a new id. |
| A texture (chalk, charcoal, dry brush) | Raise `behaviour.grain` (0.8..1) and add `dynamics.sizeJitter`; test on rough paper. For texture that shows on any paper, give the tip its own grain: `tip.grain` `{ source: "sanded", depth: 0.6 }` (paint editor; other hosts paint without it). |
| A brush from an image (a scanned mark, a leaf, a texture) | `list_brush_sources`, or `add_brush_source` with the PNG (keep its `licence`); then `tip` `{ shape: "stamp", stamps: ["source:<id>"] }`, spacing 0.2–0.4, `dynamics.angleJitter`, `flip` and a little `scatter`. The image as grain instead: `tip.grain.source`. Paint editor only. |
| A light brush (neon, glow) | `light.amount`, and paint it on dark paper; a highlighter keeps `light.spill.radius` 0. |
| A colour that depends on the background (chalk, white ink) | `colour.default` as a light / dark pair `{ light, dark }`: the editor takes the side for its colour scheme when the brush is chosen. |
| A shape as the tip (stars, leaves, a logo) | `tip.shape` stamp with `stamps` (an editor stamp or a ref from `find_stickers`), continuous marks; it paints in the user's colour. Keep the sticker's colours with `marks` objects. Paint editor only. |
| A spray can or mist | `basedOn` `spray-can`, or `medium` spray with `marks` scatter (`density`, `size`). Paint editor only. |
| From a brush pack the user owns (.abr, .brushset) | `import_brush_pack` with its `licence`, pick the closest imported brush, then `update_brush` its feel (pressure, jitter, grain): packs import tips, not dynamics. |
| A change to a built-in | `duplicate_brush`, then `update_brush` the copy. |
| Tune a brush from a host that can't paint all of it | `update_brush` there: what the host can't use is kept (`kept`), not stripped; refused only if the change adds it. |

## Recipes

**A pink highlighter.** `create_brush` `{ id: "pink-highlighter", name: "Pink highlighter",
basedOn: "highlighter", colour: { default: "#ff6ec7" } }`, then `check_brush`.

**Chalk on a blackboard, for canvas strokes.** On the canvas host, `create_brush`
`{ id: "board-chalk", name: "Board chalk", basedOn: "chalk", colour: { default: { light:
"#334155", dark: "#f8fafc" } } }`: white chalk in dark mode, slate on light paper.

**A charcoal brush from a scan.** `add_brush_source` `{ name: "Charcoal scan", image: <PNG>,
channel: "darkness" }` → `create_brush` `{ id: "scan-charcoal", name: "Scan charcoal", basedOn:
"charcoal-stick", tip: { shape: "stamp", stamps: ["source:charcoal-scan"], spacing: 0.25, grain:
{ source: "rough", depth: 0.5 } }, dynamics: { angleJitter: 0.3, flip: "xy" } }` → `preview_brush`.

**Port a wet brush to vector.** `check_brush` `{ id, host: "vector" }`; `create_brush` from the
`degraded` brush with `id` `<id>-vector`; `check_brush` again.

## Pitfalls

- **Starting from nothing.** A brush without `basedOn` gets engine defaults (a hard round dab);
  it rarely looks like the medium asked for.
- **A host that refuses the base.** A wet or particle preset can't be the base of a canvas
  brush, nor a thick (impasto) preset of a vector one; set `behaviour.surface` to `dry` (vector
  also takes `wet`) or start from a dry preset.
- **Lists replace.** Giving `colour.palette` or `tip.stamps` replaces the whole list; include
  every entry you want.
- **Changing a built-in.** `update_brush` refuses built-ins; duplicate first.

## Tools used

- `list_brush_presets`, `describe_brush`: find the base preset and read its facets.
- `create_brush`, `update_brush`, `duplicate_brush`: make and tune the brush.
- `check_brush`: prove it works for the host, and get a degraded spec when it doesn't.
- `check_brush_style`: hold the brush to the house media, colours and source licences.
- `preview_brush`: look at a sample stroke when the host renders previews.
- `add_brush_source`, `list_brush_sources`: images for image tips and grain.
- `import_brush_pack`: tips and grain from a Photoshop or Procreate pack.
