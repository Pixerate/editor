---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Charts: a 3-D view (part of #795).

- `ChartSpec.view3d?: { azimuth, elevation, depth }` (Office's `view3D`: turn 0–360°, eye height 0–90°, depth as a multiple of the bar width 0.2–20; defaults 20, 15 and 1 in `CHART_VIEW3D_DEFAULTS`). Absent means a flat chart, so existing documents are unchanged. `update_chart` (and `ChartController.update`) sets it, merges a partial view into the current one, and clears it with `null`; out-of-range values are refused with what is allowed.
- Office 3-D bar, line and area charts now import with their view (`rotY`, `rotX`, `depthPercent`) instead of being noted as drawn flat; a view from below the floor is drawn from floor level and noted. 3-D pie and surface charts are still drawn flat. Writing a chart with a 3-D view to Office XML saves it flat and says so.
- Swift: the same field, normalisation, update and Office import, with a new `view3d` conformance scenario and 3-D Office vectors.
