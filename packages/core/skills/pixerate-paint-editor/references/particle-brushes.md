# Particle brushes

Particle brushes (`engine: 'particle'`) make marks with a small simulation driven by the pen. They
are seeded and stepped by distance, so the same points and `seed` paint the same pixels and
replays are exact. Their marks are ordinary coverage: opacity, blend modes, locks, stencils,
symmetry, gradient paint, effect paint and light paint all work as for a dab brush. Change them
with `set_brush` `particle` (missing fields keep their values); `get_brush` returns them all.

## Kinds (`particle.kind`)

| Kind | Motion | Good for |
| --- | --- | --- |
| `string` | Strands of masses dragged behind the pen | Hair, fur, grass, silk |
| `spring` | Each particle on a spring to the pen, overshooting | Lively ink, twisting bands |
| `orbit` | Particles circling the pen | Curls, spirographs |
| `flow` | Thrown off the pen into a swirling flow until they fade (`life`) | Fur, sparks, flames, smoke |
| `elastic` | Strands whose links have a rest length: they stretch when the pen is fast and snap back | Neon tubes, rubber bands |
| `fuzzy` | Strings that always wind, each strand waving out of step | Fuzz, tangled light, yarn |

`stiffness`, `damping` and `gravity` shape the motion (negative gravity rises: flames, smoke).
`elastic` and `fuzzy` damp their strands enough to stay together at any setting; a `string` with
low damping and high stiffness can still swing wildly, which is part of its look.

## Renders (`particle.render`)

- `dot`: a mark at every step; `line`: each particle's path as a line; `sequence`: beads spaced
  by `interval` along each path.
- `ribbon`: the band between neighbouring particles' paths is filled, at `ribbonFill` (0..1,
  default 0.5) of the stroke opacity, and the paths are drawn as its edges at `size` (keep
  `size` small, about 0.01, for fine edges; `ribbonFill` 0 leaves only the edges).
  `ribbonPairs` `adjacent` (default) joins each particle to its neighbour around the pen;
  `first-last` makes one band between the outermost two. `spread` sets how wide it is. The fill
  has no seams and does not build up where bands meet; it builds up only with other strokes.
  `spring` ribbons twist like silk, `string` ribbons trail, `flow` ribbons flicker like flames.

## Waves

Any kind and render can wave: each particle's drawn place moves sideways to the stroke on a sine.
`waveAmplitude` is a fraction of the tip size (0 default: off), `waveLength` px of pen travel
(4..2000, default 60), `waveSpeed` how fast the waves run by stroke time (0: they stand still on
the path; 1: about four a second, so slow strokes wave more), `wavePhaseJitter` how far out of
step the particles are (0: a wavy band; 1: tangled strands). Waves run by the points' `time`;
points without times run at a nominal 0.5 px/ms, so give times when the speed matters.

## Textured dots

`dotTextures`: up to four sticker stamps (`list_stickers` stamp ids: dot, star, heart, leaf,
flower, confetti, splat, sparkle, ring) drawn instead of round marks by the `dot` and `sequence`
renders; a stamp listed twice is picked twice as often. `dotTextureOrder` `sequence` (default)
uses them in turn, `random` picks one per dot (seeded). `dotRotation` `random` (default),
`follow` (turned with each particle's motion) or `fixed` (the tip angle). Empty: round dots.

## Light presets (category `light`)

`light-ribbon` (silk of light on slow waves), `flame-ribbon` (rising flow ribbons), `neon-strand`
(an elastic tube with a slow shimmer), `smoke-ribbon` (thin lit smoke), `bokeh-dots` (soft discs
and rings), `twinkle-sparks` (sparkles and stars thrown into the flow), `spark-trail`. Each lays
light paint; see [light-paint.md](light-paint.md) for spill and the light-painting method.

## Best practice

- Check a setting with `render_brush_thumbnail` before painting with it.
- Change one thing at a time: kind for the motion, render for the look, then waves and textures.
- Many `flow` particles with long `life` in a `ribbon` are slow (every pair of live particles is
  a band each step): keep `count` × `life` low (count 3..6, life ≤ 0.4).
- Stroke layers redraw particle strokes exactly, so ribbons and waves stay editable there.
