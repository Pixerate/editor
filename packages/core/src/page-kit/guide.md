# Pixerate page kit

The page kit is a script inlined into the page. It sets `window.pixerateKit` (here `kit`), which holds the tested geometry, path, text, colour and number helpers of the Pixerate editors, plus a small page layer: SVG elements, theme, redraw on resize, and the motion contract. Use it instead of writing these by hand. The page loads nothing from the network, so the kit is all there is besides your own code.

```js
const kit = window.pixerateKit;
```

Positions are CSS px, with y growing down. Points are `{ x, y }` unless a helper says otherwise. Every helper is pure unless it says it touches the page.

## Geometry

| Helper | Use it for | Returns |
| --- | --- | --- |
| `placeLabels(labels, options)` | Putting labels near their anchors without covering marks, other labels or anchors. Each label is `{ anchor, width, height, wrapped?, prefer? }`. Options: `obstacles` (`{ box }`, `{ point }`, `{ segment }`, `{ polygon }`), `bounds`, `gap`, `prefer`, `distance`, `reach`, `leader`. Measure the text first (`canvasMeasure`). | One `{ x, y, width, height, side, wrapped, leader, clashes, ok }` per label, in order |
| `labelHull(points)` | The convex hull of a set of points, as an obstacle for `placeLabels`. | Points |
| `isoProjector({ angle, scale, origin })` | Isometric (2.5D) drawing. `point(i, j, k)` gives `{ x, y }`. `box({ i0, i1, j0, j1, k0, k1 })` gives the visible `top`, `left` and `right` faces plus `outline` and `bounds`. `corners(box)` and `gridLines(box, step)` are there too. | A projector |
| `isoOrder(boxes, projector)` | Back-to-front order for drawing isometric boxes, so nearer ones cover farther ones. | Indices |
| `isoFaceColors(fill)` | Shades for the three faces of an isometric box: the top as given, the left 15 % darker and the right 30 % darker. | `{ top, left, right }` |
| `elbow(from, to, { level, radius, axis })` | One rounded right-angle connector. With `axis: 'vertical'` (the default) it runs up or down, across at `level`, then up or down again. | `{ segments, d, length, level }`: use `d` as a path's `d`, and `length` to draw it on |
| `fanElbows(root, targets, { gap, step, radius, lead, axis })` | Connectors from one root to a row of targets that never cross (lineage, org trees, timelines). The outermost target turns nearest the root. | `{ elbows, levels, starts, step, radius }`, in the targets' order |
| `roundedPolyline(points, radius)` | Rounding the right-angle corners of any polyline. | `{ segments, d, length }` |
| `helix([from, to], { amplitude, turns, phase, envelope, samples })` | A strand wound around an axis (a braid, a rope, DNA). `envelope` is `'none'`, `'pinch'`, `'start'`, `'end'` or `t => scale`. Strands of an n-strand braid differ in `phase` by 2π/n. | `{ points, depth, d, length }`, where `depth` is -1 behind to 1 in front |
| `splitByDepth(points, depth)` | Cutting a strand into front and back runs exactly where it crosses, so you can draw back runs first, then other strands, then front runs (over/under). | Runs `{ front, points, d, from, to, length }` |

## Paths

| Helper | Use it for | Returns |
| --- | --- | --- |
| `pathLength(d)` | The length of SVG path data (arcs are measured as curves), for draw-on with `stroke-dasharray`. | Number |
| `pointAtLength(d, length)` | Placing a marker or label partway along a path. | `{ x, y, angle }` (radians), or null |
| `trimPath(d, from, to)` | The part of a path between two lengths from its start, as path data. Use it for a line drawn on in pieces. | Path data |

## Text

Measure with `canvasMeasure(font)` in the page. It uses the page's own fonts. `estimatedMeasure(category)` only estimates.

| Helper | Use it for | Returns |
| --- | --- | --- |
| `fitText(words, width, { measure, min, max, step, tracking })` | The largest size (whole or half px) at which every word of a row of labels fits a column width. `tracking: { floor: -0.05 }` lets it tighten letter spacing at `min` before giving up. | `{ size, letterSpacing, fits, word }`: if `fits` is false, wrap, abbreviate or stagger |
| `staggerRows(words, positions, { measure, size, letterSpacing, gap })` | Whether labels centred at `positions` fit one row, or need two alternating rows. | `{ rows, count, fits }` |
| `canvasMeasure(font)` | A measure for `fitText` and `staggerRows` that uses the page's fonts. `font` is a CSS font without its size, e.g. `'600 Inter, sans-serif'`. | `(word, size, letterSpacing) => width` |
| `estimatedMeasure(category)` | A rough measure from average glyph widths (`'sans-serif'`, `'serif'`, `'monospace'`, `'display'` or `'handwriting'`), for when there's no canvas. | `(word, size, letterSpacing) => width` |

## Colour

| Helper | Use it for | Returns |
| --- | --- | --- |
| `contrast(a, b)` | The WCAG contrast ratio of two CSS colours (1–21). Body text needs 4.5, large text and marks 3. | Number, or null |
| `ink(fill, { dark, light, scheme })` | The text colour that reads on a fill: whichever of `dark` (default `#111111`) and `light` (default `#ffffff`) contrasts more. | A colour, or undefined for a CSS variable |
| `mix(from, to, t, { space })` | A colour partway between two others, mixed in OKLab by default. | A colour, or null |
| `ramp(from, to, n)` | `n` evenly mixed colours for a sequential scale. | Hex colours |
| `hex(color)` | Any CSS colour as hex. | `#rrggbb`, or null |

## Scales and numbers

| Helper | Use it for | Returns |
| --- | --- | --- |
| `niceScale(min, max, count)` | An axis with round tick values that covers the data. | `{ min, max, step, ticks }` |
| `niceStep(span, count)` | A round step for about `count` intervals over `span`. | Number |
| `linearMap(value, domain, range)` | Mapping a data value to px. | Number |
| `formatNumber(value, { style, decimals, currency, prefix, suffix }, fallbackDecimals)` | Writing values for labels, locale-independent (`,` thousands, `.` decimals). `style` is `'number'`, `'percent'` (0.25 → 25%), `'currency'` or `'compact'` (1.2K). | A string |

## The page

| Helper | Use it for | Returns |
| --- | --- | --- |
| `svg(tag, attrs, parent)` | Creating an SVG element with attributes and appending it to `parent`. `text` sets the text content. A null, undefined or false attribute is left out. | The element |
| `clear(el)` | Removing every child before a redraw. | The element |
| `onResize(el, draw)` | Calling `draw(width, height)` now and again whenever the element's size changes. Draw from the size you're given, never from a fixed size. | A function that stops it |
| `theme.mode()` | `'dark'` or `'light'`, as the host set it, otherwise from the system. | String |
| `theme.token(name, fallback)` | Reading a colour or size the host passed as a CSS custom property (e.g. `'--sui-ink'`). Always pass a fallback. | String |
| `theme.onChange(redraw)` | Redrawing when the host switches theme or the system scheme changes. | A function that stops it |
| `defineMotion(draw, { duration, name, autoplay })` | The page's motion. `draw(p)` must draw progress `p` (0–1) from `p` alone, and `p = 1` must be the finished picture. It sets `window.pageMotion` (`{ duration, seek(p), play(), stop(), progress, playing }`) for the host and draws the rest state at once. When you redraw (on resize or a theme change), call it again: it keeps the frame the host last showed, and carries on if it was playing. It never animates under reduced motion or while the page is hidden. Use `autoplay` only when the brief asks for it. | The motion |
| `ease.linear`, `ease.in`, `ease.out`, `ease.inOut` | Easing curves (0–1 → 0–1). | Number |
| `drawPieces(pieces, { total, at, span, ease })` | Drawing one line on from several paths (a thin lead-in then a thick span, or a strand's back and front runs) as one continuous stroke. Each piece is `{ from, to }` along the line, for example a run's `from` and `to` from `splitByDepth`. `ease` is a name such as `'ease-in-out'` or a function. In `draw(p)`, set each path's `stroke-dasharray` to `plan.drawAt(p)[i].dasharray` and hide it unless `.shown`. | `{ total, headAt(p), drawAt(p), windows }` |
| `phase(p, start, end, curve)` | Staggering pieces of one motion: a piece runs from `start` to `end` of the overall `p`. It is 0 before, 1 after and eased in between. | Number |
| `version` | The kit's version. | String |

## Linked focus

| Helper | Use it for | Returns |
| --- | --- | --- |
| `linkFocus({ marks, links, order, labels, dim })` | Hover and keyboard focus that light linked marks and dim the rest (items and their tags, many-to-many). Each mark has keys: `['item']`, `['tag']`, or `['item', 'tag']` for a link between them. `links` maps each item to its tags. A link lights only when both its ends are in focus. Call `focus(key)` on `pointerenter` and `focus`, and `clear()` on `pointerleave` and Escape. Pass key presses to `handleKey(event)` (arrows walk `order`, Home, End, Escape), and set each mark's opacity from `opacity()`. Put `describe()` in an `aria-live` element. | `{ focus, clear, handleKey, opacity, describe, related, getState, subscribe, order, dim }` |
| `linkFocusLit(marks, links, key)` | Which marks are lit for a key, without keeping state. | Booleans, in the marks' order |

## The page contract

- Put the picture in an element with `data-picture` (its canvas and SVG layers are captured together). Give each control `data-control` and an id. Put a plain-text description in an element with `data-about`.
- Draw from data and the size `onResize` gives you. Redraw on `theme.onChange`. Take colours from `theme.token(...)` with fallbacks that meet contrast in both modes.
- Motion goes through `defineMotion`, so the host can seek any frame. Don't start timers or animations of your own.
- To draw a line on, set `stroke-dasharray` to `` `${length * t} ${length}` ``. With round or square line caps, a zero-length dash still draws a dot, so hide the path (`visibility: hidden`) until `t > 0`.
- If the data is wrong, call `pixeratePage.error('what is wrong')`, if the host provides `pixeratePage`, rather than drawing a broken picture.

## Recipes

```js
// A fan of rounded connectors drawn on in order.
const root = { x: 200, y: 20 };
const targets = items.map((it, i) => ({ x: 40 + i * 60, y: 160 }));
const fan = kit.fanElbows(root, targets, { gap: 4 });
const paths = fan.elbows.map((e) => kit.svg('path', { d: e.d, fill: 'none', stroke: kit.theme.token('--sui-ink', '#333') }, layer));
kit.defineMotion((p) => {
  fan.elbows.forEach((e, i) => {
    const t = kit.phase(p, (i / fan.elbows.length) * 0.6, (i / fan.elbows.length) * 0.6 + 0.4);
    paths[i].setAttribute('stroke-dasharray', `${e.length * t} ${e.length}`);
    paths[i].setAttribute('visibility', t > 0 ? 'visible' : 'hidden');
  });
}, { duration: 1600 });
```

```js
// Two-strand braid with over/under.
const strands = [0, Math.PI].map((phase) => kit.helix([{ x: 20, y: 100 }, { x: 580, y: 100 }], { amplitude: 30, turns: 3, phase, envelope: 'start' }));
const runs = strands.flatMap((h, s) => kit.splitByDepth(h.points, h.depth).map((r) => ({ ...r, s })));
for (const r of runs.filter((r) => !r.front)) kit.svg('path', { d: r.d, fill: 'none', stroke: colors[r.s], 'stroke-width': 6 }, layer);
for (const r of runs.filter((r) => r.front)) kit.svg('path', { d: r.d, fill: 'none', stroke: colors[r.s], 'stroke-width': 6 }, layer);
```
