---
name: pixerate-vector
description: How to draw and edit vector artwork in the Pixerate vector editor through its vector.* commands - adding shapes and SVG paths, fills, strokes, stacked fills and strokes with blend modes, drop shadows, glows and blurs, gradients (linear, radial, conic, Oklab interpolation), stroke alignment, arrowheads, variable-width and tapered strokes, live corner radii, boolean operations and Pathfinder (unite, subtract, divide, trim), Shape Builder, paint bucket, live path effects (trim paths, repeater, zig zag, offset), envelope warps and free distort, blends and morphing, anchor editing (join, smooth, simplify, scissors, knife, eraser), align, distribute, group, stacking order, and SVG import and export. Use when creating an icon, logo, illustration, glyph, badge or any Bezier path artwork, or editing an SVG in a Pixerate vector editor.
---

# Pixerate vector editor

The vector document is an artboard (`width` x `height` in document units, y down) holding a tree
of **nodes**: `path` nodes (one or more subpaths of Bezier anchors, with fill, stroke and stroke
settings) and `group` nodes. Groups can also be live booleans, live blends, or carry a live
effect stack. Every command is a `vector.*` command run with `run_command` / `run_commands` (see
`pixerate-agent-tools` for batching with `"$0.id"` references, `atomic: true` and error codes).

- **Node ids** come from `vector.list` and from what writes return (`{ id }`, `{ ids }`).
- **Anchors** are `{ nodeId, subpath, index }`: subpath number within the path, then anchor
  number within the subpath, both from 0. Commands that take `anchors` default to the points
  selected with the direct tool; those that take `ids` default to the selection.
- **Paint** is a CSS colour, `null` for none, or a gradient object
  `{ type, stops: [{ offset, color, opacity?, midpoint? }], ... }`.
- **Appearance**: a path can stack several fills and several strokes (bottom to top; all fills
  draw under all strokes), each with its own paint, `opacity`, `blendMode` and `visible`, and
  each stroke with its own width, alignment, dashes, caps, joins, arrowheads and profile. Layers
  are addressed by `index` in their stack, 0 at the bottom. `fill` / `stroke` and the stroke
  settings of `vector.setStyle` are shorthands for the **top** layer; `null` clears the stack.
  Any node can also have a `blendMode` and `filters` (drop / inner shadow, outer / inner glow,
  layer blur, feather), which never change geometry.
- Coordinates are document units. A rotated node stores its geometry in its own space: the
  `bounds` that `vector.list` reports are document-space, its `d` is the node's own.

Parameter details (gradient fields, effect parameters, width profiles, envelopes) are in
[references/commands.md](references/commands.md).

## Working method

1. **Read.** `vector.list` gives the artboard size, every node depth first (id, type, name,
   bounds, rotation, fill, stroke, `d`, effects, blend and boolean info, stacks, blend mode and
   filters) and the selection. `vector.getAppearance` gives one node's full stacks and filters.
2. **Plan in layers.** Decide the shapes, their stacking (bottom to top) and their grouping
   before drawing. Start from primitives (`vector.addShape`) and combine them; write raw `d`
   only for curves primitives cannot make.
3. **Write in batches.** Put a construction sequence in one `run_commands` with `atomic: true`
   and a `label`, chaining ids (`"$0.id"`, `"$last.ids"`), so it is one undo step that applies
   all or nothing.
4. **Prefer live, expand last.** Use `live: true` booleans, path effects, envelopes, live
   corners and blends while designing; bake with `vector.expandAppearance`,
   `vector.expandBlend` or `vector.outlineStroke` only when the user needs plain paths.
5. **Check.** `vector.list` again: bounds where you meant them, no stray nodes, sensible names.
   `vector.exportSvg` gives the final markup; review it, or render it if you can, before handing
   it over.

## Best practices

- **Clean paths.** Use the fewest anchors that describe the shape: anchors at extrema (top,
  bottom, left, right of a curve) and at true corners, handles horizontal or vertical at extrema,
  each handle about a third of its segment. Run `vector.removeRedundantPoints` after
  booleans, knife and pencil work; `vector.smooth` for lumpy curves; `vector.deleteAnchors`
  keeps the outline by refitting neighbours.
- **Live corners over drawn arcs.** Give rectangles, polygons and stars a `cornerRadius`
  (`vector.addShape`) or set it with `vector.setCorners`; the anchors stay sharp and editable and
  radii shrink to fit short sides. Keep one radius scale across a design.
- **Non-destructive first.** Live booleans (`vector.boolean` with `live: true`), path effects
  and envelopes keep the operands editable. A destructive boolean or Pathfinder replaces its
  inputs; do that last, and only when asked for flat output.
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
- **Shadows and glows.** Keep drop shadows subtle: black at 0.15 to 0.3 opacity, `offsetY` 2 to 8,
  `blur` about twice the offset. Use one light direction for every shadow in a design. Filters
  export as SVG filters, which some tools (and older renderers) draw slightly differently or not
  at all; a design that must look identical everywhere should avoid them or rasterize.
- **Grouping and naming.** Group the parts of one object (`vector.group` with a `name`), name
  paths that matter (`name` on add), and keep the tree shallow.
- **SVG hygiene.** Export with `precision` 2 or 3 (default 3); higher only for tiny artboards.
  Expand effects, blends and variable-width strokes before handing SVG to tools that do not read
  Pixerate's `data-vector-*` attributes; other readers see the drawn appearance but not the live
  source.

## Commands

### Read

| Command | Use it to |
| --- | --- |
| `vector.list` | Read the document: `{ width, height, nodes, selection, tool }`. Each node has id, type, name, depth, document-space `bounds`, `rotation` (degrees clockwise), visible, locked, selected, and for paths fill, stroke, strokeWidth and `d`; groups list `children`, `blend`, `liveBoolean`, `effects`. Call it first and after any batch. |
| `vector.shapeBuilderFaces` | List the regions the given paths divide the plane into: path data, area, a point inside each and the ids of paths filling it. Use the points with `vector.shapeBuilder`. |
| `vector.exportSvg` | Get the document as standalone SVG markup (`{ svg }`); `precision` 0 to 8 decimals (default 3). |

### Create and delete

| Command | Use it to |
| --- | --- |
| `vector.addShape` | Add a `kind` `rect`, `ellipse`, `polygon` (`sides`, at least 3), `star` (`points`, `innerRatio` 0 to 1) or `line` at `x`, `y`, `width`, `height` (all required; for a line, width and height are the end's offset). `cornerRadius` and `cornerKind` give live corners; any style field and `name` apply. Uses the editor's default style for anything not given. Returns `{ id }`. |
| `vector.addPath` | Add a path from SVG path data `d` (absolute or relative M, L, H, V, C, S, Q, T, A, Z; arcs and quadratics become cubics) in document units, with `name` and style fields; unset style comes from the editor defaults. Fails when `d` has no points. Returns `{ id }`. |
| `vector.importSvg` | Add the shapes of SVG markup `svg` on top of the document, or replace the document with `replace: true`. Reads paths, basic shapes, groups, transforms and linear and radial gradients; skips text, images, masks, filters and `use`. |
| `vector.delete` | Delete nodes (`ids`). |

### Style

| Command | Use it to |
| --- | --- |
| `vector.setStyle` | Set `fill`, `stroke`, `strokeWidth`, `strokeLinecap` (butt, round, square), `strokeLinejoin` (miter, round, bevel), `strokeDasharray`, `fillRule` (nonzero, evenodd), `strokeAlign` (center, inside, outside; closed shapes only), `startArrow` / `endArrow` (triangle, arrow, open, circle, square, bar, or null), `arrowAlign` (extend, tip), `startArrowScale` / `endArrowScale` (multiples of stroke width, default 1), `strokeWidthProfile` on `ids`. Groups apply to every path inside. Pass at least one field. |
| `vector.setGradient` | Edit the gradient of the fill (`target` default) or stroke of `ids`: `type` (linear, radial, conic, reflected, diamond), `stops`, `angle` (degrees, 0 up, clockwise), `cx` / `cy` / `r`, explicit `start` / `end` / `width` / `focal`, `units`, `spread`, `interpolation` (srgb default, linear, oklab), `smoothness`, `strokeMode`, `aspect`, `reverse`. Missing fields keep their value; a solid colour becomes a gradient from it to white. Returns the gradient. |
| `vector.setCorners` | Set live corner `radius` (0 makes them sharp) and / or `kind` (round, inverted, chamfer) on `anchors`, else the selected points, else every corner of `ids`. |
| `vector.setWidthProfile` | Give strokes a variable width: a `preset` (uniform, taperStart, taperEnd, taperBoth, bulge, pinch, teardrop, wave, pressure; `uniform` removes it), explicit `points`, or a parametric `taper` and / or `wave`. Returns the profile points. |
| `vector.setWidthPoint` | Set one width point of path `id`: `index` of an existing point (from the profile `vector.setWidthProfile` returns) or none to add one at `t` (0 to 1); `left` / `right` are side widths in document units. Returns the profile. |

### Appearance: fill and stroke stacks, blend modes, filters

| Command | Use it to |
| --- | --- |
| `vector.getAppearance` | Read node `id`'s appearance: for paths `fills` and `strokes` (bottom to top, each with `paint`, `opacity`, `blendMode`, `visible`; strokes with their settings) and `fillRule`; for any node `blendMode`, `opacity` and `filters` (with ids). Call it before editing a layer by index. |
| `vector.addFill` | Add a fill layer (`paint`, default #808080; `opacity`, `blendMode`, `visible`) to `ids` (groups: every path inside), on top or at `index` (0 is the bottom). Returns each path's fill stack. |
| `vector.updateFill` | Change fill `index` of path `nodeId`: `paint`, `opacity`, `blendMode`, `visible`. Fails, changing nothing, on an index the path doesn't have. Returns the fill stack. |
| `vector.removeFill` | Remove fill `index` from path `nodeId`. Returns the remaining fills. |
| `vector.moveFill` | Move fill `index` of path `nodeId` to position `to` (0 is the bottom). Returns the fills. |
| `vector.addStroke` | Add a stroke layer to `ids`, on top or at `index`, with `paint` (default black), `opacity`, `blendMode`, `visible` and any stroke setting (`strokeWidth`, `strokeAlign`, `strokeLinecap`, `strokeLinejoin`, `strokeDasharray`, arrowheads, `strokeWidthProfile`); unset settings copy the current top stroke. Returns each path's stroke stack. |
| `vector.updateStroke` | Change stroke `index` of path `nodeId`: paint, opacity, blend mode, visibility, any stroke setting (`null` removes an arrowhead, dashes or a profile). Returns the stroke stack. |
| `vector.removeStroke` | Remove stroke `index` from path `nodeId`. Returns the remaining strokes. |
| `vector.moveStroke` | Move stroke `index` of path `nodeId` to position `to` (0 is the bottom, drawn first). Returns the strokes. |
| `vector.setBlendMode` | Set how whole nodes `ids` (paths or groups) mix with what is under them: `blendMode` normal, darken, multiply, color-burn, lighten, screen, color-dodge, linear-dodge, overlay, soft-light, hard-light, difference, exclusion, hue, saturation, color, luminosity. Returns each node's mode. |
| `vector.addFilter` | Add a filter `type` (dropShadow, innerShadow, outerGlow, innerGlow, layerBlur, feather) with `params` to `ids`, at `index` (default last). Returns `{ nodes: [{ id, filterId, filters }] }`. |
| `vector.updateFilter` | Change filter `filterId` of `nodeId`: `params` (merged; only the keys its type takes) and `enabled`. Returns the node's filters. |
| `vector.removeFilter` | Remove filter `filterId` from `nodeId`. Returns the remaining filters. |
| `vector.moveFilter` | Move filter `filterId` of `nodeId` to `index`; later shadows draw over earlier ones. Returns the filters. |

`vector.setStyle`, `vector.addShape` and `vector.addPath` also take whole `fills` / `strokes`
arrays, to build or replace a stack in one call.

### Transform and arrange

| Command | Use it to |
| --- | --- |
| `vector.transform` | Move by `dx`, `dy`, scale by `sx`, `sy` (along the selection box axes; `sy` defaults to `sx`; negative flips), rotate by `rotate` degrees clockwise about the combined centre, or set each node to absolute `angle` about its own centre, applied in that order. |
| `vector.skew` | Skew by `ax` degrees horizontally and `ay` degrees vertically (each -89.9 to 89.9) about the box centre or `origin`. |
| `vector.distort` | Free Distort in perspective: give `corners`, the four new corners of the selection box (top-left, top-right, bottom-right, bottom-left) in document units, forming a convex quad. `tolerance` (default 0.05) controls curve fidelity. Returns the new bounds. |
| `vector.align` | Align `ids` on `edge` (left, center, right, top, middle, bottom) to their combined bounds, or to the artboard with `to: "artboard"` (also the default for a single node). |
| `vector.distribute` | Give three or more nodes equal gaps in `direction` horizontal or vertical. |
| `vector.arrange` | Change stacking `order` within each node's parent: front, forward, backward, back. |
| `vector.group` | Group nodes that share a parent, with an optional `name`. Returns `{ id }`. |
| `vector.ungroup` | Replace groups with their children (ungrouping a blend expands it). |
| `vector.select` | Select nodes by `ids` (`add: true` to extend; an empty list clears). Selection is the default target of most commands. |

### Combine

| Command | Use it to |
| --- | --- |
| `vector.boolean` | Combine two or more paths by `operation` union, subtract (upper shapes from the lowest), intersect or exclude into one new path. With `live: true` the shapes become editable operands of a live boolean group instead (with a lone live group selected, its operation changes). Returns `{ id }`. |
| `vector.pathfinder` | Run a Pathfinder `operation` over paths bottom to top: `divide` (every face its own shape), `trim` (hidden parts removed), `merge` (trim, then same-fill parts joined), `crop` (top shape crops the rest), `outline` (outlines cut into open strokes), `minusBack` (top minus everything below). Results replace the inputs, grouped when several. Returns `{ ids }`. |
| `vector.shapeBuilder` | Merge the faces a pointer path touches into one shape, or delete them (and touched line pieces and edges) with `erase: true`. `points` is `[[x, y], ...]` in document units (one point is a click; use points from `vector.shapeBuilderFaces`), `tolerance` for edge picks. Returns counts. |
| `vector.fillRegion` | Paint bucket: fill the area visible outlines enclose around `point` `[x, y]` with a new path in the current fill (islands stay holes). `gap` closes gaps up to that size between loose ends. Returns `{ id }`. |
| `vector.outlineStroke` | Turn strokes into filled shapes of exactly the painted area (alignment, caps, joins, dashes, arrowheads, width profiles included), above a copy keeping the fill. Returns the new ids. |

### Live effects and envelopes

| Command | Use it to |
| --- | --- |
| `vector.addEffect` | Add a live path effect `type` (trim, roundCorners, puckerBloat, twist, zigzag, wiggle, offset, merge, repeater, envelope) with `params` to `ids`, at `index` in the stack (default last). Effects apply top to bottom. Returns `{ effects: [{ nodeId, effectId }] }`. |
| `vector.updateEffect` | Change effect `effectId` on `nodeId`: `params` (merged), `enabled`, or move it to `index` (0 applies first). Returns the node's effect stack. |
| `vector.removeEffect` | Remove effect `effectId` from `nodeId`. |
| `vector.envelope` | Warp with a live envelope: a `preset` (arc, arcLower, arcUpper, arch, bulge, shellLower, shellUpper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist) with `bend`, `horizontal`, `vertical` (percent, -100 to 100) and `orientation`; or a `mesh` of `rows` x `columns` (1 to 16, optional control `points`); or `topObject: true` (top closed path becomes the envelope), `release: true`, `expand: true`. Reapplying changes an existing envelope. |
| `vector.expandAppearance` | Bake path effects, envelopes and live booleans of `ids` (and everything inside) into plain paths. Returns the ids. |

### Blends

| Command | Use it to |
| --- | --- |
| `vector.blend` | Make a live blend of two or more paths or groups sharing a parent (bottom to top, or the order of `ids` with `keepOrder`): shape and paint morph through in-betweens. `spacing` steps (default; `steps` default 5), distance (`distance` default 20) or smoothColor; `orientToSpine`; `linear` for straight anchor paths; `starts` maps key ids to start anchors. Returns `{ id }`. |
| `vector.blendOptions` | Change `spacing`, `steps`, `distance`, `orientToSpine`, `linear` of blends; in-betweens regenerate. |
| `vector.replaceSpine` | With one blend and one path given, make the path the blend's spine; keys spread along it by arc length. |
| `vector.expandBlend` | Turn blends into plain groups of editable keys and in-betweens. Returns the group ids. |
| `vector.releaseBlend` | Remove the in-betweens and give back the keys (and a replaced spine as an unpainted path). Returns their ids. |

### Path editing

| Command | Use it to |
| --- | --- |
| `vector.moveAnchor` | Move anchor (`nodeId`, `subpath`, `index`) to `x`, `y` in document units, carrying its handles; `curvature: true` bends its two segments like the Curvature tool instead (default: the `curvatureMoves` editing setting, off). |
| `vector.bendSegment` | Bend segment `segment` (anchor `segment` to the next) of `nodeId` / `subpath` so the curve passes through `x`, `y` at parameter `t` (default 0.5). |
| `vector.deleteAnchors` | Delete `anchors`. `keepShape` (default the editor setting, on) refits the neighbours so the outline keeps its shape. |
| `vector.join` | Join open subpaths of `ids`, nearest ends first (ends within `tolerance` merge, others get a straight segment); a single open path is closed. |
| `vector.average` | Move `anchors` to their average: same y (`axis` horizontal), same x (vertical) or same point (both, default). |
| `vector.removeRedundantPoints` | Drop anchors that can go without moving the outline more than `tolerance` units (default 0.5). |
| `vector.smooth` | Pull handles of `ids` (or of `anchors`) towards smooth tangents by `amount` 0 to 1 (default 1). |
| `vector.cut` | Scissors: cut `nodeId` at the outline point nearest `x`, `y`, or cut at `anchors`. A closed path opens; an open one splits in two. Returns the ids. |
| `vector.knife` | Cut closed paths along a polyline `points` (at least two `[x, y]`) wherever it crosses them edge to edge, leaving no gap. Cuts `ids`, else the selection, else every path crossed. Returns the pieces. |
| `vector.erase` | Erase along a polyline `points` with a round eraser of diameter `size` (default the eraser setting, 10): fills lose the area, outlines are cut. Returns the changed ids. |

### Editor settings

| Command | Use it to |
| --- | --- |
| `vector.setEditing` | Set editing behaviour: `keepShapeOnDelete`, `curvatureMoves`, `pencilSmoothing` (0 to 1), `recognizeShapes`, `eraserSize`, `pencilPressure` (pen, all, off). Returns the settings. |
| `vector.setTool` | Switch the interactive tool (select, direct, pen, pencil, rect, ellipse, polygon, star, line, scissors, knife, eraser, width, shapeBuilder, paintBucket, blend, gradient, envelope). Only for handing the canvas to the user in a given mode; commands do not need a tool. |

## Pitfalls

- The `d` in `vector.list` draws live corners cut, which adds anchors. On a path with corner
  radii, anchor indices counted from `d` do not match the stored anchors; count anchors on a path
  without corners, or clear corners first.
- `d` and anchor positions are in the node's own space; `bounds` are in document space. For
  rotated nodes (`rotation` not 0), `vector.moveAnchor` and `vector.bendSegment` take document
  coordinates, so compute them from the drawn position, not from `d`.
- `vector.boolean` without `live` fails when the result is empty (shapes that do not overlap)
  and consumes its inputs. Subtract removes upper shapes from the lowest: restack with
  `vector.arrange` first.
- `vector.blend`, `vector.group` and live booleans need nodes that share a parent.
- Blend in-betweens are locked and regenerate; edit the keys, not the steps.
- `strokeAlign` inside and outside only apply when every subpath is closed.
- Stroke widths, corner radii and effect sizes are kept when scaling: scale them yourself if the
  design should grow proportionally.
- `vector.importSvg` without `replace` adds on top; with `replace: true` it discards the current
  document (undoable, but confirm with the user first).
- With a stack, `vector.setStyle` `fill` / `stroke` and the stroke settings edit only the top
  layer, and `fill: null` / `stroke: null` remove every layer. Edit other layers with
  `vector.updateFill` / `vector.updateStroke`, by the index `vector.getAppearance` reports.
- Layer indexes shift after a remove or a move: use the stack each write returns.
- Path effects apply to the whole node, every layer alike. Blend in-betweens mix the top fill and
  stroke only.
- Filters and blend modes are drawn, not geometry: bounds, snapping, booleans and Outline Stroke
  ignore them. A node's blend mode and filter isolate its layers, so layer blend modes inside a
  node with a filter mix only with the node's own layers. Background blur is not available.
- A command that fails changes nothing; read its message (for example "Nothing is selected; pass
  ids.") and retry with the missing input.
