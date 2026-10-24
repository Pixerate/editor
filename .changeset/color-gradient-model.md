---
"@pixerate/editor": minor
---

Add gradient model, controller, and agent tools (`@pixerate/editor/gradient`). Includes support for linear, radial, and conic geometries, OKLab interpolation, dual `light-dark()` color stops, WCAG contrast checks, and 11 agent tools. `GradientController` validates geometry (`setGeometry` applies several fields as one undo step), `load()` syncs a host value without an undo step, and selecting a stop does not call `onChange`.
