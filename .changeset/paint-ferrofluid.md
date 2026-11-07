---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
'@pixerate/swift': minor
---

Add ferrofluid paint and magnets (`ferro` brush facet with `amount`, `wavelength` and `threshold`, built-in presets `ferrofluid` and `ferro-ink`, per-layer liquid ferrofluid channel `doc.ferro[layerId]`, document magnets `doc.magnets`, analytical dipole magnetic field and tilted hexagonal Rosensweig relief spikes shaded by `LitCache` / `lightTile`, deterministic advection of liquid ferrofluid toward added or moved magnets, `cure_ferrofluid` to bake active spikes into permanent impasto relief, agent tools `add_magnet`, `update_magnet`, `remove_magnets`, `list_magnets`, `get_ferrofluid` and `cure_ferrofluid`, React/Svelte/Swift `<FerroPanel>` / `PaintFerroPanel` and canvas magnet overlays).
