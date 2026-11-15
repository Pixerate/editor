---
"@pixerate/editor": minor
"@pixerate/swift": minor
"@pixerate/conformance": patch
---

Particles and relief in the chart's 3-D view, so agents can set them (#806, #807).

- `ChartView3d` takes `particles` (`{ unit, order }`) and `relief` (`{ amount, scale, octaves, seed }`). `update_chart` `view3d` sets them; later updates merge into them, and `null` turns either off. Values out of range are refused with what fits (`view3d.relief.amount must be a fraction from 0 to 0.25.`); unknown fields are named.
- `createChart3dScene` / `renderChart3d` draw a chart's own `view3d.particles` and `view3d.relief`, unless the host passes `particles` or `relief` itself.
- Office files keep the 3-D view and say particles and relief were left out.
- The chart skill's `update_chart` row and the "decoration is not data" note cover them; the `view3d` conformance scenario sets, merges, refuses and clears them.
- Swift: `ChartView3d` keeps `particles` and `relief`, normalised and merged the same way, so documents round-trip.
