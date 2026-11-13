---
name: pixerate-paint-editor
description: How to paint in the Pixerate paint editor (natural media) through its agent tools - canvas and paper (generated grain, depth, families from cold pressed watercolour to canvas), layers with painterly blend modes (watercolor, tint, highlight, shadow), dry media (pencil, pastel, charcoal, ink) with pen dynamics, wet media (watercolour, gouache and oil that flow, bloom, granulate and dry), thick impasto paint lit by a movable light, blending tools (blender, smudge, Mixer Brush), brush behaviours (pick-up, dirty and multi-coloured brushes), the brush library, replayable strokes, symmetry and perspective guides, tracing and reference images, harmonies, swatches, a mixing pad, and PNG, JPEG, WebP, PSD and JSON output. Use when asked to paint, sketch, paint in watercolour, shade, blend, smudge, glaze, mix colours, paint symmetric or in perspective, trace an image, or when paint_stroke, set_paper, replay_strokes or mix_colors are available. Also effect paper, effect layers and light on paint from an effects provider.
---

# Paint editor

A canvas (pixels and dpi) over a **paper**, with a stack of layers (pixel layers and groups with
opacity, blend modes, clipping and locks) on top. The paper is generated from a pattern and a
seed: its grain is a height map (peaks and valleys) that grain-responsive brushes follow, and it
is never part of a layer. Coordinates are document pixels, (0, 0) top-left, y down. See
`pixerate-agent-tools` for errors, namespacing and batching.

- **Brush colours.** Choosing a brush with a default colour (highlighter yellow, ballpoint blue, chalk light or dark for the colour scheme) makes it the paint colour, unless the colour is locked (`set_color` `locked`). Set the colour after choosing the brush, or lock it first. Strokes painted in a light / dark colour (a brush's pair, or `set_color` `dualColor`) record the pair. Paint them on a stroke layer (`add_layer` type `strokes`) when they should follow the viewer's theme: the document keeps the light side and each viewer sees their own scheme's. A pixel layer (wet paint included) keeps the side it was painted in, and the view rebuilds it in the other scheme by replaying the stroke log with each pair in that scheme's side, so wet paint mixes the dark sides as it mixed the light ones; a layer holding pixels the log doesn't have (merged, moved, imported) can't be replayed and keeps its colours. `get_color_scheme_view` says which layer does what, and why.
- **Brushes** come from the shared brush library (`pixerate-brushes`: `list_brush_presets`, `create_brush`, `preview_brush`…) and are made of facets: a tip (size, hardness, spacing, angle, roundness, opacity, flow, blend), dynamics (pressure, tilt, velocity, jitter, a **rotation** mode `fixed`, `stroke` or `barrel`), behaviour (paper **grain** response, pick-up, wet or thick surface), marks, light, ferrofluid, motion and colour. `set_brush` chooses one and lays facet changes over it; `get_brush` reads it with the engine it paints with: `dab` (most media), `eraser`, `mixer` (the Mixer Brush: a reservoir of paint plus paint it picks up), `blender` (mixes the colours under and near the tip) or `smudge` (drags paint along the stroke), `wet` (watercolour, gouache, oil and the wet tools, below), `impasto` (thick paint with relief and material, below), `particle` (procedural particle brushes), `bristle` (a tuft of bristles), `vortex` (winds surrounding paint around the drawn shape), `sticker` (sprays editable stickers) or `antimatter` (blasts that invert, scorch and annihilate paint across every visible layer).
- **Wet media** (engine `wet`: `behaviour.surface` `wet`, and the wet tools; categories `watercolor` and `wet-tool`): a stroke lays water and pigment on the layer's **wet layer**, a fluid simulation that keeps running after the stroke: the water spreads until its edge is pinned by the paper, carries pigment out to the rim as it dries (edge darkening), drops pigment into the paper's valleys (granulation), pushes pigment back where new water flows in (blooms), bleeds between touching wet colours and runs downhill on a tilted canvas. Paint stays wet until it dries by itself (a few thousand steps) or `dry_paint` dries it; a dried wash is fixed, so the next wash **glazes** over it. A wet brush paints, or is a tool (`tool` `water`, `dryer`, `blow`, `blot`, `wet-blend`, `wet-drag`); `behaviour.wet` `water`, `pigment` (concentration), `body` (0 transparent watercolour .. 1 opaque gouache) and `rewet`, and `behaviour.strength`, set it up. Every result says whether paint is still wet (`wet` / `stillWet`).
- **Behaviour** (`behaviour.exchange`, dab and mixer brushes) is how a brush treats paint already on the canvas: a **pick-up ratio** (how much paint each dab lifts and carries), a **mix ratio** (how much of the carried paint goes into what it lays down), **dirty** (keep the carried colour into the next stroke) and **multi-colour** (`tip`: several colours side by side across the tip; `dab`: the colour changes along the stroke). A Mixer Brush's `mixer.wet` / `mixer.mix` are the same two ratios. `get_mixer_brush` reads what the brush carries; `clean_mixer_brush` wipes it.
- **Grain**: a brush's grain response times the paper's `depth` decides how much light pressure
  skips the valleys. Pencil, pastel and charcoal are grainy; airbrush, marker and ink are not.
  A brush can also carry its own texture, `tip.grain` (a pattern such as `sanded` or `canvas`, or
  an image source; `texturised` stays put, `moving` rolls with the tip), which shows on any paper.
- **Image tips**: a stamp tip whose stamp is an image source (`source:<id>`, added with the
  brush library's `add_brush_source`) paints every dab as that image in the paint colour, with
  hardness, roundness, angle, pressure size, `dynamics.count`, `flip` and jitter. Strokes record
  the source, and the saved painting carries its bytes, so replays and exports match.
- **Strokes are data.** Every stroke is recorded (brush, colour, raw points, seed, symmetry
  copies) and gets a `strokeId`. `replay_strokes` paints recorded strokes again, exactly or
  varied. That is the main way an agent should make many similar marks.
- **Stroke layers keep strokes editable** (`add_layer {type: "strokes"}`): tune a stroke's brush,
  colour, seed or points after painting it instead of repainting. See "Stroke layers" below.
- **Guides** are editor state saved with the document: a symmetry guide makes every stroke paint
  its mirror or kaleidoscope copies (one stroke), a perspective guide snaps strokes to lines
  towards one to three vanishing points, a tracing image sits under the paint (never exported)
  and can supply stroke colours, and reference images float beside the canvas to pick from.
- **Undo**: one tool call that changes the painting is one undo step (`undo_paint`). Brush,
  colour, view, hand and the Mixer Brush load are editor state, not undo steps.

## Workflow skills

For these jobs, load the workflow skill too: it has the method, the checks between steps and
the pitfalls, and uses the tools below.

- `pixerate-paint-watercolour`: paper, light to dark, wet-in-wet and wet-on-dry, drying and glazing.
- `pixerate-paint-oil-impasto`: toned ground, thin to thick, pigment mixing, impasto and its light.
- `pixerate-paint-sketch-to-finish`: sketch, ink, flats, clipped shading and light, one layer per pass.
- `pixerate-paint-mutation`: claim a user's mutation stroke (`read_mutation`), let it fade, and paint an answer (`answer_mutation`).

## Working method

1. **Read.** `get_canvas_info` (size, paper, active layer, active brush, colour), then
   `list_layers`. `render_preview` to see the painting before changing it.
2. **Choose the ground.** Pick a paper that suits the medium (`list_papers`, `set_paper`, or
   `new_canvas` with `paper`): cold pressed or rough for broken, sparkling texture, sanded pastel
   paper for pastel, charcoal paper for charcoal, cotton canvas or gesso for painterly work,
   smooth bristol for ink. Set `depth` for how much texture you want.
3. **Block in big shapes first.** Put each pass on its own layer (`add_layer` with a name). `fill_layer` gives a ground colour (flat) or a tonal layer that catches the grain (`grain` 0.6..1, `pressure` 0.2..0.6). For line art, call `find_unfilled_regions` against the ink layer (`reference: inkLayerId`, `closeGap: 4..8`) to list enclosed shapes and their interior seed points, then `fill_region` on a flats layer below the ink (`reference: inkLayerId`, `closeGap: 4..8`, `expand: 1..2` so no halo shows at anti-aliased line edges, or `wet: true` to pour a watercolour wash into the region). For unoutlined masses, paint with a big soft pastel or airbrush in a few long `paint_stroke`s rather than many small ones.
4. **Plan and mix colours before painting.** `color_harmony` gives a palette around a key colour (on the painter's red-yellow-blue wheel by default). `mix_colors` predicts what paints mixed in given parts look like (Kubelka-Munk: blue and yellow make green, white tints rather than greys); the mixing pad (`mixing_pad_stroke`, `pick_mixing_pad_color`) mixes by hand with a palette knife. Keep chosen colours as swatches (`add_swatch`). Use the result as the stroke `color`; `set_color` makes it the default.
5. **Refine** with smaller brushes on new layers: pencil and ink for line, charcoal for value. **Blend** on the layer that holds the paint: `blender` to melt neighbouring colours together (pigment mixing, so blue next to yellow goes green), `smudge` / `wet-smudge` to drag paint into soft edges and streaks, `mixer-brush` to paint wet into wet, `dirty-round` to paint with a brush that picks up and carries colour, `multicolor-flat` for strokes loaded with several colours. Glaze with a `watercolor` layer, warm or cool with `tint`, light with `highlight`, shade with `shadow`.
6. **Let the guides multiply your marks.** `set_symmetry` (mirror for faces and vases, kaleidoscope for mandalas and ornaments) paints every copy from one stroke; `set_perspective_guide` plus `paint_stroke` with `snapToPerspective` lays converging lines for buildings and roads. To copy an image's composition and colours, `set_tracing_image` with `sampleColors` and paint over it.
7. **Repeat and vary instead of drawing every mark.** Paint one good stroke, then `replay_strokes` it with `dx` / `dy`, `rotate`, `scale`, `flipX`, `color`, `brushId` and `repeat` for hatching, grass, foliage, rows, fans or spirals, in one undo step.
8. **Check** with `render_preview` after each block of work, not after each stroke. `pick_color` reads exact values. Undo what made it worse.
9. **Watercolour** is its own way of working: see "Wet media" below.
10. **House style.** When the host has one (`get_style` with `domain: "paint-editor"`), run
   `check_paint_style` before you start and before delivering; `fix_paint_style` switches to the
   house paper and brush. Paint with house colours (`get_style`'s `swatches`).
11. **Deliver**: `export_image` (PNG, or JPEG / WebP in a browser), `export_psd` for Photoshop, `save_paint_document` to keep the painting with its strokes (when the host has storage).

## Best practices

- **Big to small, dark to light (or light to dark), one decision per layer.** Name layers by purpose ("Underpainting", "Shadows", "Line"). Lower a layer's `opacity` instead of repainting.
- **Pressure is your value control** on grainy media: points with `pressure` 0.2..0.4 give texture-catching, broken marks; 0.8..1 fills the grain. Vary pressure along a stroke (swell in the middle, lighten at the ends) for natural marks.
- **Give points a time `t`** (milliseconds, about 8..16 ms apart for natural speed) when using an ink or brush pen: velocity dynamics thin fast strokes. Without `t` there is no velocity effect.
- **Tilt** (`altitude` near 0.3..0.6 radians with an `azimuth`) turns a pencil into broad side shading; upright points draw a fine line.
- **Space points** about a third of the brush size apart or closer; the brush fills in dabs between them. Long smooth curves need more points than straight lines.
- **Brush geometry with `stroke_path`**: for clean curves, circles, outlines and lettering, give SVG path data and a `pressure` taper instead of hundreds of points; the brush keeps its grain and character. Send the shape as one path with several subpaths to keep it one undo step.
- **Use `rotation: "stroke"`** for flat tips (pastel, charcoal, chisel marker) so the mark turns with the path; `fixed` for calligraphic nibs.
- **Blending tools**:
  - `blender`: `strength` 0.3..0.6 for soft transitions, `distance` 0.2..0.5 (fraction of the tip) for how far colours travel. Keep `mixing: "pigment"` for painterly blends; `rgb` blends like a soft blur. Work along an edge in short strokes rather than over everything.
  - `smudge`: `length` near 0.9 drags paint far (long streaks), 0.5 short pushes; `strength` 0.5..0.8. `mixing: "pigment"` (the `wet-smudge` preset) smears colours into each other like wet paint.
  - Mixer Brush: blend with flow 0.3..0.6; at full flow it paints only its own colour.
- **Pick-up and mix ratios**: `pickup` 0.3..0.7 with `mix` 0.4..0.7 gives a brush that drags the colours it crosses into its own; `dirty: true` keeps them for the next stroke (wipe with
  `clean_mixer_brush`). Keep `pickup` 0 for clean, predictable colour.
- **Multi-colour**: give 2..8 `colors` (or none for the paint and secondary colours). `tip` mode with a flat tip and `rotation: "stroke"` paints ribbons (`softness` 0.3..0.7); `dab` mode with `order: "sequence"` and `length` 5..20 walks through a palette (`random` for foliage and confetti).
- **Pigment for paint, multiply for markers**: tip `blend: "pigment"` mixes subtractively on the canvas; `multiply` darkens where marker strokes overlap. Pigment layers are written as Normal to PSD (the export warns).
- **Painterly layer modes do the glazing for you** (`update_layer` `blend`, or a brush tip):
  - `watercolor`: transparent wash; washes multiply wavelength by wavelength (blue over yellow makes green, white is clear; opacity 0.4..0.8).
  - `tint`: recolours what is below (hue and chroma) and keeps its lightness.
  - `highlight`: adds coloured light that rolls off towards white without clipping (black does nothing).
  - `shadow`: shades as if light were blocked, coloured by the layer, never crushing to black (white does nothing).
  PSD has none of them: `export_psd` writes the nearest standard mode and warns; the merged image stays exact.
- **Grow the canvas instead of starting big** with `extend_canvas` (pixels per side; nothing painted moves relative to anything else). Adding `left` or `top` shifts every coordinate you hold by (+left, +top): re-read `list_layers` or use the returned `rect`. Dry wet paint first. `set_canvas` only crops or grows at the bottom-right.
- **Save brushes you build** in the brush library: `create_brush` with `basedOn` and the facets you changed, and share them with `export_brushes` / `import_brushes`. A saved brush shows in every editor that shares the library; `set_brush` its id to paint with it.

Which facet sets which engine setting: [references/brush-facets.md](references/brush-facets.md).

## Wet media

Watercolour, gouache and wet oil run on a fluid simulation: lay washes light to dark, let them flow (`advance_wet_paint`), dry them (`dry_paint`) before glazing. Nothing moves for an agent until you advance or dry it, and saving dries the paint. Load `pixerate-paint-watercolour`, and read [references/wet-media.md](references/wet-media.md) for the engine and the wet tools. **Ghost paint and invisible ink** (`ghost` facet: `ghost-wash`, `ghost-gouache`, `ghost-oil`, `invisible-ink`) mix and flow while wet, then fade without leaving their own colour, leaving only a smear in the paint they touched: read [references/ghost.md](references/ghost.md).
**Live patterns** (Gray-Scott reaction-diffusion spots, stripes, coral, maze and worms that grow
in wet paint and freeze when it dries; presets `turing-wash`, `coral-ink`):
[references/live-patterns.md](references/live-patterns.md).

## Oils, thick paint and smart inks

Wet oil blends where the brush meets it; impasto adds relief lit by `set_lighting`, and `iridescence` (`scarab-lacquer`, `soap-film`, `pearl-glaze`) adds thin-film structural colour that shifts hue with light and `set_view_tilt`: load `pixerate-paint-oil-impasto` and read [references/oils.md](references/oils.md). **Light paint** (neon, glowing glass and watercolour: `light.amount`, the Light category; backlit paper): [references/light-paint.md](references/light-paint.md).
**Smart inks** (`fluorescence` for UV/invisible ink under `set_uv_light`, `thermochromic` for heat-reactive ink with `paint_heat` / `advance_heat`; presets `uv-marker`, `thermo-ink`): [references/smart-inks.md](references/smart-inks.md).
**Ferrofluid paint** (`ferro.amount`, presets `ferrofluid` and `ferro-ink`, pulled by dipole magnets into lit Rosensweig spikes until cured): [references/ferrofluid.md](references/ferrofluid.md).
**Specialty paint needs the canvas set up.** Ferrofluid, UV-fluorescent and thermochromic ink, thin-film iridescence, ghost, mutation and live-pattern brushes (the brush library's Specialty group) only show their effect with magnets, the UV blacklight, heat, a tilted view, a mutation agent or running wet time. After `set_brush` with one, call `get_specialty_guides`: each guide says how the paint behaves, `status` / `ready` say whether the canvas is set up now, and `actions` are the quick setups that apply (the tool and its arguments, such as `set_uv_light` `{ on: true }` or `add_magnet` at the centre). Run an action's tool, paint, then read the guides again to check `ready`. A standard brush returns no guides.
**Painting time machine** (non-destructive museum ageing preview `set_age` / `bake_age`, X-ray pentimento radiographs `render_xray` / `set_xray_view`, and the `paint-scraper` brush that excavates through layers): [references/time-machine.md](references/time-machine.md).
**Biopaint (mycelial ink)** (`culture` facet, presets `mycelial-ink`, `rot`, `foxfire`: spores seeded along a stroke grow fine branching threads that seek out existing paint, digest it, carry its colour along the network, and fuse into loops; `grow_cultures` steps them): [references/culture.md](references/culture.md).

## Gradient paint

Paint that changes colour as the stroke goes (`set_paint` with a gradient, a brush's own `paint`,
or `paint_stroke` `paint`): read [references/gradient-paint.md](references/gradient-paint.md).

## Layer effects

Live layer styles on a paint layer, drawn from its pixels so they follow later painting: outer and
inner glow, shadows, stroke, bevel, satin and overlays, as in the image editor
(`add_layer_effect` and the rows below). Read [references/layer-effects.md](references/layer-effects.md).

## Procedural brushes, bristles, stickers and stencils

- **Particle brushes** (category `procedural`; ribbons, flames and bokeh are in `light`):
  `hair-strands`, `spring-ink`, `orbit-curls`, `flow-fur`, `sparkle-dust`, `bead-trail`. Tune
  with `marks` (kind `particles`): physics (string, spring, orbit, flow, elastic, fuzzy), render
  (dot, line, sequence, ribbon), waves and textured dots (`tip.stamps`); read [references/particle-brushes.md](references/particle-brushes.md).
  Draw slowly and with varying direction: the particles react to movement.
- **Antimatter paint** (`marks.kind: "antimatter"`, presets `antimatter`, `antimatter-flare`,
  `antimatter-charge`): does nothing on bare canvas, and detonates wherever it touches paint across
  every visible layer — inverting colours (`rgb` or `oklab`), removing alpha (`annihilate`), burning
  a soot ring (`scorch`), carving craters into impasto relief (`crater`), clearing core light and
  throwing sparks in the brush colour on the active layer, all in one undo step. Read
  [references/antimatter.md](references/antimatter.md).
- **Bristle brushes** (category `bristle`): `bristle-round`, `bristle-flat`, `dry-brush`. Every
  bristle draws its own line: press harder to splay the tuft, tilt to flatten it; soft bristles
  bend into curves at turns; a low `tip.bristle.load` runs dry into broken streaks.
- **Vortex paint** (`marks.kind: "vortex"`, presets `vortex`, `ink-vortex`, `whirlpool`, `wet-vortex`):
  the stroke you draw becomes the shape of a vortex (`point` whirlpool, `open` racetrack, or
  `closed` loop) that pulls in and winds surrounding paint around it (`reach`, `turns`, `pull`,
  `direction`, `ink`, `duration`). On wet layers (`wet-vortex` or any vortex brush over wet paint)
  it spins the wet fluid directly. Read [references/vortex.md](references/vortex.md).
- **Sticker spray** (category `sticker`): stickers by ref (`editor:star`, `editor:leaf`… or any
  from the host's library: `find_stickers`; tintable ones paint as a flat silhouette in the paint
  colour, shaped by the art's alpha, and others keep their own pixels) sprayed onto an
  **empty layer**, each staying an object:
  `add_stickers` (exact places), `sticker_at`, `list_stickers`, `update_sticker`, `arrange_stickers`,
  `remove_stickers`. A sticker layer takes no other paint; sprays are refused under an enabled
  mask stencil (hide it with `update_stencil` `enabled` false, then remove unwanted stickers).
  **Animated stickers** (`describe_sticker` says `animated`, `frameCount`, `frameDelay` ms) stamp
  one frame per sticker, chosen by the brush's `marks.frameMode`: `perform` (default) plays the
  animation as the stroke is drawn, frame = floor(ms since the stroke's first point / frameDelay)
  mod frameCount, so it needs points with `t` (untimed points all stamp frame 0); `random` picks a
  seeded frame per sticker and needs no times. Each sticker keeps its `frame` (left out when 0), so
  redraws, `sticker_at`, undo, saving and replays show the same frame; `add_stickers` and
  `update_sticker` take `frame` (0..frameCount-1; past the last, or above 0 on a static sticker,
  is refused), and restamping (`ref`) without `frame` goes back to frame 0.
- **Stroke layers**: pixels drawn from the layer's strokes; they take `dab`, `particle`, `bristle`
  and Mixer Brush strokes that pick up no paint, erasers, and light (`light.amount`, e.g. the
  highlighter's glow or `neon-marker`). An eraser stroke is a stroke like the others: it erases
  what lies under it in the list, so editing, moving or removing the strokes under it (or the
  eraser itself) redraws exactly, and a dual-colour stroke that was partly erased follows the
  scheme with only what is left. Light comes and goes with the strokes that lay, cover or erase it.
  Wet, thick, sticker, smudge, blender and pick-up strokes are refused (paint them on a pixel
  layer). `list_strokes {live: true}` → `update_stroke` / `edit_stroke_points` / `reorder_stroke` /
  `remove_strokes`; `rasterize_stroke_layer` once settled.
- **Stencils**: `add_stencil` lays a `ruler` or `arc` (strokes that start within `snap` px follow
  it exactly: straight lines, circles, rainbows) or a `line` / `shape` mask (paint lands only on
  one side or inside a rect, ellipse or polygon; `invert` for outside). Stencils stay until
  removed (`remove_stencils`); masks are recorded with each stroke so replays keep them.

## Provider effects

When the host registers an effects provider (`setEffectsProvider`), shaders and generators from
it work with the painting. Search first: `search_effects` with `use` `generator` (paper, layers,
fills), `overlay` / `title` (layers, fills) or `filter` (light on paint), then `describe_effect`
for the controls and presets.

- **Effect paper**: `set_paper_effect` draws a generator over the sheet, under every layer (`multiply` keeps the paper's colour and grain showing through; `normal` covers it).
- **Effect layers** (`add_effect_layer`): a pixel layer drawn by a generator, overlay or title effect (`update_effect` redraws and replaces its pixels, so paint on a layer above it).
- **Effect fills** (`fill_layer_with_effect`): the effect composited onto a layer's pixels (`lockTransparency` colours only what is painted).
- **Light on dried paint** (`apply_effect`): a filter run on a layer's dried paint and baked in at `opacity` strength, keeping thick relief.
- **Effect paint** (`set_effect_paint`): brushes paint with the effect itself; see below.

## Effect paint

`set_effect_paint` makes a generator, overlay or title effect the paint: rendered once, every stroke takes each pixel's colour from it, fixed to the canvas (painting reveals a hidden image); transparency paints nothing. Call `search_effects` with `place: "paint"` and `describe_effect`, then `set_effect_paint` with `effect`, `values`, `time` (ms, default 0) and wait for it to return before painting.

**Paint hints.** Many effects only show a still frame when painted (framed scenes, loaders, titles, audio visualisers). A provider can mark the ones that make good paint with a `paint` hint (search results and `describe_effect` show it: `map`, `colors`, `values`, `live`, `repeat`, `size`); when its capabilities include `paintHints`, `search_effects` `place: "paint"` lists only those and `set_effect_paint` refuses the rest, saying to use an effect layer or fill. Picking a hinted effect starts from its hint: its `map` (and `repeat`), its `values`, the paint and secondary colours (`set_color`) in its `colors` controls, and `live`. So set the colours first, then call `set_effect_paint` with just `effect`; pass `map`, `values` or `live` only to change what the hint chose (yours win, control by control). `set_color`, `set_paint` or `remove_effect` (target and effect `paint`) go back to colour; `update_effect` (target and effect `paint`, `values`) renders new values. Along each stroke (`map`) or playing on stroke layers (`live`): [references/effect-paint.md](references/effect-paint.md).

**An effect no provider has:** write it. When `open_effect_authoring` is available (the editor's `authoredEffects` is `author`), open `pixel.blank`, write it in pixel expressions with `effect_authoring_set_source`, then `save_authored_effect`. The returned `authored.<name>` id works with `set_effect_paint`, `set_paper_effect`, `add_effect_layer` and `fill_layer_with_effect`, and the painting keeps its source. An effect whose source reads the picture with `sample(uv)` is a filter instead: run it on a painted layer with `apply_effect` (light, a glaze, a grade of your own). The method is in `pixerate-effect-authoring`.

| Want | Use |
| --- | --- |
| The effect inside brushed marks, hand-painted edges | `set_effect_paint` and a dry brush |
| The effect in a wash that flows, or in thick paint | `set_effect_paint` and a watercolour, gouache, oil or impasto brush |
| The effect inside an exact shape, unchanged by water | Paint the shape, dry it, then `fill_layer_with_effect` with `lockTransparency: true` |
| The effect over the whole sheet | `set_paper_effect` or `add_effect_layer` |
| A pattern that follows the stroke, or paint that moves | `map: { by: "stroke" }` (bends any effect as a strip), or `map: { by: "path" }` for effects with a path control (`accepts: ["path"]`: beams, trails, signatures); `live: true` on a stroke layer |

## Canvas-hosted layer

When `get_canvas_info` has `bounds`, the painting is a layer of a larger canvas and every position is a canvas coordinate: read [references/canvas-hosted.md](references/canvas-hosted.md).

## Tool reference

### Canvas and paper

| Tool | Use |
| --- | --- |
| `check_paint_style` | Check the painting against the house style: paper, brushes (current and per stroke), the layer limit, and the brand's colours on strokes, the current colour and swatches. Returns findings with a `target` (`{ paper }` / `{ brush }` with the house value, `{ stroke }`, `{ color: "current" }`, `{ swatch }`), and the checks that `ran` and were `skipped`. |
| `fix_paint_style` | Switch to the house paper and the house brush. Strokes already painted stay; returns what `changed` and the findings `left`. Hidden on a read-only painting. |
| `get_canvas_info` | Read the canvas size and dpi, its `origin` (moved by `extend_canvas`), paper (preset, colour, depth), active layer, layer count, active brush id, colours, view, hand, number of recorded strokes, undo / redo labels and the blend modes. Call first. |
| `new_canvas` | Start over with a blank canvas: one empty layer over the paper. `width`, `height` (1..16384 px), `dpi`, `paper` preset id; missing ones keep the current values. Undo brings the old painting back. Returns the size, paper and layer id. |
| `set_canvas` | Resize the canvas (pixels stay put, anchored top-left) or change its `dpi`. Returns the canvas. |
| `extend_canvas` | Add pixels on any side (`left`, `top`, `right`, `bottom`, default 0) keeping everything painted, the paper grain and the guides in place relative to each other. `left` / `top` move all document coordinates by that much. Wet paint stays wet and moves with it when `left` and `top` are multiples of 256; otherwise it dries first. One undo step. Returns `canvas`, `rect` (the new canvas in the previous coordinates) and `origin` (also in `get_canvas_info`). |
| `list_papers` | Read the paper library: id, name, family, grain pattern, colour, depth and the wet-media properties (absorption, permeability, roughness, stored for later wet media). Call before `set_paper`. |
| `get_paper` | Read every setting of the current paper (pattern, seed, scale, tiling, depth, shading, dry and wet tuning, and `metallic`, `backlight`, `backlightColor` when set). |
| `set_paper` | Change the paper: `preset`, then any of `color`, `depth` (0..1), `scale` (0.25..8), `seed` (another sheet), `pattern`, `tiling`, `shading`, `dry` / `wet` tuning (`contrast` 0..3, `invert`), `metallic`, `backlight` (0..1, light from behind: glazes glow, opaque paint blocks; preset `stained-glass`) and `backlightColor`. Affects new strokes' grain and how the paper shows; strokes already painted keep their pixels. Returns the paper. |

### Suggesting and answering paint

Contributing while the user paints: suggest with proposals ([references/painting-alongside.md](references/painting-alongside.md)), or answer `mutation` strokes ([references/mutation.md](references/mutation.md), `pixerate-paint-mutation`).

| Tool | Use |
| --- | --- |
| `propose_paint` | Suggest paint as a ghost the user accepts or dismisses: `title`, `rationale`, `ops` (`stroke` with points and a dry brush, `wash` over its layer, `echo` of stroke ids moved / turned / scaled / repeated) and where its new layer goes (`place` top, bottom or above `layerId`). Returns the proposal id, the ghost's `bounds` and the strokes it echoes. Use it for contributions the user didn't ask for. |
| `list_paint_proposals` | Read the pending paint proposals: id, title, rationale, who proposed it, op kinds, placement, bounds, the strokes it echoes and any since removed (`missing`), and whether accepting is allowed. Call before accepting or rejecting. |
| `accept_paint_proposal` | Paint a pending proposal on a new layer as one undo step recorded as the proposer's (`proposalId`). Only when the user said yes. Returns the layer id, stroke ids and undo step name. Refuses when a stroke it echoes is gone. |
| `reject_paint_proposal` | Dismiss a pending proposal (`proposalId`); nothing changes. Use it to withdraw a suggestion that no longer fits. Returns the id and title. |
| `list_mutations` | List pending mutations (`id`, `layerId`, `medium`, `bounds`, `age`, `state`, `strokes`) raised after the user paints with a `mutation` brush (`mutation-wash`, `mutation-ink`) and pauses (`includeAll: true` includes claimed, answered and declined). Call before `read_mutation`. |
| `read_mutation` | Claim a pending mutation (`id`) and start its fade so the user's paint sinks away (`padding` px around bounds, `maxSide` for the canvas preview). Returns `strokes` (points, colour, brush), `cropPng` and `canvasPng` (as images and structured data). Refused if already claimed. |
| `answer_mutation` | Paint your answer to a claimed mutation (`id`, `strokes` with `brush`, `color`, `points`, optional `layerId`, `note`). Runs through the paint director when present and commits as one undo step (`agent:<id>`). Returns `strokeIds` and `bounds`. Refused if not claimed or already answered. |
| `decline_mutation` | Give up on a mutation (`id`, optional `reason`) without answering so the user's paint stays on the canvas as ordinary paint. |

### Layers

| Tool | Use |
| --- | --- |
| `list_layers` | Read the layers top first: id, name, type (`pixel` / `group`), visible, opacity, blend, clipped, locks, `active`, painted `bounds` (null when empty), parent, depth and `effects` (how many layer effects). |
| `add_layer` | Add an empty pixel layer (or `type: "group"`, or `type: "strokes"` for a stroke layer whose strokes stay editable) above the active layer, above `aboveId`, or at the top of group `parentId`; it becomes active. Returns the layer. Put each pass of a painting on its own layer. |
| `update_layer` | Change `name`, `visible`, `opacity` (0..1), `blend`, `clipped` (clip to the layer below) or `locks` (`pixels`, `transparency`: paint only where there is paint, `position`, `all`). Returns the layer. |
| `list_layer_effects` | Read a layer's effects: the master switch, Scale Effects, margin, and each effect with its id, kind and settings, plus the pattern ids. Call before changing one. |
| `add_layer_effect` | Add a live effect (`outer-glow`, `inner-glow`, `drop-shadow`, `stroke`, …) with Photoshop's defaults changed by `settings`. One undo step. Returns its `effectId` and the layer's effects. |
| `update_layer_effect` | Change settings of one effect (by `effectId`) after painting: glow colour, size, opacity, blend. One undo step. Returns the layer's effects. |
| `remove_layer_effect` | Remove one effect (`update_layer_effect` `enabled: false` hides it instead). One undo step. |
| `set_layer_effects_enabled` | Turn all of a layer's effects on or off and set Scale Effects. One undo step. |
| `list_blend_modes` | Read every blend mode: id, label, group (`standard`, `pigment`, `painterly`), what the pigment and painterly modes do, and the `psd` mode export writes instead. Read before choosing a painterly mode. Changes nothing. |
| `set_active_layer` | Make a layer the default target of strokes, fills and clears. Editor state. |
| `remove_layer` | Delete a layer (a group with its children). Prefer hiding it when the user may want it back. |
| `duplicate_layer` | Copy a layer directly above it (the copy becomes active): try a risky change on a copy. |
| `move_layer` | Reorder: `index` among siblings (0 = bottom), optionally into `parentId` (or `null` for the top level). |
| `merge_layer_down` | Merge a pixel layer into the pixel layer directly below (which keeps its settings). |
| `fill_layer` | Fill a pixel layer with `color` at `opacity`: flat, or with `grain` 0..1 following the paper grain (`pressure` 0..1 decides how far into the valleys, default 0.5). The fastest way to lay a ground or a textured tone. Returns the bounds. |
| `fill_region` | Flood-fill one or more enclosed regions on a pixel layer (`x`, `y` or `points: [{x, y}]`). Set `reference` to an ink layer id (or `"all"` / `"composite"`, or `"layer"`), `closeGap` (0..32 px) to bridge small gaps in line art without leaking, `expand` (-16..16 px, e.g. 1..2 px) to bleed under anti-aliased lines so no halo shows, `grain` (0..1) for paper texture, or `wet: true` to pour a watercolour wash into the region on the wet layer. One undo step. Returns `layerId`, `bounds`, `pixelCount`, `regions`, and `leaked` (`true` when the fill touched the canvas border). |
| `find_unfilled_regions` | Find enclosed unfilled regions from a reference line-art layer (`reference: inkLayerId`) or `"all"` / `"composite"`, closing gaps up to `closeGap` px and excluding areas already painted on `layerId`. Changes nothing. Returns `regions` sorted largest first with an interior seed `point` (`{x, y}`) ready for `fill_region`, `centroid`, `bounds`, `pixelCount`, and `touchesEdge`. |
| `clear_layer` | Remove every pixel of a layer. Returns the bounds that were cleared. |

### Brushes

Listing, saving, sharing and previewing brushes are the brush library's tools (`pixerate-brushes`), registered by the host next to these.

| Tool | Use |
| --- | --- |
| `get_brush` | Read a brush as facets (`brush`), or the active brush as edited (no `id`), with the `engine` and `category` it paints with, `builtin` (an unchanged preset) and `strokePaint` (what its next stroke paints). Read before changing a brush you did not build. |
| `set_brush` | Choose the active brush (`id`, from `list_brush_presets`) and / or lay facets over it: `tip`, `marks`, `dynamics`, `behaviour`, `light`, `iridescence`, `ghost`, `mutation`, `ferro`, `culture`, `motion`, `colour`, `livePatterns` (objects merge, lists replace; marks of another kind replace the marks; `culture: null` or `unset: ["culture"]` drops biopaint spores), `unset` facets to drop. Editor state, not saved: `create_brush` stores a brush. Returns `brush` (facets), `engine` and `problems` (values clamped). The old flat fields (`particle`, `impasto`, `behavior`…) are refused. |

### Colour

| Tool | Use |
| --- | --- |
| `mix_colors` | Predict a mix: `colors` with `weight` parts (and optional tinting `strength`), `model` `pigment` (default, Kubelka-Munk: what pigment blends, the Mixer Brush, pigment blending tools and the pad do) or `rgb` (what normal blending and rgb mixing do). Returns `mixed` by the model plus `pigment` and `rgbLerp` for comparison. Changes nothing. Use it to choose stroke colours. |
| `set_color` | Set the default paint `color` (and `secondaryColor`); back to one colour after gradient paint or effect paint. `dualColor: { light, dark }` sets a pair for the light and dark schemes instead: strokes record it, and on a stroke layer every viewer sees their own scheme's side. `locked: true` keeps it when you choose a brush with a default colour (by default choosing the highlighter makes your colour its yellow). Returns both colours and `locked` (and `dualColor` when given). |
| `get_color_scheme_view` | Read how layers with light / dark strokes show them in the viewer's colour scheme (the host sets the scheme; it never changes the document or history): `strokes` (stroke layer, redrawn), `document` (already in the scheme's side), `replay` (pixel layer rebuilt from the stroke log; `state` building / ready / failed, and until ready it shows the side painted) or `kept` (pixels outside the stroke log, `reason` says from what). Returns `scheme`, `replay` (`state`, `items` of `total`, `error`) and `layers`. `wait: true` waits for the replay (seconds on a big wet canvas). Call it after painting dual colours on pixel layers, before relying on how other viewers see them. |
| `set_paint` | Set the paint: one colour, or gradient paint (`stops`, `space`, `map`, `softness`; see Gradient paint). Ends effect paint. Errors say what is wrong (unsorted stops, a bad mapping). Returns `paint`, `color`, `secondaryColor`. |
| `pick_color` | Read the colour at `x`, `y`: of the painting with its paper, or of one layer (with alpha). |
| `get_mixer_brush` | Read what the brush carries: the Mixer Brush `reservoir` and `amount` left, and `pickup` (paint picked up, kept by dirty brushes). |
| `load_mixer_brush` | Fill the Mixer Brush reservoir with a colour (keeps its pickup). |
| `clean_mixer_brush` | Wipe the brush: drop the picked-up paint a dirty brush or the Mixer Brush carries (and with `emptyReservoir` the Mixer Brush paint). |
| `color_harmony` | Get a harmony (`kind`: complementary, split-complementary, analogous, triadic, tetradic, square, monochromatic) around `color` (default the paint colour), on the `ryb` painter's wheel (default; red ↔ green) or the `rgb` wheel (red ↔ cyan), `spread` degrees for analogous and split. Changes nothing. |
| `list_swatches` | Read the swatches (index, colour, name, and `paint` for a gradient swatch). |
| `add_swatch` | Keep a colour (`color`) or a gradient (`paint`) as a swatch (saved with the document). |
| `remove_swatch` | Remove a swatch by `index`. |
| `mixing_pad_stroke` | Paint on the 360 × 220 mixing pad (pad px): `tool` paint lays `color` with a pigment Mixer Brush, `knife` smears what is there and mixes it as paint. Scratch space, not the painting, no undo. |
| `pick_mixing_pad_color` | Read the mix on the pad at `x`, `y` (averaged over `radius`, default 3); `setColor` makes it the paint colour. Null where the pad is bare. |
| `clear_mixing_pad` | Wipe the pad. |
| `mix_on_pad` | Mix `paints` (`color`, `parts`) on the pad in one call: blobs by parts, knife passes, and a fully mixed Kubelka-Munk core. Optional pile `x`, `y`, `radius`, `passes`, `clear`; `setColor` makes the mix the paint colour. Returns `color` and the pile `bounds`. The quickest way to get a paint colour from named paints. |
| `save_mixing_pad` | Keep the pad as it is under a `name` (saved with the document). Refused when the pad is empty. Returns the id. |
| `list_mixing_pads` | Read the kept pads (`id`, `name`). |
| `load_mixing_pad` | Put a kept pad back (replaces what is on the pad). |
| `remove_mixing_pad` | Forget a kept pad. |
| `render_mixing_pad` | See the pad as a PNG. |

### Painting and strokes

| Tool | Use |
| --- | --- |
| `paint_stroke` | Paint one stroke through `points` (document px; `pressure` 0..1, `t` ms, `tiltX` / `tiltY` or `altitude` / `azimuth`, `twist`) with `brushId` (default the active brush), optional per-stroke `brush` facet changes (as `set_brush` takes), `color` or `paint` (a gradient for this stroke), `layerId`, `seed`, `snapToPerspective`. The symmetry guide adds its copies; a sampling tracing image supplies the colour when `color` is missing. Returns `layerId`, `bounds`, `dabs`, `strokeId`, `mixerLoad` (for brushes that pick up paint) and, for antimatter brushes, `antimatter` (`blasts`, `sparks`, `fuel`, `layers`, `skippedLayers`; `blasts: 0` and `bounds: null` over bare canvas). Refused on locked, hidden or group layers, with the fix in the message. |
| `stroke_path` | Brush SVG path data (`path`, document px; M, L, C, Q, A, Z…) with the active brush or `brushId` / `brush`, as if drawn along it by hand: each subpath one recorded stroke, sampled every `spacing` px (default 2), with a `pressure` profile spread along each subpath (`[0.2, 1, 0.2]` tapers both ends) and optional `speed` (px/ms, stamps each sample with `t`). With an agent director, each subpath is painted live in turn. One undo step. Returns `layerId`, `bounds`, `dabs` and `strokeIds` (for `replay_strokes`, `update_stroke`). Use it for clean curves, outlines of shapes and lettering guides instead of working out points; use `paint_stroke` when the marks need variable timing or tilt. |
| `list_strokes` | Read the recorded strokes, oldest first (default the last 100): id, layer, brush, colour, point count, seed, bounds, `live`. With `ids`, their points too; with `layerId`, one layer's. With `live: true`, the editable strokes of stroke layers as they are now, bottom first: the ids for the stroke layer tools. |
| `get_live_stroke` | Read the stroke the user is painting right now (layer, brush, colour, samples so far; `live: false` when none). For painting along with the user; hosts stream the samples live. |
| `stroke_at` | Read the top-most stroke of a stroke layer that painted the pixel at `x`, `y`, or null. Use it to pick one stroke among overlapping ones. |
| `update_stroke` | Change a stroke on a stroke layer: `brushId` (keeps its size), `brush` facets (as `set_brush` takes), `color`, `paint` (null drops a gradient), `seed`. Redraws exactly. One undo step. Returns the stroke and the changed `bounds`. |
| `edit_stroke_points` | Replace a stroke's `points`, or `transform` it (`dx`, `dy`, `scale`, `rotate`, `flipX`, about its centre or `origin`). One undo step. Returns the stroke with its points and the changed `bounds`. |
| `reorder_stroke` | Move a stroke to `index` in its stroke layer (0 = bottom). One undo step. Returns the order. |
| `remove_strokes` | Delete whole strokes from stroke layers. To erase part of one, paint an eraser stroke on the layer instead (it stays editable, and removing it brings the paint back). One undo step. Returns the ids and `bounds`. |
| `convert_to_stroke_layer` | Make an empty pixel layer a stroke layer. Returns the layer. |
| `rasterize_stroke_layer` | Turn a stroke layer into a plain pixel layer with the same pixels (strokes no longer editable). Do it before smudging, blending, wet paint or filling on it (erasers and light paint on stroke layers). |
| `replay_strokes` | Paint recorded `strokeIds` again: exactly, or varied by `dx` / `dy` (px), `rotate` (degrees clockwise), `scale` (brush size follows), `flipX`, `origin`, `pressureScale`, `color`, `brushId`, `layerId`, `repeat` (each copy applies the variation again). One undo step. Returns the new stroke ids, bounds and layers. |
| `breed_strokes` | Breed `count` (2..12, default 4) mutated variants from recorded `strokeIds` (1..16) as ghost paint proposals: `mutation` (`geometry`, `color`, `brush`, `seed`, each 0..1), `seed`. Returns `proposalIds` and each variant's `diff` and `bounds`. Read [references/evolution.md](references/evolution.md). |
| `breed_proposal` | Breed `count` (2..12, default 4) next-generation variants from `proposalIds` (1 id mutates it; 2 ids cross their points and brush facets over, then mutate), with `mutation` and `seed`. Returns `proposalIds` and `proposals`. |
| `get_proposal_genome` | Read a pending proposal's stroke genome (`proposalId`): `strokes` with full brush facets, points, colour and seed. |
| `undo_paint` | Undo the last step (a wet stroke's undo puts the wet paint back as it was before it). Returns what was undone and what is next. |
| `redo_paint` | Redo the step just undone. |

### Wet media

| Tool | Use |
| --- | --- |
| `get_wet_paint` | Read the wet paint: `wet`, the clock, `paused`, `speed`, `tilt`, the kernel (`backend`, `message` when it runs slower than it could, e.g. on one thread because the page is not cross-origin isolated (COOP / COEP)), the GPU accelerator (`engine`) and each wet layer (`wetCells`, `wetBounds`, `activeTiles`, settings, flow map, and `ghost: { remaining }` while ghost paint is fading). Call after wet strokes. |
| `advance_wet_paint` | Let time pass: `steps` (120 = one second at the default speed) or `seconds`. The paint spreads, blooms, runs and dries. Not an undo step. Returns `steps`, `clock`, `stillWet`, `layers`. Call after a group of wet strokes, before `render_preview`. |
| `dry_paint` | Dry wet paint at once where it is (one layer with `layerId` or all, optionally inside `rect`). One undo step. Returns `dried` (layer ids and rectangles) and `stillWet`. Dry before glazing over a wash. |
| `wet_paper` | Pre-wet the paper with clear water over `rect` (default the canvas) on a layer, `amount` 0..1, for wet-in-wet. One undo step. Returns the rectangle and `wet`. Then paint into it. |
| `set_wet_settings` | A layer's wet settings 0..1: `viscosity`, `evaporation`, `edgeDarkening`, `pigmentWeight`, `granulation`, `pickup`, `fixture`, `bloom`, `bleed`. Saved with the document, not an undo step. Returns `params`, `stillWet`. |
| `set_flow_map` | Push a layer's water in a pattern: `kind` linear (`angle`), swirl (`center`, `clockwise`), radial, turbulent (`scale`, `seed`) or none, at `strength`. Returns `flow`, `stillWet`. |
| `set_canvas_tilt` | Tilt the canvas (`angle` 0..90°, `direction` downhill clockwise from the bottom): wet paint runs downhill, very wet paint drips. Returns `tilt`, `stillWet`. |
| `pause_wet_paint` | Stop or resume time (`paused`) and set `speed` (steps per second). Editor state. |
| `set_water_overlay` | Show where the water is (`visible`), view only. |
| `set_wet_engine` | Let Engine B (WebGPU in browsers, Metal in the Swift editors) shade large washes (`gpu` "auto", the default) or force the CPU (`gpu` "off"); `minTiles` sets the wet area at which the GPU takes over. Never changes the result, only how it is drawn; editor setting, not saved, not an undo step. Returns `engine` (`state`: off, not-started, starting, unavailable, standby, active, failed; `reason`, `adapter`). |
| `set_instant_dry` | `on`: every wet stroke dries as it ends (same undo step); off (default) wet paint keeps moving. Returns `instantDry`. |
| `get_live_patterns` | Read live reaction-diffusion pattern fields on one layer (`layerId`) or every layer, plus the Pearson `presets` (`spots`, `stripes`, `coral`, `maze`, `worms`) and built-in `brushPresets` (`turing-wash`, `coral-ink`). Returns `layers` (`active`, `settings`, `activeTiles`, `patternCells`, `wetPatternCells`, `maxV`, `meanV`, `bounds`). Changes nothing. |
| `set_live_patterns` | Configure a layer's Gray-Scott reaction-diffusion settings (`layerId`, `pattern`, `feed`, `kill`, `scale`, `contrast`, `secondColor`, `relief`). One undo step. Returns `layerId`, `settings`, `stats` and `stillWet`. |
| `seed_live_patterns` | Seed Gray-Scott reagent V at `points` (`[{x, y}]` in document px) with `radius` and `seed` on a layer (`layerId`, default active), optionally updating pattern settings (`pattern`, `feed`, `kill`, `scale`, `contrast`, `secondColor`, `relief`). Follow with `advance_wet_paint` to grow the pattern while wet, then `dry_paint` to freeze it. One undo step. Returns `layerId`, `seeded`, `radius`, `seed`, `settings`, `stats`, `stillWet`. |

### Thick paint, light and smart inks

| Tool | Use |
| --- | --- |
| `set_lighting` | Move the light for thick paint, thin-film iridescence and metallic paper: `azimuth` (degrees clockwise from the top), `elevation` (5..90), `relief` (0..1). Nothing is repainted; not an undo step. Returns the lighting. Use a low elevation to show brushwork. |
| `set_view_tilt` | Tilt the view angle (`x` -1..1 left to right, `y` -1..1 top to bottom) to shift thin-film iridescent hue and specular glints without moving the light. View state only, not saved, not an undo step. Returns `viewTilt`. |
| `get_view_tilt` | Read the current `viewTilt` (`{ x, y }`). Changes nothing. |
| `get_relief` | Read a layer's relief (`bounds`, `maxHeight` 0..255, null when flat) and the lighting. Changes nothing. |
| `flatten_relief` | Remove a layer's relief, material and thin-film iridescence (rim and clarity too), keeping its colour and light. One undo step. Returns whether anything was flattened. |
| `get_light` | Read a layer's light paint: `hasLight`, `bounds`, `peak` 0..255 and its `spill`. Changes nothing. |
| `set_light_spill` | How far a layer's light spills (`radius` px, 0 off) and how strongly (`strength` 0..2). Not an undo step; nothing is repainted. |
| `clear_light` | Take a layer's light away, keeping its colour. One undo step. |
| `set_uv_light` | Switch the virtual UV blacklight (`on`) and set its glow `strength` (0..2, default 1) and `ambient` daylight level (0..1, default 0.15) to reveal `fluorescence` strokes (`uv-marker`). Saved with the document, not an undo step. Returns the UV settings and `fluorescentLayerIds`. |
| `get_uv_light` | Read the UV blacklight settings (`on`, `strength`, `ambient`) and `fluorescentLayerIds`. Changes nothing. |
| `paint_heat` | Warm or cool the canvas heat field along `points` (`radius` px default 24, `temperature` 0..1 default 1): shifts `thermochromic` strokes (`thermo-ink`) toward their `hotColor` above `threshold` and dries wet paint under hot cells. One undo step. Returns heat stats and `dried`. |
| `advance_heat` | Step thermal diffusion and Newtonian cooling by `steps` (1..200, default 10) so warm patches spread and fade. Not an undo step. Returns `steps`, heat stats and `dried`. |
| `clear_heat` | Cool the entire canvas heat field back to 0 at once so thermochromic paint returns to its cold colour. One undo step when warm. Returns `{ cleared }`. |
| `get_specialty_guides` | After `set_brush` with a specialty brush (ferrofluid, UV or thermochromic ink, iridescence, ghost, mutation, live patterns), before painting: one guide per specialty the brush has (`kind`, `title`, `howToUse`, `status`, `ready`) and `actions`, each the tool and `arguments` that set the canvas up now (`set_uv_light`, `paint_heat`, `advance_heat`, `clear_heat`, `add_magnet`, `cure_ferrofluid`, `set_view_tilt`, `seed_live_patterns`). Call that tool, then read the guides again to check `ready`. Empty for standard brushes. Changes nothing. |
| `get_heat` | Read the canvas heat stats (`max`, `mean`, `hotCells`, `bounds`), optional temperature `samples` at `points`, and `thermochromicLayerIds`. Changes nothing. |
| `add_magnet` | Place a dipole magnet at `x`, `y` (document px; `strength` -1..1 default 0.8, `radius` 4..2048 px default 80): liquid ferrofluid gathers toward it and rises into hexagonal Rosensweig spikes shaded by `set_lighting`. One undo step. Returns the magnet (`id`, `x`, `y`, `strength`, `radius`). |
| `update_magnet` | Move or tune a magnet by `id` (`x`, `y`, `strength`, `radius`): liquid ferrofluid gathers and spikes update at once. One undo step. Returns the magnet. |
| `remove_magnets` | Remove magnets by `ids` (or all when omitted): uncured ferrofluid relaxes, cured relief stays. One undo step. Returns `removed`. |
| `list_magnets` | List the canvas magnets (`id`, `x`, `y`, `strength`, `radius`). Changes nothing. |
| `get_ferrofluid` | Read a layer's liquid ferrofluid and live spikes (`ferro`, `bounds`, `peak`, `coverage`, `activeSpikeArea`, `maxSpikeHeight`, `magnetCount`, `wavelength`, `threshold`). Changes nothing. |
| `cure_ferrofluid` | Bake a layer's current magnetic spikes into solid impasto height and dark glossy material, clearing its liquid ferrofluid so magnet edits no longer change it. One undo step. Returns `layerId`, `cured`, `bounds`, `maxSpikeHeight`, `activeSpikeArea`. |
| `set_age` | Preview the painting aged over `years` (0..500; 0 = fresh paint) with pigment `fading` by hue, yellowed `varnish` absorption, seeded Voronoi / stress `cracks` (craquelure relief that catches `set_lighting`) and surface `dust` grain (`seed`). Saved with the document, not an undo step. Returns `age`. |
| `get_age` | Read the current ageing preview settings (`years`, `varnish`, `cracks`, `fading`, `dust`, `seed`). Changes nothing. |
| `bake_age` | Commit the current aged look (fading, varnish, craquelure and dust) into a new pixel layer at the top of the stack and reset preview `years` to 0 so the painting is not aged twice. One undo step. Refused when `years` is 0 or wet paint is still moving. Returns `{ layerId, age }`. |
| `render_xray` | Render an X-ray radiograph of the painting that composites every pixel layer (hidden ones included) by `density = opacity × (thickHeight + lightnessWeight)` so lead-white and impasto strokes read bright and buried layers (pentimento) show through. Optional `strokes: k` replays the first `k` recorded strokes to X-ray an earlier stage. Changes nothing. Returns a PNG image and `{ width, height, strokes, totalStrokes, layerCount, hiddenLayerCount, maxDensity, meanDensity }`. |
| `set_xray_view` | Turn the viewport X-ray overlay `on` or off (`false`) to inspect buried and hidden layers live while painting or scraping with `paint-scraper`. View state only, not an undo step. Returns `{ on }`. |
| `get_cultures` | Read living biopaint (`culture`) colonies across layers (`tick`, living `tips`, `segments`, `bounds`, `status`: `growing` / `extinct` / `capped`), plus `growWhileClosed` and `pendingCatchUpTicks`. Changes nothing. |
| `grow_cultures` | Step living biopaint (`culture`) colonies forward by `steps` ticks (1..2000, default 40) on `layerId` (or all layers with living tips when omitted) as one undo step. Threads sense ahead, steer toward existing paint (`appetite`), fade what they eat (`digest`), carry its colour along the network, branch (`branching`) and fuse (`fuse`). Returns `segmentsAdded`, `tipsAlive`, `bounds`, `status` and per-layer results. Refuses stroke layers, effect layers, and wet layers holding wet paint (`dry_paint` first). |
| `remove_cultures` | Kill living biopaint tips on `layerId` (or the active layer) so growth stops (`status: "extinct"`), keeping the threads already drawn as ordinary paint. One undo step. Returns `layerId`, `removedTips`, `status`. |
| `set_culture_options` | Turn `growWhileClosed` (`true` / `false`) on or off so saving records a timestamp and reopening catches up elapsed growth as one undo step (`"Growth while closed"`). Returns `{ growWhileClosed }`. |

### Stickers

| Tool | Use |
| --- | --- |
| `list_stickers` | Read a layer's stickers bottom first: id, `ref` (and `stamp` for the editor's own), x, y, size, rotation, color, opacity, and `frame` for an animated sticker past its first frame. |
| `add_stickers` | Place stickers exactly (`ref` from `find_stickers`, `x`, `y`, optional `size`, `rotation`, `color`, `opacity`, `seed`, `frame` of an animated sticker) on a sticker layer or an empty layer; a provider's art loads first. Use it for deliberate placement, a sticker brush for a scatter. One undo step. Returns the new stickers with ids. |
| `sticker_at` | Read the top-most sticker under a point (`x`, `y`), or null. Use it to pick one sticker among many similar ones before `update_sticker`, `arrange_stickers` or `remove_stickers`. |
| `update_sticker` | Change one sticker by `id`: `ref`, `x`, `y`, `size`, `rotation`, `color`, `opacity`, `frame` (an animated sticker's frame, 0..frameCount-1 from `describe_sticker`; a new `ref` without `frame` starts at frame 0). One undo step. Returns it (frame 0 left out). |
| `find_stickers` | Search the sticker library (the editor's stamps unless the host plugged in its own) by words, category, tags and commercial licence, a page at a time. Returns refs (`provider:id`) for sticker brushes (`set_brush` `sticker.stamps`) and `add_stickers`, with tintable and licence. |
| `describe_sticker` | One sticker by `ref`: licence and attribution, colours, outline. Unknown refs are refused with the closest ones. |
| `arrange_stickers` | Move stickers (`ids`) to the `front` or `back` of their layer. One undo step. |
| `remove_stickers` | Delete stickers by `ids`, or all on the layer. One undo step. |

### Provider effects

| Tool | Use |
| --- | --- |
| `search_effects` | Find provider effects by `query`, `kind`, `category` and `use` (`generator` for paper and layers, `overlay` / `title` for layers and fills, `filter` for light on paint), or `place` (`paper`, `layer`, `fill`, `light`, `paint`) for exactly what that place takes: `paint` honours the provider's paint hints. Each effect's `paint` hint shows how it paints. `available: false` when no provider is registered. Call before the tools below. |
| `describe_effect` | Read an effect's controls (types, ranges, defaults), presets and inputs. Call before passing `values`. |
| `list_applied_effects` | Read the effect paint (target `paint`), the effect paper (target `paper`) and every effect layer with its effect and values; with `target`, one of them. Baked light and fills are pixels and are not listed. Works without a provider. |
| `apply_effect` | Light on dried paint: run a `filter` effect on a layer's paint and bake it in (`values`, `opacity` = strength 0..1). Refused on empty, wet, locked or hidden layers, with the fix. One undo step; undo takes it back. Returns the effect used and `baked: true`. |
| `update_effect` | Change the effect paint (`target` and `effect` "paint": `values`), the effect paper (`target` and `effect` "paper": `values`, `opacity`) or draw an effect layer again (`effect` "effect": `values`; `null` resets a control). Returns the effect. |
| `remove_effect` | End the effect paint (back to the paint colour), remove the effect paper, or turn an effect layer into a plain layer keeping its pixels (`keptPixels`). |
| `set_paper_effect` | Draw a generator over the paper (`values`, `opacity`, `blend` default `multiply`, `time`); `effect: null` removes it. One undo step. Returns the effect paper. |
| `add_effect_layer` | Add a layer drawn by a generator, overlay or title effect (`values`, `name`, `aboveId`, `opacity`, `blend`, `time`); it becomes active. Returns the layer and its effect. |
| `fill_layer_with_effect` | Composite a generator, overlay or title effect onto a layer (`layerId`, `values`, `opacity`, `lockTransparency`, `time`). One undo step. Returns the layer id and the effect. |
| `set_effect_paint` | Paint with a generator, overlay or title effect (`effect`, `values`, `time` ms default 0): rendered once at the canvas size, strokes take each pixel's colour from it; `map` `{ by: "stroke", length, repeat }` bends a strip along each stroke, or `{ by: "path" }` passes the stroke's centreline to an effect with a path control (`format: "svg-path"`, `accepts: ["path"]`); `live` keeps it playing on stroke layers. An effect with a `paint` hint starts from it (map, values, the two colours in its `colors` controls, live); what you pass wins. With a provider that declares `paintHints`, an effect without a hint is refused (use `add_effect_layer` or `fill_layer_with_effect`). Call after `search_effects` `place: "paint"` and `describe_effect`, then `paint_stroke`. Editor state, not an undo step. Returns `effectPaint`. |
| `set_effect_playback` | Play or pause live effect paint in the view (`playing`) and cap its frame rate (`fps` 1..60). Editor state. Returns `playing`, `fps`, `time` and `animation` (what plays, or null). Export a moment with `export_image` / `export_psd` `time`. |

### Guides

| Tool | Use |
| --- | --- |
| `get_guides` | Read the symmetry guide (with how many copies a stroke paints), the perspective guide, the tracing image and the reference images. |
| `set_symmetry` | `mode` off, vertical, horizontal, dual, diagonal or kaleidoscope (`segments` 2..32, `mirror`), `center` (document px, default the canvas centre), `rotation`. Every stroke after it paints its copies as one stroke; recorded strokes keep their copies when replayed. |
| `set_perspective_guide` | One to three vanishing `points` (document px, may be off the canvas), `enabled`, `snap`. Pen strokes snap to the guide line through their start that best matches their direction (one-point also keeps horizontals and verticals, two-point verticals); `paint_stroke` snaps only with `snapToPerspective`. |
| `set_tracing_image` | Put a PNG (`png` base64 or data URL) under the paint, fitted to the canvas or at `rect`, at `opacity` (default 0.35), with `sampleColors` to take stroke colours from it. View only: never exported. |
| `update_tracing_image` | Change the tracing image's `opacity`, `visible`, `sampleColors` or `rect`. |
| `clear_tracing_image` | Remove the tracing image. |
| `add_reference_image` | Add a floating reference PNG (`name`, panel `x`, `y`, `displayWidth`). Returns its id and size. |
| `list_reference_images` | Read the reference images: id, name, size, placement, visibility. |
| `update_reference_image` | Move, resize, rename, show or hide a reference panel. |
| `remove_reference_image` | Remove a reference image. |
| `add_stencil` | Lay a stencil: `kind` ruler (`from`, `to`) or arc (`center`, `radius`, `startAngle`, `endAngle`) to guide strokes, line (`from`, `to`) or shape (`shape` rect / ellipse with `rect`, polygon with `points`) to mask; `mode` guide or mask, `invert`, `snap`, `feather`. Returns it with its id. |
| `update_stencil` | Move, reshape, switch or hide (`enabled`) a stencil by `id`. |
| `remove_stencils` | Remove stencils by `ids`, or all. |
| `pick_reference_color` | Read a reference image's colour at its own pixel `x`, `y`; `setColor` makes it the paint colour. |

### View, input and output

| Tool | Use |
| --- | --- |
| `set_view` | Rotate (degrees), mirror or zoom the view, or `reset` it. View state only: pixels never resample. Mirroring is a quick check of a drawing's proportions. |
| `set_hand` | Say which hand holds the pen (`right` / `left`) for palm rejection. |
| `render_preview` | See the painting (or `layerIds`) as a PNG, longest side `maxSide` (16..2048, default 512), with or without the `paper`. Render after each block of work. |
| `export_image` | Export PNG (default), JPEG or WebP as base64, at `quality` and `scale` (≤ 1); `paper: false` gives a transparent PNG. JPEG / WebP need a browser canvas. |
| `export_psd` | Export a PSD with every layer, the paper as a locked bottom layer, and the composite. Pigment and painterly modes are written as their nearest standard mode (`list_blend_modes` `psd`). Returns base64, size, `psb` and `warnings`. |
| `export_time_lapse` | Repaint the painting from its recorded strokes and events as a time-lapse: `frames` (about how many), `fps`, `maxSide`, `wetStepsPerFrame` (frames while wet paint flows), `holdMs`. Returns a contact sheet image, the frame count, size, duration, a video project of the frames and the ffmpeg command that renders `timelapse.mp4`; `includeFrames` adds every frame as base64 PNG. Changes nothing. |
| `export_high_res` | Repaint the painting from its strokes at `scale` 1..8 (brushes, grain, fills and wet events scaled): a PNG with real detail instead of upscaled pixels. Returns base64, size. Layers not painted with strokes come out empty. |

### Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). A paint document is the saved painting (canvas, paper, layers, thick paint, guides, swatches, mixing pad and recorded strokes) with every image as an asset reference; wet paint is saved dry.

| Tool | Use |
| --- | --- |
| `get_paint_document` | Take a copy of the whole painting as `{ kind, formatVersion, revision, document }` before a risky change, or to hand it on. Images in it are asset references (`pixerate-asset:...`), never pixel data, so it stays small. To look at the pixels use `render_preview` or `export_image`. |
| `load_paint_document` | Put back a copy from `get_paint_document` in this session (its `document`, or the whole result). Checked first: a document whose assets are not loaded, or from a newer build, is refused and nothing changes. Opening clears the undo history (`undoable: false`), so get a copy first if the user may want the current painting back. Refused while a stroke or a wet-paint step is in progress. To change part of the painting use the layer and painting tools. |
| `save_paint_document` | Save the painting and its assets under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_paint_documents` | List saved paintings (`key`, `name`, `savedAt`), newest first. |
| `open_saved_paint_document` | Replace the painting with a saved one by `key`; its assets are read from storage first. Ask before opening over changes the user has not saved. |
| `find_unreferenced_paint_assets` | See how much stored image data (assets of any saved image or paint document) nothing refers to any more, without deleting it. Returns `unreferenced`, `unreferencedChars` and up to 100 `refs`. The open document's assets always count as used. Only listed when the host's storage can list keys. Call it before `delete_unreferenced_paint_assets`. |
| `delete_unreferenced_paint_assets` | Free storage by deleting that data, all of it or only the `refs` from `find_unreferenced_paint_assets`. Saved documents and autosave snapshots keep everything they use. Returns `removed`, `freedChars`, `kept`, `remaining`. Use it when the user asks to clean up or free space, not after every save: removing a saved document already collects its assets. A ref that is no longer unreferenced makes the call fail with nothing deleted; find again. |

## Pitfalls

- **Dual colours on a pixel layer follow the scheme only through a replay of the stroke log.** Merging, moving, transforming or importing pixels into that layer puts pixels outside the log, and the layer then keeps the side it was painted in (`get_color_scheme_view` reports it `kept` with the change; clearing the layer makes it replayable again). Paint theme-following marks on their own layer, or on a stroke layer. Exports in the other scheme are only exact once the replay is `ready` (`wait: true`).

- With agent playback on, strokes, fills and replays are painted live by the director, and other writes open their panel (Colour, Wet, Paper, Layers, Effects) and point at the control. Results are unchanged.
- **Stroke-by-stroke drawing is slow and expensive.** Do not draw a detailed picture point by point. Block in with fills and big strokes, then replay and vary a few good strokes.
- **A hidden or locked layer refuses paint**: show it (`update_layer visible true`) or unlock it. `transparency` lock is not an error: paint only lands where the layer already has paint.
- **Depth 0 means no grain** whatever the brush; grainy media then look smooth. Smooth bristol has depth 0.
- **Grain is fixed to the document**, not to the layer: moving content does not move the grain, and two strokes on the same spot catch the same peaks.
- **Blending tools need paint to blend.** Blender and smudge only move what is on the target layer: blend on the layer you painted, not on an empty one above it.
- **A dirty brush stays dirty** across strokes and colour changes until `clean_mixer_brush`. Pick-up lifts only paint on the target layer: the paper and other layers lift nothing.
- **Replays use the recorded load**: a replayed pick-up stroke starts with what the brush carried when it was painted, not with the current load.
- **Big soft brushes at full flow look flat.** Lower `flow` (airbrush 0.05..0.15) and build up.
- **JPEG and WebP need a browser**; in Node use PNG. Exports never upscale (`scale` ≤ 1).
- **Symmetry stays on until you turn it off.** Set `mode: "off"` after the symmetric part, or
  every later stroke is mirrored too.
- **The tracing image is not in exports or previews of the painting alone**; paint over it on a
  layer. Turn `sampleColors` off before painting your own colours, or strokes without `color`
  keep taking its colours.
- **Strokes take real time when the host shows your cursor.** With a director (the demo and
  editors that set `createPaintEditorToolProvider({ director })`), `paint_stroke` paints live at
  the pace of the points' `t` (else about 1.5 px per ms, at most ~1.8 s), `stroke_path` paints
  each subpath in turn (paced by its `speed` when given) as one undo step, and `fill_layer` /
  `replay_strokes` move the cursor first. Results and undo are the same; it is one more reason to
  paint a few long strokes and replay them rather than many short ones. A stroke fails with "A
  stroke is in progress" while the user is painting; try it again afterwards.
- **Wet paint keeps changing.** A preview right after a wet stroke shows it before it has
  flowed; `advance_wet_paint` first. Paint that should stay exactly where it was laid needs
  `dry_paint` (or a dry medium).
- **Wet strokes on one layer interact**; washes that must not mix go on separate layers, or dry the first before painting the second (glazing). Ghost paint (`ghost-wash`, `ghost-gouache`, `ghost-oil`, `invisible-ink`) only meets and smears paint on its own layer, so a ghost stroke on a new empty layer simply vanishes; ghost paint and light paint cannot share a layer while the ghost is fading. At most 8 layers hold wet paint at once, and the simulation holds at most 328 wet tiles (256 × 256 px each) across them; water that spreads past that limit is lost (`dry_paint` frees tiles). Multi-threaded wet media needs a cross-origin isolated page (COOP / COEP, for `SharedArrayBuffer`) and runs on one thread otherwise, more slowly but with the same result.
- **Undoing far back** past the wet undo memory (512 MB by default) leaves that paint dry as it
  looked, rather than wet.
- **Replays repeat what was recorded**: strokes, fills, clears, flattened relief and wet events.
  Imported pixels, merges and layer moves are not data, so `export_time_lapse` and
  `export_high_res` start those layers empty; paint with strokes when the replay matters.
- **Effects are pixels in replays.** Effect paper, effect layers, effect fills and baked light
  need the provider when they are made; replays and time-lapses do not repeat them. Add them
  after the painting, or keep the effect layer and redraw it. Effect paint is the exception:
  strokes record it, and replays render it again first, so they need the same provider (an
  error names the effect and provider when it is missing; `color` on `replay_strokes` repaints
  in one colour instead).
- **Effect paint is fixed to the canvas by default** (`map: { by: "stroke" }` follows the stroke),
  and in wet paint it flows with the water; for a crisp pattern in an exact shape, paint and dry
  the shape, then `fill_layer_with_effect` (`lockTransparency: true`). Erasers, blenders and
  smudges ignore it. Wait for `set_effect_paint` to return; strokes are refused while it renders.
- **Don't paint with an effect meant to be seen whole.** A scene, loader, title or audio
  visualiser shows only a still fragment inside a stroke. Search with `place: "paint"`; when the
  provider has paint hints, only effects that suit paint come back. Put the others on an effect
  layer (`add_effect_layer`) or in a fill (`fill_layer_with_effect`).
- **Recorded strokes are kept in saved documents** (`save_paint_document`, `get_paint_document`),
  so a painting can be replayed and repainted at a higher resolution.
