---
name: pixerate-paint-editor
description: How to make a picture in the Pixerate paint editor (natural media in the spirit of Painter and Rebelle) through its agent tools - canvas and paper (generated grain, depth, colour, families from cold pressed watercolour to canvas and gesso), layers, dry-media brushes (pencil, pastel, charcoal, airbrush, marker, ink, erasers, blender, smudge, Mixer Brush) with pressure, tilt, barrel rotation and velocity, the brush library, strokes as data that replay and vary, pigment colour mixing, previews and PNG, JPEG, WebP, PSD and JSON output. Use when asked to paint, sketch, draw, shade, block in, texture a layer with paper grain, mix paint colours, vary or repeat strokes, or when paint_stroke, set_paper, list_brushes, replay_strokes, fill_layer or mix_colors are available.
---

# Paint editor

A canvas (pixels and dpi) over a **paper**, with a stack of layers (pixel layers and groups with
opacity, blend modes, clipping and locks) on top. The paper is generated from a pattern and a
seed: its grain is a height map (peaks and valleys) that grain-responsive brushes follow, and it
is never part of a layer. Coordinates are document pixels, (0, 0) top-left, y down. See
`pixerate-agent-tools` for errors, namespacing and batching.

- **Brushes** are library presets (`list_brushes`): a tip from the shared engine (size,
  hardness, spacing, angle, roundness, opacity, flow, blend), a **grain** response, pen dynamics
  (pressure, tilt, velocity, jitter), a **rotation** mode (`fixed`, `stroke`, `barrel`) and an
  engine: `dab` (most media), `eraser`, or `mixer` (Mixer Brush, blender, smudge: they pick up and
  move paint already on the layer).
- **Grain**: a brush's grain response times the paper's `depth` decides how much light pressure
  skips the valleys. Pencil, pastel and charcoal are grainy; airbrush, marker and ink are not.
- **Strokes are data.** Every stroke is recorded (brush, colour, raw points, seed, symmetry
  copies) and gets a `strokeId`. `replay_strokes` paints recorded strokes again, exactly or
  varied. That is the main way an agent should make many similar marks.
- **Undo**: one tool call that changes the painting is one undo step (`undo_paint`). Brush,
  colour, view, hand and the Mixer Brush load are editor state, not undo steps.

## Working method

1. **Read.** `get_canvas_info` (size, paper, active layer, active brush, colour), then
   `list_layers`. `render_preview` to see the painting before changing it.
2. **Choose the ground.** Pick a paper that suits the medium (`list_papers`, `set_paper`, or
   `new_canvas` with `paper`): cold pressed or rough for broken, sparkling texture, sanded pastel
   paper for pastel, charcoal paper for charcoal, cotton canvas or gesso for painterly work,
   smooth bristol for ink. Set `depth` for how much texture you want.
3. **Block in big shapes first.** Put each pass on its own layer (`add_layer` with a name).
   `fill_layer` gives a ground colour (flat) or a tonal layer that catches the grain
   (`grain` 0.6..1, `pressure` 0.2..0.6). Paint large masses with a big soft pastel or airbrush
   in a few long `paint_stroke`s rather than many small ones.
4. **Mix colours before painting.** `mix_colors` predicts what paints mixed in given parts look
   like (Kubelka-Munk: blue and yellow make green, white tints rather than greys). Use the result
   as the stroke `color`. `set_color` makes it the default.
5. **Refine** with smaller brushes on new layers: pencil and ink for line, charcoal for value,
   blender or smudge to soften edges, the Mixer Brush to blend wet into wet.
6. **Repeat and vary instead of drawing every mark.** Paint one good stroke, then
   `replay_strokes` it with `dx` / `dy`, `rotate`, `scale`, `flipX`, `color`, `brushId` and
   `repeat` for hatching, grass, foliage, rows, fans or spirals, in one undo step.
7. **Check** with `render_preview` after each block of work, not after each stroke.
   `pick_color` reads exact values. Undo what made it worse.
8. **Deliver**: `export_image` (PNG, or JPEG / WebP in a browser), `export_psd` for Photoshop,
   `save_document` to keep the painting with its strokes.

## Best practices

- **Big to small, dark to light (or light to dark), one decision per layer.** Name layers by
  purpose ("Underpainting", "Shadows", "Line"). Lower a layer's `opacity` instead of repainting.
- **Pressure is your value control** on grainy media: points with `pressure` 0.2..0.4 give
  texture-catching, broken marks; 0.8..1 fills the grain. Vary pressure along a stroke (swell in
  the middle, lighten at the ends) for natural marks.
- **Give points a time `t`** (milliseconds, about 8..16 ms apart for natural speed) when using an
  ink or brush pen: velocity dynamics thin fast strokes. Without `t` there is no velocity effect.
- **Tilt** (`altitude` near 0.3..0.6 radians with an `azimuth`) turns a pencil into broad side
  shading; upright points draw a fine line.
- **Space points** about a third of the brush size apart or closer; the brush fills in dabs
  between them. Long smooth curves need more points than straight lines.
- **Use `rotation: "stroke"`** for flat tips (pastel, charcoal, chisel marker) so the mark turns
  with the path; `fixed` for calligraphic nibs.
- **Blend with flow, not opacity**: blender and smudge work best at flow 0.3..0.6; at full flow
  the Mixer Brush paints only its own colour.
- **Pigment for paint, multiply for markers**: tip `blend: "pigment"` mixes subtractively on the
  canvas; `multiply` darkens where marker strokes overlap. Pigment layers are written as Normal
  to PSD (the export warns).
- **Save brushes you build** (`set_brush` then `save_brush`), and share them with
  `export_brushes` / `import_brushes`.

## Tool reference

### Canvas and paper

| Tool | Use |
| --- | --- |
| `get_canvas_info` | Read the canvas size and dpi, paper (preset, colour, depth), active layer, layer count, active brush id, colours, view, hand, number of recorded strokes, undo / redo labels and the blend modes. Call first. |
| `new_canvas` | Start over with a blank canvas: one empty layer over the paper. `width`, `height` (1..16384 px), `dpi`, `paper` preset id; missing ones keep the current values. Undo brings the old painting back. Returns the size, paper and layer id. |
| `set_canvas` | Resize the canvas (pixels stay put, anchored top-left) or change its `dpi`. Returns the canvas. |
| `list_papers` | Read the paper library: id, name, family, grain pattern, colour, depth and the wet-media properties (absorption, permeability, roughness, stored for later wet media). Call before `set_paper`. |
| `get_paper` | Read every setting of the current paper (pattern, seed, scale, tiling, depth, shading, dry and wet tuning). |
| `set_paper` | Change the paper: `preset`, then any of `color`, `depth` (0..1), `scale` (0.25..8), `seed` (another sheet), `pattern`, `tiling`, `shading`, `dry` / `wet` tuning (`contrast` 0..3, `invert`). Affects new strokes' grain and how the paper shows; strokes already painted keep their pixels. Returns the paper. |

### Layers

| Tool | Use |
| --- | --- |
| `list_layers` | Read the layers top first: id, name, type (`pixel` / `group`), visible, opacity, blend, clipped, locks, `active`, painted `bounds` (null when empty), parent and depth. |
| `add_layer` | Add an empty pixel layer (or `type: "group"`) above the active layer, above `aboveId`, or at the top of group `parentId`; it becomes active. Returns the layer. Put each pass of a painting on its own layer. |
| `update_layer` | Change `name`, `visible`, `opacity` (0..1), `blend`, `clipped` (clip to the layer below) or `locks` (`pixels`, `transparency`: paint only where there is paint, `position`, `all`). Returns the layer. |
| `set_active_layer` | Make a layer the default target of strokes, fills and clears. Editor state. |
| `remove_layer` | Delete a layer (a group with its children). Prefer hiding it when the user may want it back. |
| `duplicate_layer` | Copy a layer directly above it (the copy becomes active): try a risky change on a copy. |
| `move_layer` | Reorder: `index` among siblings (0 = bottom), optionally into `parentId` (or `null` for the top level). |
| `merge_layer_down` | Merge a pixel layer into the pixel layer directly below (which keeps its settings). |
| `fill_layer` | Fill a pixel layer with `color` at `opacity`: flat, or with `grain` 0..1 following the paper grain (`pressure` 0..1 decides how far into the valleys, default 0.5). The fastest way to lay a ground or a textured tone. Returns the bounds. |
| `clear_layer` | Remove every pixel of a layer. Returns the bounds that were cleared. |

### Brushes

| Tool | Use |
| --- | --- |
| `list_brushes` | Read the library (built-in and saved): id, name, category, engine, size, grain response, rotation, `builtin`; plus the active brush id and whether it is edited. |
| `get_brush` | Read every setting of a brush, or of the active brush as edited (no `id`). Read before changing a brush you did not build. |
| `set_brush` | Choose the active brush (`id`) and / or change it: `tip` (size px, hardness, spacing, angle, roundness, opacity, flow, smoothing, pressureSize, pressureOpacity, blend), `grain`, `pressureSmoothing`, `rotation`, `dynamics` (minSize, pressureFlow, tiltSize, tiltRoundness, tiltOpacity, velocitySize, velocityOpacity, jitters, scatter), `mixer`, `loadsColor`. Editor state. Returns the brush. |
| `save_brush` | Store the active brush in the user library under `id` (lowercase, digits, dashes) and `name`. Built-in ids are refused. |
| `remove_brush` | Delete a user brush. Built-in brushes cannot be removed. |
| `export_brushes` | Get a brush library file (JSON) of `ids`, or of every user brush. |
| `import_brushes` | Add the brushes of a library file to the user library; taken ids are skipped unless `replace`. Returns `added`, `skipped`, `problems`. |
| `render_brush_thumbnail` | See what a brush does: a PNG of a test stroke (S-curve, pressure swelling and fading) on the current paper. Cheaper than painting and undoing. |

### Colour

| Tool | Use |
| --- | --- |
| `mix_colors` | Predict a paint mix: `colors` with `weight` parts (and optional tinting `strength`). Returns `mixed` (#rrggbb, Kubelka-Munk) and the plain RGB average for comparison. Changes nothing. Use it to choose stroke colours. |
| `set_color` | Set the default paint `color` (and `secondaryColor`). |
| `pick_color` | Read the colour at `x`, `y`: of the painting with its paper, or of one layer (with alpha). |
| `get_mixer_brush` | Read what the Mixer Brush carries: `reservoir`, `amount` left, `pickup`. |
| `load_mixer_brush` | Fill the Mixer Brush reservoir with a colour (keeps its pickup). |
| `clean_mixer_brush` | Empty the pickup well (and with `emptyReservoir` the paint). |

### Painting and strokes

| Tool | Use |
| --- | --- |
| `paint_stroke` | Paint one stroke through `points` (document px; `pressure` 0..1, `t` ms, `tiltX` / `tiltY` or `altitude` / `azimuth`, `twist`) with `brushId` (default the active brush), optional per-stroke `brush` changes, `color`, `layerId`, `seed`. Returns `layerId`, `bounds`, `dabs`, `strokeId` and for the mixer engine its `mixerLoad`. Refused on locked, hidden or group layers, with the fix in the message. |
| `list_strokes` | Read the recorded strokes, oldest first (default the last 100): id, layer, brush, colour, point count, seed, bounds. With `ids`, their points too. |
| `replay_strokes` | Paint recorded `strokeIds` again: exactly, or varied by `dx` / `dy` (px), `rotate` (degrees clockwise), `scale` (brush size follows), `flipX`, `origin`, `pressureScale`, `color`, `brushId`, `layerId`, `repeat` (each copy applies the variation again). One undo step. Returns the new stroke ids, bounds and layers. |
| `undo_paint` | Undo the last step. Returns what was undone and what is next. |
| `redo_paint` | Redo the step just undone. |

### View, input and output

| Tool | Use |
| --- | --- |
| `set_view` | Rotate (degrees), mirror or zoom the view, or `reset` it. View state only: pixels never resample. Mirroring is a quick check of a drawing's proportions. |
| `set_hand` | Say which hand holds the pen (`right` / `left`) for palm rejection. |
| `render_preview` | See the painting (or `layerIds`) as a PNG, longest side `maxSide` (16..2048, default 512), with or without the `paper`. Render after each block of work. |
| `export_image` | Export PNG (default), JPEG or WebP as base64, at `quality` and `scale` (≤ 1); `paper: false` gives a transparent PNG. JPEG / WebP need a browser canvas. |
| `export_psd` | Export a PSD with every layer, the paper as a locked bottom layer, and the composite. Returns base64, size, `psb` and `warnings`. |
| `save_document` | Get the document JSON (canvas, paper, layers as PNG data URLs, strokes unless `strokes: false`). |
| `open_document` | Open a saved document JSON, replacing the painting and clearing the undo history. Returns the canvas, layers and any `problems`. |

## Pitfalls

- **Stroke-by-stroke drawing is slow and expensive.** Do not draw a detailed picture point by
  point. Block in with fills and big strokes, then replay and vary a few good strokes.
- **A hidden or locked layer refuses paint**: show it (`update_layer visible true`) or unlock it.
  `transparency` lock is not an error: paint only lands where the layer already has paint.
- **Depth 0 means no grain** whatever the brush; grainy media then look smooth. Smooth bristol
  has depth 0.
- **Grain is fixed to the document**, not to the layer: moving content does not move the grain,
  and two strokes on the same spot catch the same peaks.
- **Big soft brushes at full flow look flat.** Lower `flow` (airbrush 0.05..0.15) and build up.
- **JPEG and WebP need a browser**; in Node use PNG. Exports never upscale (`scale` ≤ 1).
- **Recorded strokes are kept in saved documents**; `save_document` with `strokes: false` when
  only the pixels matter (smaller JSON).
