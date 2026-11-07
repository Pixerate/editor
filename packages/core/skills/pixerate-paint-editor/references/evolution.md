# Evolutionary strokes: breeding and mutating variants

Every dry stroke painted in the editor is recorded as a `RecordedStroke` genome: its raw points (with pressure, timing and tilt), its brush facets (`tip`, `dynamics`, `behaviour`, `marks`, `motion`, `colour`), its paint colour and its deterministic `seed`.

Rather than guessing facet knobs by hand, you can **breed** a batch of variants from one or more painted strokes, compare their ghost previews and diff summaries, cross two favourites over, or accept one onto a new layer in a single undo step.

## Workflow

1. **Pick parent strokes.** Call `list_strokes` (or use the `strokeId` returned by `paint_stroke` / `stroke_path`). Only dry strokes that `liveStrokeRefusal` permits can be bred — wet, impasto, sticker, eraser, blender, smudge, light and pick-up brushes are refused with the reason.
2. **Breed a generation.** Call `breed_strokes` with `strokeIds` (`1..16`), `count` (`2..12`, default `4`), optional `mutation` rates (`geometry`, `color`, `brush`, `seed`, each `0..1`) and an optional deterministic `seed`.
   - Each variant is added as a pending paint proposal (`kind: "strokes"`) rendered through `previewPaint` one after another.
   - The result lists `proposalIds` and `proposals`, each with `proposalId`, `title`, `seed`, `bounds`, a human-readable `diff` summary (`"geometry ±4.2px, scale 0.96×; colour ΔL -0.03, Δh +8°; brush tip.size=18.4, tip.hardness=0.62; seed → 1849201"`) and `changes` tags.
3. **Evolve further or cross over.** Call `breed_proposal` with `proposalIds`:
   - **1 proposal id**: mutates that proposal's genome into `count` offspring.
   - **2 proposal ids**: crosses the two parent genomes over — resampling corresponding stroke point paths and mixing their OKLCH colours and numeric brush facets — then mutates each child.
4. **Inspect or accept.**
   - Call `get_proposal_genome` with `proposalId` to read the full stroke records (`brush`, `color`, `points`, `seed`) if you want to save the mutated brush with `create_brush`.
   - Call `accept_paint_proposal` to paint the chosen variant onto a new layer as a single undo step, or `reject_paint_proposal` to dismiss variants you don't want.

## Mutation channels (`mutation`)

| Channel | Default | What it mutates |
| --- | --- | --- |
| `geometry` | `0.35` | Seeded `varyStroke` transform (small offset, rotation, scale and pressure scaling) plus smoothed 3-tap point jitter and pressure drift. Set to `0` to keep the exact path. |
| `color` | `0.25` | Perceptual drift in OKLCH (`L` ±0.18, `C` ±0.08, `h` ±45° at rate `1.0`), clamped to gamut. Set to `0` to keep the exact colour. |
| `brush` | `0.3` | Drifts numeric brush facets present on the stroke within their schema bounds (`tip.size`, `tip.hardness`, `tip.spacing`, `tip.roundness`, `tip.angle`, `tip.opacity`, `tip.flow`, `dynamics.sizeJitter`, `dynamics.opacityJitter`, `dynamics.scatter`, `dynamics.angleJitter`, `behaviour.grain`, plus active `marks` particle/bristle/chalk fields). Set to `0` to keep the brush unchanged. |
| `seed` | `0.5` | Probability of rerolling each stroke's deterministic RNG `seed` so grain, scatter and bristle/particle marks vary even when `geometry`, `color` and `brush` are `0`. |
