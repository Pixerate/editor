---
"@pixerate/editor": minor
"@pixerate/swift": minor
"@pixerate/conformance": patch
---

House style for 3-D charts (closes #810). The chart profile (`chart.json`) takes a `three` section, so a brand restyles 3-D pictures the way it restyles flat ones:

- `materials`: `mark` (bars) and `ribbon` (lines and areas; `transmission` for glass) with roughness, metalness, opacity and transmission; `floor` and `wall` with a `color` too; a `highlight` glow on focused marks.
- `light`: a `preset` (`studio`, the default; `soft`; `rim`; `flat`) with `intensity` and an optional key `azimuth` / `elevation`.
- `shadow` (`enabled`, `softness`), `ambientOcclusion` (contact darkening under bars) and `background`.
- `version: 1`. A profile without the section, or with an empty one, draws exactly as before; a section from a newer version is refused with a message. Colours take `$token` references like the rest of the profile.
- `resolveChart3dStyle`, `DEFAULT_CHART_3D_STYLE`, `CHART_3D_LIGHT_PRESETS`, `CHART_3D_STYLE_SCHEMA` (`/chart`); `Chart3dOptions.style` for `createChart3dScene` and `renderChart3d`, which expose the resolved `style` and `background`.
- Checks: `three-contrast` (label text against the 3-D background and floor, palette against the floor and wall; only charts with a 3-D view), and `checkChart3dLabelContrast(labels, sample)` (`/three`) for the rendered picture.
- The style-authoring skill has a 3-D recipe. Demo: two house styles (Matte paper, Glass night) on the Charts tab's 3-D view.
- Swift: the chart profile reads the `three` section and runs `three-contrast` the same way; the chart style scenarios are re-recorded with the new check in their messages.
