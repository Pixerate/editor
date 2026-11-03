---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Particle brushes: ribbons, waves, elastic and fuzzy strands, textured dots, and Light brushes built on light paint.

- `particle.render: 'ribbon'` fills the band between neighbouring particles' paths (`ribbonFill`, `ribbonPairs` `adjacent` | `first-last`), seamlessly, with the paths as its edges.
- Waves on any kind and render: `waveAmplitude` (fraction of the tip), `waveLength` (px), `waveSpeed` (by stroke time) and `wavePhaseJitter`.
- New kinds `elastic` (strands that stretch and snap back) and `fuzzy` (strands that wind, out of step).
- Textured dots: `dotTextures` (up to four sticker stamps), `dotTextureOrder` `sequence` | `random`, `dotRotation` `follow` | `random` | `fixed`.
- New Light presets that lay light paint: Light ribbon, Flame ribbon, Neon strand, Smoke ribbon, Bokeh dots, Twinkle sparks.
- `set_brush` / `get_brush` take and return the new settings; React and Svelte `BrushPanel` show ribbon, wave and dot-texture controls (`toggleDotTexture`, `RIBBON_PAIR_LABELS`, `DOT_TEXTURE_ORDER_LABELS`, `DOT_ROTATION_LABELS`).

Existing particle brushes paint the same pixels as before.
