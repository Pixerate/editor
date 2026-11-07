# Live patterns in wet paint

Live patterns are Gray-Scott reaction-diffusion patterns (`spots`, `stripes`, `coral`, `maze`, `worms`) that grow inside wet paint while water is present and **freeze when the paint dries**.

## How it works

1. **Seeding**:
   - Paint with a wet brush carrying the `livePatterns` facet (built-in presets `turing-wash` and `coral-ink`, or `set_brush` / `paint_stroke` `brush: { livePatterns: { pattern: "spots", ... } }`), or
   - Call `seed_live_patterns` on a wet layer (`points`, `radius`, `seed`, and optional pattern settings).
2. **Growth**:
   - Every `advance_wet_paint` step runs reaction-diffusion substeps on the layer's pattern field `(U, V)` at half tile resolution (`128 × 128` per `256 × 256` tile).
   - Reaction-diffusion only runs where the wet world still holds water (`rho + sw > DRY_EPS`). Where the paint is dry, the rate is zero, so the pattern freezes in place.
3. **Shading, relief and drying**:
   - On screen and when baking (`dry_paint` or natural evaporation), reagent `V` blends the paint colour toward `secondColor` (or modulates pigment contrast when `secondColor` is `null`).
   - When `relief > 0`, reagent `V` also writes thick height (`get_relief`), so pattern ridges catch the editor's light (`set_lighting`).
   - Calling `dry_paint` bakes the pattern into the layer's pixels and freezes it permanently.

## Pattern presets and tuning

| Pattern | Pearson `(feed, kill)` | Look |
| --- | --- | --- |
| `spots` | `(0.035, 0.065)` | Mitosis spots and cell clusters (`turing-wash`) |
| `stripes` | `(0.030, 0.062)` | Parallel and branching Turing stripes |
| `coral` | `(0.0545, 0.062)` | Branching coral dendrites (`coral-ink`) |
| `maze` | `(0.029, 0.057)` | Dense labyrinthine ridges |
| `worms` | `(0.058, 0.065)` | Vermiculate worm tracks |

Settings on `livePatterns`, `set_live_patterns` and `seed_live_patterns`:
- `pattern`: `'spots' | 'stripes' | 'coral' | 'maze' | 'worms'`
- `feed` (`0.005..0.1`), `kill` (`0.01..0.1`): explicit Gray-Scott feed and kill rates (setting `pattern` without `feed` / `kill` resets them to that preset's Pearson constants)
- `scale` (`0.25..4`, default `1`): diffusion scale for wider or finer features
- `contrast` (`0..2`, default `1`): strength of the pattern in the wet pigment
- `secondColor` (`#rrggbb` or `null`): second colour mixed where `V` concentrates; `null` darkens and lightens the wet pigment itself
- `relief` (`0..1`, default `0`): embosses `V` into the layer's height map so ridges catch the light

## Workflow: let it grow, then dry

1. Paint a wet wash with `turing-wash` or `coral-ink` (or lay a wash with `watercolor-wash` and call `seed_live_patterns`).
2. Call `advance_wet_paint` (`steps` 30..120 or `seconds` 0.5..2) to let the pattern spread and branch inside the wet area.
3. Check progress with `get_live_patterns` (`patternCells`, `wetPatternCells`, `maxV`, `meanV`) or `render_preview`.
4. Call `dry_paint` once the pattern reaches the look you want so it freezes and bakes into the layer.
