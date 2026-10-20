# Vector command parameters

Detail for the `vector.*` commands in `../SKILL.md`. Units are document units unless noted;
angles are degrees, clockwise on screen (y down).

## Paint and gradients

A paint (`fill`, `stroke`) is a CSS colour string, `null` (none), or a gradient object that needs
`type` and at least one stop:

```json
{ "type": "linear", "angle": 90, "interpolation": "oklab",
  "stops": [{ "offset": 0, "color": "#f43f5e" }, { "offset": 1, "color": "#7c3aed", "midpoint": 0.4 }] }
```

| Field | Meaning |
| --- | --- |
| type | `linear`, `radial`, `conic` (angle sweep), `reflected` (linear mirrored about the start), `diamond`. |
| stops | `{ offset 0-1, color, opacity? 0-1, midpoint? 0.05-0.95 }`; `midpoint` is where the two colours are half mixed (default 0.5). |
| angle | Shorthand direction: 0 is up. Linear / reflected direction across the box (default 180, top to bottom); conic start angle and diamond turn (default 90). |
| cx, cy, r | Shorthand centre and radius of radial / conic / diamond, fractions of the box (default 0.5). |
| start, end, width | Explicit frame `{ x, y }`: start (centre for radial / conic / diamond), end of the main axis (the radius), end of the secondary axis (aspect; default square and as long). Wins over the shorthand. |
| focal, focalRadius | Radial focal point (SVG fx / fy) and focal circle radius as a fraction of the radius (0-0.99). |
| units | `objectBoundingBox` (default: fractions of the shape's box, follows the box) or `userSpaceOnUse` (the node's own coordinates, follows scale and skew exactly). |
| spread | `pad` (default), `reflect`, `repeat`. |
| interpolation | `srgb` (default, SVG's own), `linear` (linear light), `oklab` (perceptual). Non-sRGB ramps export as extra stops. |
| smoothness | 0-1: bends the ramp along a spline through the stops (0 straight). |
| strokeMode | On strokes: `within` (default, like a fill), `along` (0 to 1 along each subpath), `across` (left edge to right edge). Along / across export as patterns. |

`vector.setGradient` also takes `target` (`fill` default, or `stroke`), `aspect` (secondary axis
length over main axis length), `reverse: true` (flip stops and midpoints), and `focal: null` /
`width: null` to remove them. Missing fields keep their current value.

## Stroke settings

| Field | Values |
| --- | --- |
| strokeWidth | Number, at least 0. Default from the editor defaults (1 when unset). |
| strokeLinecap | `butt`, `round`, `square`. |
| strokeLinejoin | `miter`, `round`, `bevel`. |
| strokeDasharray | Array of dash and gap lengths. |
| strokeAlign | `center` (default), `inside`, `outside`. Only on paths whose subpaths are all closed. |
| startArrow, endArrow | `triangle`, `arrow`, `open`, `circle`, `square`, `bar`, or `null`. On the start of the first subpath and the end of the last one, when open. A head is 4 x its weight long and wide. |
| arrowAlign | `extend` (default: tip past the end point, path keeps its length) or `tip` (tip on the end point, stroke shortened). |
| startArrowScale, endArrowScale | Head weight as a multiple of the stroke width (default 1). |
| fillRule | `nonzero`, `evenodd`. |

## Fill and stroke stacks, blend modes and filters

- **Layers.** A fill layer is `{ paint, opacity?, blendMode?, visible? }` (opacity 0 to 1,
  default 1; blend mode default normal; visible default true). A stroke layer adds the stroke
  settings above (`strokeWidth`, `strokeAlign`, …). Stacks list bottom to top; fills draw under
  strokes. A path with one plain layer of each stores them as `fill` / `stroke`, so
  `vector.getAppearance` is the way to read a stack as layers.
- **Blend modes** (CSS `mix-blend-mode` names): normal, darken, multiply, color-burn, lighten,
  screen, color-dodge, linear-dodge (drawn as plus-lighter), overlay, soft-light, hard-light,
  difference, exclusion, hue, saturation, color, luminosity. The image editor's linear burn,
  vivid light, pigment and the like have no SVG equivalent.
- **Filters** (lengths in document units, colours CSS):
  - `dropShadow`: `color` (#000000), `opacity` (0.25), `offsetX` (0), `offsetY` (4), `blur` (4),
    `spread` (0).
  - `innerShadow`: the same; `spread` chokes inwards.
  - `outerGlow` / `innerGlow`: `color` (#ffffbe), `opacity` (0.75), `blur` (10), `spread` (0).
  - `layerBlur`: `radius` (4), blurring everything the node draws, shadows included.
  - `feather`: `radius` (8), fading the edges inwards over that width.
  Blur radii follow CSS: they reach about 1.5 times the radius. Inner effects draw over the body,
  then feather, then shadows and glows under it, then layer blurs over everything.

## Variable-width strokes

A width profile is a list of `{ t, left, right }`: `t` is the position along each subpath by
length (0-1), `left` / `right` how far each side reaches as a multiple of half the stroke width
(1 = uniform; left is left looking along the path). Sides interpolate with a monotone cubic, so
they never overshoot; two points at one `t` make a step. `null` or `[]` is uniform.

`vector.setWidthProfile` takes one of:

- `preset`: `uniform` (removes the profile), `taperStart`, `taperEnd`, `taperBoth`, `bulge`,
  `pinch`, `teardrop`, `wave`, `pressure`.
- `points`: the explicit list above.
- `taper` (fractions, all default 0): `startLength` / `endLength` (share of the path each taper
  covers), `startWidth` / `endWidth` (width at the end as a fraction; 0 is a point),
  `startEase` / `endEase` (0 linear, 1 a quarter circle bulging out).
- `wave`: `amount` 0-1 (default 0.5; the width swings between 1 - amount and 1), `cycles`
  (default 4), `phase` degrees (default 0). `taper` and `wave` combine.

`vector.setWidthPoint` sets one point with `left` / `right` in **document units** (not multiples),
by `index` into the returned profile, or adds one at `t` when `index` is left out.

## Live corners

`cornerRadius` (on `vector.addShape`) and `radius` (on `vector.setCorners`) are in document
units; `kind` / `cornerKind` is `round` (default), `inverted` (an arc cut into the shape) or
`chamfer` (a straight bevel). A corner is any non-smooth anchor where two sides meet, except the
ends of an open subpath. Radii that do not fit shrink so each cut takes at most half of a side.

## Path effects

`vector.addEffect` and `vector.updateEffect` take `params`; missing ones keep their value or the
default below. Lengths are in the node's own units, angles degrees, percentages 0-100.

| Type | Parameters (defaults) | Effect |
| --- | --- | --- |
| trim | start 0, end 50 (%), offset 0 (deg), mode `simultaneous` or `individual` | Keep the part between start and end; `individual` trims all paths as one length in stacking order. Good for line-drawing reveals. |
| roundCorners | radius 10 | Arc of that radius at every corner. |
| puckerBloat | amount 30 (-100 to 100) | Positive bloats segments outward, negative makes spikes. |
| twist | angle 45, center {x 0, y 0} (offset from the middle) | Turn more the farther from the centre. |
| zigzag | size 5, ridges 4, smooth false | Each segment split into ridges + 1 pieces pushed alternately to either side. |
| wiggle | size 5, detail 6, smooth true, speed 2, correlation 50, phase 0, seed 1, time 0 (s) | Deterministic noise displacement; animate `time` to animate it. |
| offset | amount 5, join `miter`, miterLimit 4, copies 1, copyOffset 0 | Grow or shrink; copies make concentric rings. |
| merge | mode `add` (also `merge`, `subtract`, `intersect`, `exclude`) | Combine the shapes above it into one, in the bottom shape's style. |
| repeater | copies 3, offset 0, position {x 100, y 0}, anchor {x 0, y 0}, rotation 0, scale {x 100, y 100} (%), startOpacity 100, endOpacity 100 (%), composite `below` | Copy i is moved, rotated and scaled k = i + offset times about the anchor; fractional copies fade the last one. Radial patterns: position {0, 0}, rotation 360 / copies. |
| contour | direction `inside`, steps 4, offset 6, fillColor `#ffffff`, strokeColor null, acceleration 0, join `round`, miterLimit 4 | CorelDRAW's Contour: each shape plus `steps` concentric copies `offset` apart (`center`: inward until the shape is used up), their fill and stroke blending to the end colours (null keeps the shape's colour); inside steps draw over the shape, outside ones under it. Acceleration −100…100 holds the colour back (positive) or rushes it (negative). Use for embossed badges, topographic lines and soft glows. |
| envelope | style `arc`, bend 50, horizontal 0, vertical 0, orientation `horizontal`, rows 2, columns 2, mesh null | Prefer `vector.envelope`. |

Effects apply in stack order (index 0 first) to everything above them; effects after a repeater
act on its copies. A node with effects exports as `<g data-vector-live>`: other SVG readers see
the drawn result. Use `vector.expandAppearance` for plain paths.

## Envelopes and distortion

`vector.envelope` (one of these per call):

- **Warp**: `preset` one of `arc`, `arcLower`, `arcUpper`, `arch`, `bulge`, `shellLower`,
  `shellUpper`, `flag`, `wave`, `fish`, `rise`, `fisheye`, `inflate`, `squeeze`, `twist`;
  `bend`, `horizontal`, `vertical` in percent (-100 to 100); `orientation` `horizontal` or
  `vertical`.
- **Mesh**: `mesh: { rows, columns, points? }` (1-16 each, default 2 x 2). `points` is the full
  control grid row by row in the node's own space: (3 x columns + 1) x (3 x rows + 1) points.
  Not combinable with `preset`.
- `topObject: true`: the topmost selected closed path becomes the envelope of the others
  (`mesh.rows` / `mesh.columns` set its grid).
- `release: true`: remove the envelope and get its shape back as a path.
- `expand: true`: bake it (same as `vector.expandAppearance`).

`vector.distort` maps the selection box's corners (clockwise from the top left, in the box's own
rotation) to four new points forming a convex quad: a perspective map in which straight lines
stay straight. `vector.skew`: `x' = x + tan(ax) * y` along the box's axes.

## Blends

| Option | Meaning |
| --- | --- |
| spacing | `steps` (default), `distance`, `smoothColor` (one step per two colour levels of difference, at most 256). |
| steps | In-betweens between each pair of keys (1-1000, default 5). |
| distance | Spacing along the spine (default 20). |
| orientToSpine | Turn in-betweens with a replaced spine. |
| linear | Straight-line anchor paths instead of the rotation-aware morph. |
| keepOrder | (`vector.blend` only) blend in `ids` order instead of stacking order. |
| starts | (`vector.blend` only) `{ keyId: anchorIndex }`: where each key's first subpath starts, to stop twisting. |

In-betweens have ids `<blend id>~1`, `~2`, ... and are locked; colours mix in OKLab.

## Shape Builder, Pathfinder and paint bucket

All three work in document space with every transform applied. A filled path takes part as its
fill; an unfilled stroked path takes part as the area its stroke paints. Pathfinder `divide` and
`outline` also run on a single path; the other operations need two or more overlapping paths. Shape Builder
`points` should come from `vector.shapeBuilderFaces` (`point` of each face) so a click lands
inside the intended face.
