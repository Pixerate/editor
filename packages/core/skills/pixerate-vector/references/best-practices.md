# Drawing best practices

Detail for `SKILL.md`'s best practices, by topic.

- **Clean paths.** Use the fewest anchors that describe the shape: anchors at extrema (top,
  bottom, left, right of a curve) and at true corners, handles horizontal or vertical at extrema,
  each handle about a third of its segment. Run `vector.removeRedundantPoints` after
  booleans, knife and pencil work; `vector.smooth` for lumpy curves; `vector.deleteAnchors`
  keeps the outline by refitting neighbours.
- **Live corners over drawn arcs.** Give rectangles, polygons and stars a `cornerRadius`
  (`vector.addShape`) or set it with `vector.setCorners`; the anchors stay sharp and editable and
  radii shrink to fit short sides. Keep one radius scale across a design. For app icons and UI
  cards use `smoothing` (about 0.6) on `vector.setCorners` for continuous, squircle corners.
- **Boolean vs Pathfinder vs Shape Builder.** `vector.boolean` for a single result shape (union
  for silhouettes, subtract for cut-outs, intersect, exclude). `vector.pathfinder` when you need
  every region separately (divide), hidden parts removed (trim, merge) or a crop. Shape Builder
  when you want to merge or delete particular regions picked by point.
- **Strokes.** Use `strokeAlign: "inside"` for icons and UI shapes so the outer size stays exact,
  `outside` for outlines around artwork; open paths always stroke centred. Use round caps and
  joins for friendly line icons, miter for geometric ones. Keep one stroke width across an icon
  set (for example 1.5 or 2 units on a 24-unit grid).
- **Icon grid.** Use a square artboard (24, 32 or 48 units), keep a padding margin, place
  coordinates on whole or half units so strokes render crisp, and align optical centres.
- **Gradients.** Two to four stops are usually enough. Use `interpolation: "oklab"` for
  perceptually even blends without the grey or muddy midpoint sRGB gives between saturated hues;
  `midpoint` to shift the half-way point instead of adding stops. Prefer linear or radial for
  portability; conic and diamond export as SVG patterns.
- **Appearance stacks over duplicate shapes.** For a gradient over a texture, a tinted overlay,
  an outline around an outline or a stroke inside and another outside, stack layers on one path
  (`vector.addFill`, `vector.addStroke`) instead of copying the shape: the copies would drift
  apart when edited. Give each stroke its own `strokeAlign` (outside under, inside or center on
  top) and widths that step down towards the top. Use per-layer `opacity` and `blendMode`
  (multiply to darken, screen to lighten, overlay for texture) rather than node opacity when only
  one paint should fade.
- **Masks over cut-outs.** To show artwork inside a shape (a photo-like fill in a circle, a
  pattern inside text-like outlines, a scene seen through a window), use
  `vector.makeClippingMask` rather than a destructive intersect: the contents stay editable and
  movable inside the frame. Draw the mask last (on top) and make the mask from it; edit the mask
  later by its `maskId`. Use `vector.makeOpacityMask` with a white-to-black gradient for fades
  and reflections (luminance: white shows). A clip's own paint is never drawn, so its fill
  colour does not matter. Effects and shadows on the mask group follow the masked silhouette.
- **Shadows and glows.** Keep drop shadows subtle: black at 0.15 to 0.3 opacity, `offsetY` 2 to 8,
  `blur` about twice the offset. Use one light direction for every shadow in a design. Filters
  export as SVG filters, which some tools (and older renderers) draw slightly differently or not
  at all; a design that must look identical everywhere should avoid them or rasterize.
- **Diagrams with connectors.** Lay the boxes out first, then `vector.connect` them (in one
  `run_commands` batch) rather than drawing lines: connectors stay attached when boxes move, and
  `route: "elbow"` with a small `radius` reads well in flowcharts. Leave sides `auto` unless a
  connector must leave a particular side.

- **Constraints for precise, editable geometry.** For technical drawings, diagrams, floor plans or
  any shape that must keep exact relations, draw it roughly, run `vector.autoConstrain`, then add
  the dimensions that matter (`vector.addConstraint` distance / angle / radius) and name them so
  related sizes follow one another (`vector.setConstraintValue` with expressions like `w / 2`).
  Check `vector.listConstraints` `dof`: aim for `fully` on parts that must not drift; `over`
  means some constraints repeat others. Prefer few, meaningful constraints over many.

- **Vertical text.** For Japanese, Chinese or Korean set in columns (signage, book spines, posters), use vertical
  text (`textOrientation: "vertical"` or `vector.setTextOrientation`): CJK stands upright, Latin
  turns sideways; set a short Latin range `upright: true` to stack it letter by letter. In an
  area, columns that do not fit past the left edge are `overflow`. Vertical text cannot follow a
  path.
