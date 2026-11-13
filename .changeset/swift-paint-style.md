---
"@pixerate/editor": patch
"@pixerate/swift": minor
---

The Swift paint editor reads the house style: `check_paint_style`, `fix_paint_style` and `check_brush_style` (part of #791).

- The paint contracts list the `paint-style` and `brush-style` providers, and the paint conformance host takes `setup.style` (`paint-editor.json`), `setup.brushStyle` (`brushes.json`), `setup.brand` (`brand.json`) and `setup.readOnly` (`PaintStyleSetup`), with eight new scenarios (`style-paint-checks`, `style-paint-fix`, `style-paint-brand`, `style-paint-skips`, `style-paint-invalid`, `style-paint-readonly`, `style-paint-none`, `style-brush-checks`).
- `PixeratePaint` ports `paint-editor/style.ts` and `brushes/style.ts`: the `paper`, `brushes` and `max-layers` checks and the paint surface (the current colour, swatches, one colour per stroke), the `brushes`, `media` and `source-licences` checks and the surface of brush colours, profiles derived from the brand's palette, and `PaintHouseStyles`, which reports every file a skill leaves out in both domains, as `createStyleResolver` does.
- `loadStyleProfile` in `PixerateCore` drops a string `$schema` before validating, as the TS loader does.
