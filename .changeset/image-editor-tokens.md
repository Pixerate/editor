---
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

The image editor follows the host's theme. `ImageEditor` and every image-editor panel (adjustment layers, layers, layer effects, colour profile, brush, selection, Refine Edge, Free Transform, shape and type bars, provider effects, curves, sliders) now use shadcn theme tokens (`bg-background`, `bg-muted`, `border-border`, `text-muted-foreground`, `bg-primary`, `text-destructive`, …) instead of the fixed slate / indigo palette, through class constants shared in `image-editor/styles.ts`. Hosts need the theme colours the README lists (with `accent`, `primary-foreground` and `accent-foreground`). `AdjustmentLayersPanel`, `ControlSlider`, `CurvesEditor` and `ImageEffectControls` take `className` (Svelte `class`); the editor's tabs are a `tablist` whose open tab has `aria-selected="true"`. The curve's line and points use `var(--foreground)` / `var(--background)`.
