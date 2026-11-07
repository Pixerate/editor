---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
'@pixerate/swift': minor
---

Add reaction-diffusion live patterns (`livePatterns`) that grow inside wet paint and freeze when the paint dries (#644):

- Add the `livePatterns` brush facet (`pattern`: `'spots' | 'stripes' | 'coral' | 'maze' | 'worms'`, `feed`, `kill`, `scale`, `contrast`, `secondColor`, `relief`) and built-in brush presets `turing-wash` and `coral-ink`.
- Add a per-wet-layer half-resolution Gray-Scott field (`U, V`) in `packages/core/src/paint/live-patterns.ts` (outside the wet kernel) that steps during `advance_wet_paint` only where the wet world still holds water (`rho + sw > DRY_EPS`), shades wet and dried tiles (`secondColor` blend or pigment contrast), and optionally writes impasto height (`relief > 0`) into `doc.thick[layerId]`.
- Add agent tools `get_live_patterns`, `set_live_patterns`, and `seed_live_patterns`, wet undo snapshots, document serialization/replay support, React/Svelte/Swift `WetPanel` controls, agent skill references, conformance scenario `live-patterns`, and the full Swift port in `PixeratePaint` and `PixeratePaintUI`.
