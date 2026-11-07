# Ferrofluid paint

Ferrofluid paint is liquid magnetic paint (`ferro.amount` above 0 on any dab, particle, bristle,
Mixer Brush or impasto brush; presets `ferrofluid` and `ferro-ink`). Place dipole magnets on the
canvas (`add_magnet`), and the liquid paint gathers toward the magnets and rises into hexagonal
Rosensweig relief spikes along the magnetic field lines, shaded live by `set_lighting`. The paint
stays liquid and responds to magnet moves until `cure_ferrofluid` bakes the spikes into solid
impasto relief.

- **How it works.** Each layer keeps a liquid ferrofluid channel (`doc.ferro[layerId]`) alongside
  its colour and impasto relief, and the document keeps dipole magnets (`doc.magnets`: `x`, `y`,
  `strength` `-1..1`, `radius` `4..2048` px). At render time, wherever a pixel has liquid
  ferrofluid (`ferro > 0`) and the analytical dipole field $|\mathbf{B}|$ exceeds the layer's
  critical `threshold`, the surface rises into a hexagonal Rosensweig lattice of spikes spaced by
  the capillary `wavelength` (4..64 px, default 14 px) with amplitude $\propto \sqrt{1 - B_c / |\mathbf{B}|} \times \text{ferro}$
  and tilted along the horizontal component of $\mathbf{B}$.
- **Shading and material.** The spikes feed directly into the impasto lighting pass (`lightTile` /
  `set_lighting`). Where a layer has no explicit impasto material of its own, liquid ferrofluid
  gives it a dark glossy metallic carrier finish (`gloss` 0.88, `metallic` 0.65, `rim` 0.25) and
  deepens the colour toward `#111827`, so grazing light (`set_lighting` `elevation` 20..35) catches
  crisp specular highlights on every spike tip.
- **Gathering toward magnets.** Adding (`add_magnet`) or moving/tuning (`update_magnet`) a magnet
  runs deterministic advection steps on every layer's liquid ferrofluid along $\nabla |\mathbf{B}|$,
  so painted pools visibly pull toward nearby poles.
- **Moving vs curing.** While uncured, moving or removing magnets (`update_magnet`,
  `remove_magnets`) immediately reshapes or relaxes the spikes. Call `cure_ferrofluid` when a
  layer's spike crown is right: it bakes the current spike height and dark glossy material into
  the layer's permanent impasto relief (`doc.thick[layerId]`) and clears `doc.ferro[layerId]` in
  one undo step, so later magnet changes leave that layer untouched.
- **Brush facet.** Pass `ferro: 0.85` or `ferro: { amount: 0.85, wavelength: 14, threshold: 0.18 }`
  to `set_brush` or per-stroke `paint_stroke` `brush`; `unset: ["ferro"]` turns it off.
  - `ferrofluid`: thick, glossy dark ferrofluid pool (`wavelength` 14 px, `threshold` 0.18).
  - `ferro-ink`: crisp calligraphic ferrofluid ink with finer spikes (`wavelength` 10 px,
    `threshold` 0.15).
- **Refusals.** Wet brushes, sticker sprays and stroke layers refuse `ferro.amount > 0`, naming
  the fix (`ferrofluid` / `ferro-ink` on a pixel layer).
