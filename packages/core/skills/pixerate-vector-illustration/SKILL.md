---
name: pixerate-vector-illustration
description: The illustration workflow in the Pixerate vector editor - blocking in shapes back to front, grouping and naming parts, colour from a small palette, gradients (linear, radial, mesh and freeform) with even interpolation, stacked fills and strokes instead of duplicate shapes, clipping and opacity masks, blends, subtle shadows and glows with one light direction, and preparing artboards for export. Use when asked to draw, illustrate or paint a scene, character, object, spot illustration, poster or background in vector, add shading, gradients, highlights, shadows or texture, show art inside a shape, or when vector.setGradient, vector.addFill, vector.makeClippingMask, vector.addFilter or vector.blend are available. Load with pixerate-vector, which lists every command.
metadata:
  kind: workflow
  reference: pixerate-vector
---

# Making an illustration

An illustration is built like a painting: big shapes first, back to front, then form (light and
shade), then detail, then finish. In vector, every stage should stay editable: shading lives in
gradients and stacked fills rather than extra shapes, art shown inside a shape lives in masks,
and effects stay live until the file is delivered.

This skill is the method. `pixerate-vector` has the full command reference; run the commands
with `run_command`, or several as one undo step with `run_commands` and `atomic: true`.

## Goal and quality bar

- A clear structure: parts grouped and named ("Sky", "Hill far", "Tree 1"), stacked back to
  front, the tree shallow.
- A small palette (5-8 colours plus tints), used consistently; gradients two to four stops.
- One light direction for every highlight, shade and shadow.
- Non-destructive: gradients, appearance stacks, masks, blends and filters are live; shapes are
  not duplicated to fake shading.
- Shadows and glows subtle: drop shadows black at 0.15-0.3 opacity, offset 2-8 units straight
  away from the light, blur about twice the offset.

## Inputs to confirm

- **Subject and format:** what to draw, the artboard size or ratio.
- **Style:** flat (solid fills), soft (gradients), or textured; outlined or not.
- **Palette:** brand colours or free; the light direction if it matters.

## Working method

1. **Read and plan.** `vector.list` for the artboard and what exists. Plan the layers from back to
   front (sky, far, middle, near, foreground details) and the palette.
2. **Block in.** Big shapes with `vector.addShape` and `vector.addPath`, flat colours, one
   `run_commands` per group with `atomic: true`; `vector.group` each object with a `name`.
   **Check:** `vector.list` order is back to front; names say what each group is.
3. **Form.** Shade with gradients rather than extra shapes: `vector.setStyle` `fill` with a
   `linear` or `radial` gradient (`interpolation: "oklab"` for clean blends between saturated
   colours), `vector.setGradient` to place it, `vector.setMeshGradient` or
   `vector.setFreeformGradient` for organic shading. For a highlight or a texture over a fill,
   `vector.addFill` on the same path with its own `opacity` and `blendMode` (screen to lighten,
   multiply to darken).
   **Check:** `vector.getAppearance` shows the stack; the shape count did not grow.
4. **Masks for art inside shapes.** Put the shape that frames the art on top and
   `vector.makeClippingMask` with the art below it (a pattern in a window, a scene in a circle);
   `vector.makeOpacityMask` with a white-to-black gradient for fades and reflections.
   **Check:** `vector.list` shows the mask group's `mask` with the right `contents`.
5. **Transitions and repeats.** `vector.blend` between two shapes for smooth steps (a sunset of
   bands, a row of fading circles); symbols for repeated objects (trees, stars).
6. **Shadows and glows.** `vector.addFilter` `dropShadow` (`offsetX` 0 and `offsetY` positive for
   light from above), `outerGlow` for light sources, `layerBlur` for depth of field.
   **Check:** `vector.list` `filters` show one light direction across the design.
7. **Finish and export.** Review the stack, then `vector.exportSvg` (or `vector.exportFrameSvg`
   per artboard). Expand live effects (`vector.expandAppearance`, `vector.expandBlend`) only for
   targets that need plain SVG.

## Decision table

| Want | Approach |
| --- | --- |
| Roundness on a ball, sun or face | Radial gradient, light stop toward the light |
| Sky or ground fading | Linear gradient, two or three stops |
| Organic shading (fabric, a face) | Mesh or freeform gradient |
| A highlight or texture over a colour | `vector.addFill` stacked on the same path, screen or overlay |
| An outline around an outline | `vector.addStroke` stacked, each with its own `strokeAlign` |
| Art visible only inside a shape | `vector.makeClippingMask` (the frame on top) |
| A fade-out or reflection | `vector.makeOpacityMask` with a white-to-black gradient |
| Even steps between two shapes | `vector.blend` |
| Card or object lifted off the page | `vector.addFilter` `dropShadow`, subtle |

## Recipes

**Radial shading.** `vector.setStyle` with `fill: { type: "radial", interpolation: "oklab",
stops: [{ offset: 0, color: light }, { offset: 1, color: dark }] }`; move the centre toward the
light with `vector.setGradient`.

**Pattern in a window.** Draw the pattern, draw the window shape on top, then
`vector.makeClippingMask` with all their ids: the window clips, its own fill is not drawn, and
the pattern stays movable inside.

**Subtle shadow.** `vector.addFilter` `{ type: "dropShadow", params: { color: "#000000",
opacity: 0.2, offsetX: 0, offsetY: 4, blur: 8 } }` on the object.

## Pitfalls

- **Duplicates for shading.** A copied shape for a highlight drifts when the original is edited;
  stack a fill instead.
- **Muddy gradients.** sRGB interpolation between saturated hues passes through grey; use
  `oklab`, or add a midpoint stop.
- **Mixed light directions** make a scene look collaged; keep every shadow offset the same way.
- **Heavy shadows.** Dark, hard, far shadows look pasted on.
- **The mask on the wrong layer.** `vector.makeClippingMask` uses the topmost object as the mask
  unless `maskId` says otherwise; put the frame on top first.
- **Filters in exports.** SVG filters render differently in some tools; expand or rasterize where
  the result must look identical everywhere.

## Tools used

- `vector.list`, `vector.getAppearance`: structure, order, fills, masks and filters
- `vector.addShape`, `vector.addPath`, `vector.group`, `vector.moveLayer`: block in, group and order
- `vector.setStyle`, `vector.setGradient`, `vector.setMeshGradient`, `vector.setFreeformGradient`: colour and gradients
- `vector.addFill`, `vector.addStroke`, `vector.setBlendMode`: appearance stacks
- `vector.makeClippingMask`, `vector.makeOpacityMask`, `vector.setMaskOptions`: masks
- `vector.blend`, `vector.makeSymbol`, `vector.placeSymbol`: transitions and repeats
- `vector.addFilter`, `vector.updateFilter`: shadows, glows and blur
- `vector.expandAppearance`, `vector.expandBlend`, `vector.exportSvg`, `vector.exportFrameSvg`: finish and export
