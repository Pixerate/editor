# Painting time machine: ageing, X-ray view and the scraper brush

The paint editor includes a conservation & archaeology time machine with three parts:

1. **Non-destructive ageing preview (`set_age`, `get_age`, `bake_age`)**
2. **X-ray radiograph (`render_xray`, `set_xray_view`)**
3. **Scraper brush (`paint-scraper`, `marks.kind: "scraper"`)**

## 1. Ageing (`set_age`, `get_age`, `bake_age`)

`set_age` previews how the painting looks after `years` (`0..500`) of gallery ageing without touching the layer pixels:

- **Fading (`fading: 0..1`)**: deterministic pigment lightfastness table by hue (`HUE_LIGHTFASTNESS_FUGITIVE`). Fugitive reds (alizarin / carmine) and violets fade and desaturate fastest toward a warm chalk ground; earth ochres, umbers and blues hold their chroma.
- **Varnish (`varnish: 0..1`)**: yellowed dammar / linseed varnish absorption over the paint and paper that absorbs blue wavelengths and deepens warm tones.
- **Cracks (`cracks: 0..1`, `seed`)**: a seeded Voronoi + stress craquelure network whose cell frequency increases with the number of painted layers and local impasto `thick` height. Crack lines both darken with accumulated dirt and carve troughs into the height map before `lightTile` runs, so raking light (`set_lighting` with low `elevation` and high `relief`) catches the crack edges.
- **Dust (`dust: 0..1`)**: low-frequency gallery dust grain settled across the surface.

Like `set_lighting` and `set_uv_light`, `set_age` is document state (`SET` semantics, not an undo step) and is saved with the document. Undoing or redoing another step (a stroke, a fill) keeps the current age; only undoing `bake_age` brings back the `years` it reset. `RenderOptions.age` is on by default in the viewport and `render_preview`, and opt-in (`age: true`) for exports.

Call `bake_age` to commit the aged paint into a new pixel layer (`"Aged (<years> yr)"`) at the top of the stack as a single undo step and reset `years` to `0`.

## 2. X-ray view (`render_xray`, `set_xray_view`)

- `render_xray` (read-only) composites **every** pixel layer—including hidden (`visible: false`) layers and buried underpaintings—into a radiograph PNG.
- Each pixel's radiodensity is `opacity × (thickHeight + alpha × lightnessWeight)`, so thick impasto ridges and bright whites (like lead white) read bright while thin dark glazes read translucent.
- Pass `strokes: k` (`0..totalStrokes`) to replay the painting up to stroke `k` and X-ray how the composition looked at that point in its history. The replay shows and unlocks every layer, so `strokes: totalStrokes` matches `render_xray` without `strokes`; scraper strokes cut the layers they cut when painted (recorded with each stroke as `scrapeLayerIds`), not whatever is visible now.
- `set_xray_view { on: true }` turns the X-ray radiograph on in the live viewport so you can see hidden pentimenti while scraping down to them.

## 3. Scraper brush (`paint-scraper`)

- Choose `set_brush { id: "paint-scraper" }` (or set `marks: { kind: "scraper", depth: 0.65, sharpness: 0.7 }` on any mark brush) and paint with `paint_stroke` or `stroke_path`.
- Each dab starts at the **topmost visible unlocked pixel layer** and removes alpha and impasto `thick` height (`depth` `0..1` layers per pass; `sharpness` `0..1` controls blade edge hardness).
- Any depth remaining after a pixel's alpha reaches `0` carries into the visible pixel layer directly below, excavating down through the paint stack layer by layer to reveal older buried layers.
- The scraper stops at locked layers (`locks.all` or `locks.pixels`) and never scrapes the paper.
- One stroke across multiple layers is recorded as **one undo step**, and the stroke records the layers it cut (`scrapeLayerIds`, top to bottom) so replays and historical X-rays cut the same ones.
- `bake_age` is refused while a stroke is in progress or wet paint is mid-step; end the stroke (or `await wetIdle()`) first.
- Scraping is refused on stroke layers (`rasterize_stroke_layer` first) and while any visible pixel layer holds wet paint (`dry_paint` first).
