---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

Specialty brushes are separated from standard media, with guided setup (#729).

- `@pixerate/editor/brushes`: `BRUSH_SPECIALTIES`, `brushSpecialties` and `isSpecialtyBrush` name the specialty paint a brush lays (ferrofluid, UV-fluorescent and thermochromic ink, thin-film iridescence, ghost, mutation and live patterns). `brushLibraryGroups` files those brushes in a `specialty` group by kind (their `medium` is unchanged). `brushEditorSections` keeps the Light section to glowing light paint (its secondary controls only once the brush lays light), takes live patterns out of Behaviour, and adds an opt-in `specialty` section: a toggle per kind the host paints (`fluorescence.enabled`, `thermochromic.enabled`, `iridescence`, `ferro.enabled`, `ghost.enabled`, `mutation.enabled`, the `livePatterns.pattern` choice with `none`), its settings once it is on, and a `hint` saying how to use it. `setBrushEditorValue` handles those paths.
- `@pixerate/editor/paint-editor`: `brushSpecialtyGuides(state)` gives, per specialty of the active brush, how to use it, whether the canvas is ready (UV blacklight, heat against the ink's threshold, magnets, view tilt, a mutation agent, wet time) and quick actions, each naming the agent tool and arguments that do it; `runBrushSpecialtyAction`, `paintBrushSpecialties`, `specialtyInPlay` and `warmCanvasHeat` go with it. New agent tool `get_specialty_guides`. Agent playback opens the new Specialty panel for the UV, heat, magnet and view tilt tools. The paint `ui.json` contract lists `specialties`.
- React and Svelte: `SpecialtyGuideCard` at the top of `BrushPanel` (with `onOpenSpecialtyPanel` / `onopenspecialtypanel`), a new `SpecialtyPanel` and a Specialty tab in `PaintEditor` (marked while specialty paint is in play) holding the UV blacklight and heat, magnets (`FerroPanel`) and the view tilt, which leave `PaperPanel`. `BrushEditor` shows control hints; `BrushLibraryBrowser` lists specialty brushes by kind.
- Swift: `get_specialty_guides`, `brushSpecialtyGuides`, `runBrushSpecialtyAction`, `PaintSpecialtyGuideCard` in `PaintBrushPanel`, `PaintSpecialtyPanel` as a Specialty tab, `PaintViewTiltPanel`, and a Specialty group in the brush picker.
