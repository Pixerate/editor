# Known Gotchas, Pitfalls & Solutions

This document tracks known issues, framework quirks, edge cases, and pitfalls encountered across `@pixerate/editor` packages, along with their solutions and workarounds.

All contributors and AI assistants should check this file before starting work and update it whenever discovering a new issue or solution.

---

## Template for New Entries

```markdown

### [Scope/Area] Brief description of the issue

- **Issue / Symptom**: What goes wrong or behaves unexpectedly.
- **Root Cause**: Why it happens (e.g. ProseMirror transaction lifecycle, Svelte reactivity timing, Tailwind reset conflicts, bundling issues).
- **Solution / Workaround**: How to resolve it or avoid it.
```

---

## Entries

### [react|svelte/chart] Inline SVG Colours Must Use `var(--x, fallback)`, Not shadcn's `hsl(var(--x))`

- **Issue / Symptom**: A chart theme written as `hsl(var(--foreground))` drew black text and invisible grid lines in the demo.
- **Root Cause**: The demo (and the other components' inline styles) define `--foreground`, `--border`, `--primary`, … as full colours (`rgb(...)`) plus `--x-rgb` channels for Tailwind. Only shadcn's own CSS stores bare HSL channels, so `hsl(var(--x))` is invalid everywhere else. SVG presentation attributes also don't reliably resolve `var()`.
- **Solution / Workaround**: `CSS_VARIABLE_CHART_THEME` uses `var(--foreground, #0f172a)`-style values (as `SpreadsheetEditor` does), and the canvases put colours in `style`, not `fill=` / `stroke=` attributes. The demo defines `--muted-foreground` for it.

### [svelte] `bind:clientWidth` Throws in jsdom Tests

- **Issue / Symptom**: Every Svelte test mounting `ChartCanvas` failed with `ReferenceError: ResizeObserver is not defined`.
- **Root Cause**: Svelte implements `bind:clientWidth` with `ResizeObserver`, which jsdom does not provide, and the binding runs even when the measured width is unused.
- **Solution / Workaround**: Observe the element in an `$effect` guarded by `typeof ResizeObserver === "undefined"` (as the React canvas does) and fall back to the `width` prop.

### [core/chart] `load()` Keeps the Undo Stack, So Undo Can Bring Back the Old Chart

- **Issue / Symptom**: In the demo, loading a sample chart and pressing Undo replaced the sample with the previous chart from before an earlier drag.
- **Root Cause**: Edits record before / after snapshots of the whole spec; `load` swaps the spec without an undo step, so the next undo applies an older snapshot.
- **Solution / Workaround**: Call `load(spec, { clearHistory: true })` when it replaces the whole document (opening a file, switching samples). Without `clearHistory`, use it only to refresh the chart with equivalent data.

### [core/vector] Merging Faces by a Boolean Union of Their Outlines Leaves Seams

- **Issue / Symptom**: Shape Builder merges built by uniting the faces' own outlines can leave a hairline gap or a spur along the edge two faces shared, and a merged shape whose faces only touched at a corner could come out with a sliver.
- **Root Cause**: Each face's outline is rebuilt separately (pieces joined back into exact sub-curves), so two faces' copies of a shared edge or corner are not guaranteed to be bit-identical; the union then sees two nearly coincident edges instead of one.
- **Solution / Workaround**: `PlanarMap.merge` traces the union along the map's own half-edges: an edge whose two sides are both merged faces is skipped, so shared edges drop out exactly (vectorcraft's `Map::merge`). Covering shapes that lose faces are rebuilt the same way from the faces they keep, never by subtracting the merged shape. Pathfinder operations use one arrangement for all results (`pathBooleanSelect`) for the same reason.

### [core/vector] Islands Must Be Nested per Face, Not by an Even-Odd Rule Over the Network

- **Issue / Symptom**: With three nested squares, a fill of the outer ring that takes every island inside its loop as a hole (as cadcraft's `islands` does) also cuts out the innermost square, a hole inside a hole; figcraft's `faces` notes the same weakness for crossing networks.
- **Root Cause**: Taking every group of curves inside the traced loop as a hole (cadcraft's `islands`) or classifying faces with an even-odd test over the whole network ignores which face an island actually sits in.
- **Solution / Workaround**: The face walk gives each connected piece's outer boundary (a clockwise cycle); `PlanarMap` makes it a hole only of the smallest face of *another* piece around it. `regionAt` traces the loop from the ray as cadcraft does, then takes that face's holes. Adjacency lives in per-vertex angle-sorted lists with half-edge slots, so a walk step is O(1) instead of figcraft's scans over all segments.

### [react|svelte] Binding Tests Use the Built Core: Rebuild It After Changing Core State

- **Issue / Symptom**: After adding a field to `VectorOverlayRenderData`, every React and Svelte vector test failed with `Cannot read properties of undefined (reading 'map')`, including tests that never touched the new feature.
- **Root Cause**: The bindings import `@pixerate/editor/vector`, which resolves to `packages/core/dist`; the canvases read the new field from a stale build that does not produce it.
- **Solution / Workaround**: Run `pnpm --filter @pixerate/editor build` (or `pnpm build`) before running binding tests after core changes.

### [core/vector] Unioning a Variable-Width Stroke Piece by Piece Is Quadratic

- **Issue / Symptom**: Building a tapered stroke as effectcraft does — a trapezoid per flattened segment plus a wedge per bend, unioned non-zero — took 86 s for a 120-wiggle pencil line, and the polygon boolean's winding pass alone was O(edges²).
- **Root Cause**: Every piece overlaps its neighbours, so the overlay sees thousands of crossings, and `buildOverlay` cast each edge's ray against every other edge.
- **Solution / Workaround**: `variableStrokeRings` emits the boundary the pieces add up to (winding numbers add, so the non-zero fill is identical): offset sides, the join on the outer side, and on the inner side the point where the two offsets cross (that corner is covered by both trapezoids) or, when they don't cross, a detour through the centre point. Never normalise the orientation of those rings (a closed path's inner ring must stay reversed). `polygonBoolean` now bands edges along the ray axis. Very wide strokes on tight zig-zags still self-overlap heavily (seconds for extreme cases); render data is cached per node object (`vectorStrokeSvgParts`) so it is only rebuilt when the node changes.

### [core/vector] A Pen Reports Zero Pressure on `pointerup`

- **Issue / Symptom**: Pencil strokes drawn with a pen always ended in a pinched tip.
- **Root Cause**: `PointerEvent.pressure` is 0 on `pointerup` (and for buttons released), and `pointerUp` replays the last position through `pointerMove`.
- **Solution / Workaround**: `pointerUp` drops `pressure` from the input it replays, and the pencil keeps the last pressure for points without one. A mouse reports 0.5 while a button is down, so recording is limited to `pointerType === 'pen'` unless `pencilPressure: 'all'`.

### [core/vector] Width Profiles Must Follow Path Reversal and Mirroring

- **Issue / Symptom**: After Reverse Path or a flip, a one-sided or tapered stroke moved to the other end or the other side.
- **Root Cause**: Profile positions are fractions along the path and sides are relative to its direction; reversing changes both, mirroring swaps left and right.
- **Solution / Workaround**: `reversePaths` applies `reverseWidthProfile` (t → 1 − t, sides swapped) and `bakeIntoGeometry` applies `mirrorWidthProfile` when the matrix has a negative determinant.

### [core/vector] Knife Cuts: a Thin Strip Leaves Slits, and Gap-Free Chords Need Care Around Holes

- **Issue / Symptom**: Cutting a shape by subtracting a thin stroke of the knife line (as vectorcraft does with a 0.05 pt strip) leaves the pieces apart by that width, visible at high zoom and wrong for exact geometry; cutting a ring once with exact chords produced a stray "hole" piece, and the next cut started at the previous cut's end point.
- **Root Cause**: Any strip has width. With exact chords instead, a chord from the outline into a hole does not separate anything — it merges the two loops — and after a split both new loops contain the chord, so the knife's own segments lie on the boundary and its exit point is found again as a crossing.
- **Solution / Workaround**: `knifePath` (`vector/pathCut.ts`) splits one loop per chord into two loops that share it, or joins an outline and a hole into one loop with a zero-width slit; faces are regrouped by loop orientation, and holes are placed by a sample point *off* the chord segments (chords lie on two loops). Crossings are recomputed per face after each cut, only beyond the knife position of the last cut (a cursor), and collinear overlaps are not crossings, so the chord the knife just made is never hit again.

### [core/vector] Deleting a Point: Passing Through It Is a Worse Fit Than the Least-Error Cubic

- **Issue / Symptom**: Healing a deleted point with a curve forced through it (figcraft's `heal_handles`) kept the point but bulged away from the old outline — on an S-curve the new curve strayed 30 units against 2.6 for a least-squares fit.
- **Root Cause**: Two cubics meeting at a point rarely equal one cubic through that point; forcing the pass-through spends the curve's two degrees of freedom on one point instead of the whole outline.
- **Solution / Workaround**: `removeAnchorKeepingShape` samples both old segments and fits one cubic with the neighbours' tangents, searching (golden section) for the parameter where it passes the joint. `removeRedundantPoints` uses the same search: plain chord-length parameters with Newton steps could not get under 0.05 units even for two exact halves of one cubic.

### [core/vector] Snap Guides at 90° Need Exact Axis Directions

- **Issue / Symptom**: A pen point placed straight below the previous one landed at `x = -6.1e-15` instead of `0`, failing exact comparisons and leaving near-zero noise in the saved document.
- **Root Cause**: Construction guides are built from `cos` / `sin` of their angle, and `Math.cos(Math.PI / 2)` is `6.1e-17`, not 0. Projecting onto that "vertical" direction moved the point off its anchor's x by the residue times the distance.
- **Solution / Workaround**: `construction` in `vector/snap.ts` rounds direction components below `1e-12` to exactly 0, and slides compute the coordinate of the line they land on directly (`x: l.v`) instead of `at + dir * s`. Do the same for any angle-derived direction that should be axis-aligned.

### [core/vector] Gather Snap Targets Before the Gesture Changes the Document

- **Issue / Symptom**: A shape being drawn snapped to its own growing bounds, and Alt-duplicating during a move snapped the copy to nothing where the originals stood (or to itself).
- **Root Cause**: Targets are gathered once per gesture from a document snapshot. The shape tool adds the new node on press, and Alt-drag swaps the drag's base document for one with duplicates, so targets taken from the wrong snapshot include (or exclude) the wrong nodes.
- **Solution / Workaround**: The shape tool gathers drawing targets *before* inserting its node and keeps them on the drag; a move drops its targets when it duplicates, so the next move gathers them again excluding the new selection (the originals become targets). The anchor drag excludes the moving anchors and the segments through them, and the handle drag excludes its path's bounds and segments, which move with the pointer.


### [core/vector] The "Nearest Rotation" of a Mirrored Matrix Is Undefined

- **Issue / Symptom**: Flipping a rotated vector shape made its selection box snap back to axis-aligned (the rotation was lost and everything was baked into the anchors).
- **Root Cause**: Node transforms are kept rigid by splitting a matrix into a rotation and a residual. The rotation came from `atan2(b − c, a + d)`, which is the closest rotation only for matrices with a positive determinant. For a mirrored matrix such as `R(30°)·diag(−1, 1)` both terms are 0, so the angle came out as 0.
- **Solution / Workaround**: `matrixRotation` uses `atan2(−b − c, d − a)` when `det < 0` (the rotation left after undoing a horizontal flip) and lets the residual carry the reflection. Shapes keep their angle through flips.

### [svelte] A Local Variable Named `state` Breaks `$state()` in the Same Component

- **Issue / Symptom**: `svelte-check` reports `Cannot use 'state' as a store. 'state' needs to be an object with a subscribe method on it` on a line like `let svg = $state();`, in a component that also has `const state = $derived(...)`.
- **Root Cause**: In Svelte, `$name` is store auto-subscription syntax. When a binding called `state` exists in the component's scope, the compiler reads `$state(...)` as "subscribe to the store `state`" instead of the `$state` rune.
- **Solution / Workaround**: Never name a component-level binding `state` (or `derived`, `effect`, `props`). The vector components call the controller snapshot `view` (`const view = $derived(store.current)`).

### [core/vector] Gestures Applied Live Must Still Report the Change When Committed

- **Issue / Symptom**: `VectorEditorController`'s `onChange` did not fire for programmatic edits (`addShape`, `align`, …) even though the document changed and undo worked.
- **Root Cause**: Edits (and drags) update `this.doc` first and are then recorded with `history.execute(command)`, whose `execute()` restores the "after" snapshot. Because that snapshot is already the current document, the restore saw no difference and skipped `onChange`.
- **Solution / Workaround**: `commit()` sets a `committing` flag around `history.execute` so `restore()` reports the document change once. Any controller that applies a change before recording it needs the same care.

### [react/svelte vector] Wheel Zoom Needs a Non-Passive Native Listener

- **Issue / Symptom**: Ctrl/Cmd+wheel over the vector canvas zoomed the whole browser page (or scrolled it) instead of the drawing, and `preventDefault()` logged "Unable to preventDefault inside passive event listener".
- **Root Cause**: React registers `onWheel` as a passive listener, and browsers treat wheel listeners on the document as passive by default, so they cannot cancel scrolling or pinch-zoom.
- **Solution / Workaround**: Attach the wheel handler in an effect with `element.addEventListener('wheel', handler, { passive: false })` (React `useEffect`, Svelte `$effect`) and call `preventDefault()` there.

### [canvas/freehand] Freehand Stroke Endcaps Stripped on Node Creation & Single-Point Dot Disappearance

- **Issue / Symptom**: When drawing freehand strokes with pen or highlighter tools on the canvas, endcaps appear rounded/square during live drag preview, but become square/flat or completely disappear (for single-point clicks/dots) after releasing the mouse pointer.
- **Root Cause**: `CanvasDrawLayer` was rendering the live `<path>` with `strokeLinecap={draw.activeStroke.style.cap ?? 'round'}`. However, `strokeToShapeNode` in `@pixerate/editor` was not copying `strokeLinecap` or `strokeLinejoin` into `node.data.shape`. Additionally, `ShapeNode.tsx` (React) and `ShapeNode.svelte` (Svelte) were not passing `strokeLinecap` or `strokeLinejoin` down to the rendered `<path>`. In SVG, zero-length or micro-length paths (`M x y L x+0.01 y`) used for dots require round or square linecaps to have visible area.
- **Solution / Workaround**:
  1. In `strokeToShapeNode`, forward `strokeLinecap: stroke.style.cap ?? 'round'` and `strokeLinejoin: stroke.style.join ?? 'round'`.
  2. In `ShapeNode` (React and Svelte), bind `strokeLinecap={render.strokeLinecap}` and `strokeLinejoin={render.strokeLinejoin}` (or `stroke-linecap` / `stroke-linejoin`).

### [canvas/gradients] SVG Linear and Radial Gradient Rendering in Shape Nodes and Live Drawing Layers

- **Issue / Symptom**: Setting `fill` or `stroke` to a gradient definition (linear or radial) renders black or transparent if directly assigned to `fill` or `stroke` attributes in SVG.
- **Root Cause**: Unlike HTML/CSS background values, SVG `<path>` and `<rect>` elements do not accept raw CSS gradient functions in `fill` or `stroke`. They require `<defs>` containing `<linearGradient id="...">` or `<radialGradient id="...">` and reference them via `url(#id)`.
- **Solution / Workaround**:
  1. Add gradient models (`CanvasLinearGradient`, `CanvasRadialGradient`, `CanvasGradientDef`), parser (`parseCssGradient`), and SVG descriptor generator (`gradientToSvgDef`) in `@pixerate/editor`.
  2. In `getShapeRenderData`, resolve gradient fills and strokes to deterministic def IDs (`shape-fill-${id}`, `shape-stroke-${id}`) and output `fillGradient` / `strokeGradient` defs.
  3. In `ShapeNode` (React and Svelte), render `<defs>` with `<linearGradient>` / `<radialGradient>` before rendering shape paths.
  4. In `CanvasDrawLayer` (React and Svelte), resolve the active live stroke gradient to an inline `<defs>` definition (`draw-active-stroke-gradient`) so user strokes render with gradients live during dragging.


### [svelte/canvas] Svelte 5 Runes and .svelte Imports in Vitest

- **Issue / Symptom**: Running Vitest fails with `ReferenceError: $state is not defined` when executing tests against `.svelte.ts` files, or throws `TypeError: Unknown file extension ".svelte"` when importing `@xyflow/svelte`.
- **Root Cause**: Svelte 5 runes (`$state.raw`, `$derived`, etc.) and `.svelte` component distributions require compile-time transformation via `@sveltejs/vite-plugin-svelte` and a DOM environment (`jsdom`). In a monorepo, if the root Vitest config does not specify workspace project delegation, individual package configs are ignored.
- **Solution / Workaround**:
  1. Add `packages/svelte/vitest.config.ts` with `plugins: [svelte()]` from `@sveltejs/vite-plugin-svelte` and `test: { environment: 'jsdom' }`.
  2. Add root `vitest.config.ts` with `test: { projects: ['packages/*', 'apps/*'] }` so monorepo `pnpm test` delegates to package-level Vitest configurations.

### [svelte/canvas] Decoupling SvelteFlow via Optional Peer Dependencies and Subpath Exports

- **Issue / Symptom**: Adding canvas features to `@pixerate/editor-svelte` could unnecessarily bloat bundle sizes or require `@xyflow/svelte` for consumers who only need rich-text / TipTap editors.
- **Root Cause**: Putting `@xyflow/svelte` as a hard dependency in `dependencies` forces every consumer of `@pixerate/editor-svelte` to download SvelteFlow and its transitive dependencies.
- **Solution / Workaround**:
  1. Expose canvas features under the subpath export `./canvas` (`@pixerate/editor-svelte/canvas`) rather than the root entry.
  2. Define `@xyflow/svelte` under `peerDependencies` with `peerDependenciesMeta: { "@xyflow/svelte": { "optional": true } }`.
  3. Because `@pixerate/editor-svelte` ships uncompiled sources via `svelte-package`, imports of `@xyflow/svelte` and `@dagrejs/dagre` are left as-is and resolved by the consumer's bundler; never import `@xyflow/svelte` from the root entry.

### [svelte/canvas] Zero-Duration Transitions and Division by Zero in Multi-Node Animation

- **Issue / Symptom**: Running transitions with `duration: 0` (e.g. for instantaneous layout updates or synchronous unit testing) sets node positions to `{ x: NaN, y: NaN }` and stalls completion.
- **Root Cause**: Computing progress via `elapsed / item.duration` produces `0 / 0 = NaN`. Furthermore, if `staggerDelay > 0` is applied when duration is 0, subsequent items calculate negative elapsed times and get deferred to `requestAnimationFrame`.
- **Solution / Workaround**: Guard `rawProgress` with `item.duration <= 0 ? 1 : Math.min(elapsed / item.duration, 1)` and force `effectiveStagger = duration === 0 ? 0 : staggerDelay`.

### [history/react] `useSyncExternalStore` Snapshot Referential Equality

- **Issue / Symptom**: React throws `Maximum update depth exceeded` and logs `The result of getSnapshot should be cached to avoid an infinite loop` when using `useHistory`.
- **Root Cause**: In React 18/19, `useSyncExternalStore` compares the snapshot returned by `getSnapshot()` using `Object.is(prev, next)`. If `manager.getState()` computes and returns a new object literal on every call, React considers the store continuously dirty and loops infinitely.
- **Solution / Workaround**: Cache the state object (`cachedState`) in `HistoryManager` and only allocate a new snapshot reference when a mutation actually occurs (inside `notify()` or upon `execute`, `undo`, `redo`, `clear`).

### [history/shortcuts] Native Text Inputs and ContentEditable Hijacking

- **Issue / Symptom**: Registering a global window listener for Undo/Redo (`Cmd+Z`, `Ctrl+Z`) breaks normal typing, backspacing, or rich-text editing inside `<input>`, `<textarea>`, or TipTap/ProseMirror `contenteditable` nodes.
- **Root Cause**: Keyboard events bubble up to the window object where a naive shortcut handler calls `event.preventDefault()` and invokes app-level history instead of letting the browser/editor perform native or ProseMirror undo.
- **Solution / Workaround**: Guard shortcut handlers by inspecting `event.target` and `document.activeElement`. If the element is an `<input>`, `<textarea>`, or has `isContentEditable` / `contenteditable="true"`, ignore the event and do not call `preventDefault()`.

### [core/mentions] Markdown Code-Block Immunity and URL Immunity in Mention Extraction & Preprocessing

- **Issue / Symptom**: Markdown or HTML content containing code samples, terminal output, stack traces, markdown links (`[package](https://npmjs.com/@scope/package)`), or raw URLs mistakenly formats `@handle` into interactive TipTap mention nodes (`<span data-type="mention">`), or triggers false-positive mention notifications.
- **Root Cause**: Naive regex matching for `@handle` triggers inside fenced code blocks (`` ``` `` or `~~~`), inline backticks, HTML `<pre>`/`<code>` blocks, markdown URL targets `](...)`, and URL path segments.
- **Solution / Workaround**: Use `stripMarkdownCode()` prior to extraction, and in `preprocessMarkdownMentions()`, split content using `MARKDOWN_MENTION_SPLIT_REGEX` so that code blocks, inline code, existing mention spans, and URLs remain completely untouched.

### [core/mention] TipTap Suggestion onKeyDown Command Inaccessibility

- **Issue / Symptom**: When implementing a custom keyboard handler (e.g. `Enter` or `Tab`) in a TipTap suggestion popover, calling `props.command(item)` inside `onKeyDown(props)` throws `TypeError: props.command is not a function`.
- **Root Cause**: In `@tiptap/suggestion`, `onKeyDown` receives `SuggestionKeyDownProps` which only contains the `view`, `event`, and `range`. The `command(attrs)` callback is only supplied on `SuggestionProps` passed to `onStart` and `onUpdate`.
- **Solution / Workaround**: Cache the latest `suggestionProps` during `onStart` and `onUpdate`, and invoke `cachedSuggestionProps.command(item)` when executing suggestion selection from a keyboard event.

### [react/testing] React 19 Testing without `@testing-library/react`

- **Issue / Symptom**: Attempting to import `renderHook` or `act` from `@testing-library/react` in package test suites fails with `Cannot find package '@testing-library/react'`.
- **Root Cause**: `@testing-library/react` is not an installed dependency in `@pixerate/editor-react` to keep the dependency footprint light.
- **Solution / Workaround**: Use `act` directly from `react` (`import React, { act } from 'react'`) and mount test components into a JSDOM container via `createRoot(container)` from `react-dom/client`, setting `(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true`.

### [core/canvas] Incremental Dagre Layout Centroid Blending & Unplaced Nodes

- **Issue / Symptom**: When running incremental layout `ensureLayout`, nodes initialized at `{ x: 0, y: 0 }` are erroneously treated as placed nodes and kept at `(0, 0)` rather than flowed into position relative to existing nodes.
- **Root Cause**: `storedPositions` mapped all node IDs including unplaced nodes initialized with default coordinates `(0, 0)`.
- **Solution / Workaround**: Filter `storedPositions` to only include nodes with non-zero coordinates (`x !== 0 || y !== 0`) or explicitly stored positions, allowing newly spawned nodes to calculate centroid translation offsets $\Delta x$ and $\Delta y$ seamlessly.

### [react/canvas] Synthetic vs Native ClipboardEvent Handling

- **Issue / Symptom**: Calling clipboard copy/paste handlers in React tests throws `TypeError: event.preventDefault is not a function` or fails to extract text/JSON from `clipboardData`.
- **Root Cause**: In React 19 / JSDOM environments, `event` passed to clipboard handlers may either be a synthetic `React.ClipboardEvent` or a native `ClipboardEvent`.
- **Solution / Workaround**: Extract the native event via `const native = (event && 'nativeEvent' in event) ? (event as any).nativeEvent : event;` and guard `(event as any)?.preventDefault?.(); (native as any)?.preventDefault?.();`.

### [core/agent] Ephemeral Presence Artifacts in Multimodal Snapshots & Background Tab Throttling

- **Issue / Symptom**: Multimodal LLM agents executing visual snapshot tools (`view_editor`) inspect their own cursor trails and speech tags in a feedback loop, or frame animations freeze when the browser tab is hidden/backgrounded.
- **Root Cause**:
  1. Ephemeral cursor tags and narration bubbles rendered in the DOM are captured in canvas exports unless explicitly filtered out before rasterization.
  2. Browsers throttle or suspend `requestAnimationFrame` when `document.hidden` is true (background tabs, headless CI runners).
- **Solution / Workaround**:
  1. Add `EXPORT_EXCLUDED_SELECTORS` (`.pixerate-presence`, `.agent-presence`) to canvas export pipelines to strip presence DOM nodes before capturing images.
  2. Implement `Clock` with `pageHidden()` fallback to `setTimeout`, and provide `ManualClock` for step-by-step deterministic advancement in test suites and video capture runners.

### [core/tsup] TypeScript Union Distribution with `Omit<Union, Key>`

- **Issue / Symptom**: During `tsup` DTS type declaration generation, passing discriminated union objects (such as `Annotation` variants) to a function typed with `Omit<Annotation, 'id'>` throws `TS2353: Object literal may only specify known properties, and 'points' does not exist in type 'Omit<Annotation, "id">'`.
- **Root Cause**: In TypeScript, the standard `Omit<T, K>` utility is not distributive over unions (`T = A | B`). `Omit<A | B, 'id'>` evaluates to `{ [k in (keyof A & keyof B)]: ... }`, discarding member-specific properties such as `points` on `PenAnnotation` or `radiusX` on `CircleAnnotation`.
- **Solution / Workaround**: Define an explicit distributive union type (e.g. `export type CreateAnnotationPayload = Omit<PenAnnotation, 'id'> | Omit<RectAnnotation, 'id'> | ...`) or a distributive utility `type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never`.

### [image-editor/dom] Canvas Viewport Layout Feedback Loop Causing Zoom Drift on Every Action

- **Issue / Symptom**: In the image editor demo, performing any action (slider adjustment, rotate, annotation, crop preset, undo) caused the image to repeatedly zoom in.
- **Root Cause**:
  1. The `<canvas>` element was placed in normal document flow (`position: static`/`relative`) inside a flex container that had padding and no rigid height constraint (`min-h-[480px]`).
  2. On each action, the canvas resolution was updated to `canvas.width = container.clientWidth` and `canvas.height = container.clientHeight`. Because the canvas possessed intrinsic dimensions and the container had padding, the parent container expanded.
  3. On the subsequent action, `container.clientHeight` was measured larger, which increased `fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1)`, rendering the image larger and causing the parent container to expand further on every interaction.
  4. Additionally, when rotating 90° or 270°, the renderer did not transpose base dimensions `(cropW, cropH)` to `(cropH, cropW)`, clipping rotated images and distorting `fitScale`.
- **Solution / Workaround**:
  1. Position the canvas with `className="absolute inset-0 w-full h-full block cursor-crosshair"` within a `relative flex-1 h-full min-h-0 overflow-hidden` container. Absolute positioning removes the canvas from document flow, making it physically impossible for canvas pixel dimensions to alter or expand the parent container.
  2. Enforce explicit layout height on the editor outer frame (`h-[540px]`).

### [tailwind/monorepo] Missing Workspace Packages in Tailwind `content` Causes CSS Layout Collapse

- **Issue / Symptom**: In the demo app, the image editor canvas was centered floating over the sidebar controls, the sidebar took up 100% width below the canvas, and aspect ratio preset buttons stacked in single full-width vertical rows rather than a 3-column grid.
- **Root Cause**: `apps/demo/tailwind.config.js` only included `"./src/**/*.{js,ts,jsx,tsx}"` in its `content` array. Because `@pixerate/editor-react` and `@pixerate/editor-svelte` use Tailwind utility classes (e.g. `md:flex-row`, `md:w-80`, `grid-cols-3`, `h-[540px]`), Vite's Tailwind compiler purged all classes that were not also present in `apps/demo/src`. Without `md:flex-row` and `md:w-80`, the container stayed `flex-col`, the sidebar expanded to 100% width, and without `grid-cols-3`, the presets collapsed into a single column.
- **Solution / Workaround**:
  1. Add `"../../packages/*/src/**/*.{js,ts,jsx,tsx,svelte}"` to the `content` array in `apps/demo/tailwind.config.js`.
  2. Implement responsive heights (`h-[360px] md:h-full min-h-[320px]`) in [`ImageEditor.tsx`](file:///Users/jack/Development/editor/packages/react/src/image-editor/ImageEditor.tsx) and [`ImageEditor.svelte`](file:///Users/jack/Development/editor/packages/svelte/src/image-editor/ImageEditor.svelte) so viewport containers have a well-defined fallback layout even in single-column / mobile contexts.

### [image-editor] Crop Overlay Disappearing Outside of Drag Operations

- **Issue / Symptom**: The interactive crop rectangle, rule-of-thirds grid, and resize handles were only visible on the canvas while actively dragging a handle. When the user was not dragging (idle hover or initial tab selection), the crop overlay was completely invisible.
- **Root Cause**:
  1. The renderer condition evaluated `options.draftCrop !== undefined ? options.draftCrop : crop`. When idle, `draftCrop` was passed as `null` (since no draft drag was active). In JavaScript, `null !== undefined` is `true`, causing `activeCrop` to evaluate to `null` instead of falling back to the committed `state.crop`.
  2. Initially or upon reset, `state.crop` is `null`. Without a fallback to full natural image dimensions `{ x: 0, y: 0, width: naturalWidth, height: naturalHeight }`, no bounding box existed to render handles or hit-test against.
  3. The renderer also required `state.activeTool === 'crop'`. On initial component mount, `activeTab` defaulted to `'crop'` but `state.activeTool` was `'select'`, causing `isActivelyCropping` to evaluate to `false` and hiding the overlay until the user manually clicked the tab button.
- **Solution / Workaround**:
  1. In `renderer.ts`, determine active crop as `(options.draftCrop !== undefined && options.draftCrop !== null) ? options.draftCrop : (crop ?? (isCroppingActive ? { x: 0, y: 0, width: naturalWidth, height: naturalHeight } : null))`.
  2. In `geometry.ts`, resolve `cropOverride` similarly so `getViewportMetrics` generates a valid `cropRect` and handles can be hit-tested even before the first crop operation.
  3. In React and Svelte 5 components, synchronize `editor.setTool('crop')` with `activeTab` on mount, and provide full-image dimension fallbacks during hover cursor hit testing.

### [core/grammar] `String.prototype.replace` Interprets `$` Patterns in Replacement Strings

- **Issue / Symptom**: A template body containing `$&` (e.g. a price like `"costs $&"`) made `resolveTemplates` hang forever; bodies containing `` $` `` or `$'` produced garbled output such as `"A [A ] B"`.
- **Root Cause**: `result.replace(fullMatch, resolvedBody)` treats `$&`, `` $` ``, `$'`, `$$` and `$1` in the *replacement string* as special patterns. `$&` re-inserted the `{{tag}}` itself, and the resolver rescanned from index 0, so it looped.
- **Solution / Workaround**: Never pass user-controlled text as a string replacement. Use a function replacer (`text.replace(regex, () => body)`) or build the result by slicing at `match.index`. The resolver now uses a single-pass function replacer and recurses into each body, so no rescan is needed.

### [core/serializers] TipTap Nests Paragraphs Inside List Items, and Live-Document `innerHTML` Runs Handlers

- **Issue / Symptom**: `htmlToPlainText` returned `"one\none\ntwo\ntwo"` for a two-item list and silently dropped `<pre>` code blocks. Separately, extracting text from untrusted HTML could fire `<img onerror>` handlers.
- **Root Cause**: TipTap serializes list items as `<li><p>…</p></li>`. Collecting the `textContent` of every element matching `p, li, …` counts each item twice, and anything outside that selector list is lost. Assigning `innerHTML` on an element created by the live `document` starts loading resources (and running inline event handlers) even when the element is never attached.
- **Solution / Workaround**: Walk the DOM and emit one line per *innermost* block element, treating `<br>` as a newline. Parse untrusted HTML into a `<template>` element's `.content` (or `DOMParser`), which is inert. To insert literal text into TipTap, never pass a string to `insertContent` (it is parsed as HTML); use `tr.insertText` for single lines, or `tr.replace(from, to, Slice.maxOpen(paragraphs))` so newlines split paragraphs like the paste handler does.

### [core/markdown] Markdown Content Legitimately Contains HTML, So `html: false` Is Not an Option

- **Issue / Symptom**: `markdownToTipTapHtml` passed raw HTML (`<img onerror>`, `javascript:` links) straight through, which is an XSS risk when rendering LLM or user-supplied markdown. Turning off markdown-it's `html` option breaks mention round-trips and file-link preprocessing.
- **Root Cause**: `tiptap-markdown` serializes mention nodes as raw `<span data-type="mention">` HTML, and `preprocessMarkdownFileLinks` / `preprocessMarkdownMentions` inject HTML into the markdown before rendering. `markdown-it-task-lists` also emits its checkboxes as `html_inline` tokens.
- **Solution / Workaround**: Keep `html: true` but override markdown-it's `html_inline` and `html_block` renderer rules to run an allowlist sanitizer (tags, attributes, `data-*`, checkbox-only `<input>`, and `md.validateLink` on entity-decoded, control-character-stripped `href`/`src`). Escape every value interpolated into preprocessor HTML. `allowUnsafeHtml: true` (passed via the render `env`) opts out for trusted input.

### [svelte/packaging] Precompiled Svelte Components Break SSR, Styles and Version Compatibility

- **Issue / Symptom**: With the old `tsup` + `esbuild-svelte` build, rendering any component in SvelteKit SSR threw `document is not defined`; component `<style>` blocks (editor placeholder, spreadsheet resize handle) never reached consumers; and the hand-written `index.d.ts` files referenced unimported types and had drifted from the real exports.
- **Root Cause**: `esbuild-svelte` compiles components once, in client mode, importing private `svelte/internal/client` APIs that are not semver-stable. Scoped CSS was emitted to `dist/index.css`, which nothing imported and the `exports` map did not expose. `dts: false` meant types were maintained by hand.
- **Solution / Workaround**: Build with `svelte-package -i src -o dist` (`@sveltejs/package` v2; v3 requires TypeScript 6). It ships `.svelte` sources (compiled by the consumer for client *and* server, with styles intact) and generates `.d.ts` files with `svelte2tsx`. Requirements this imposes:
  1. Relative imports in `.ts` files must use the emitted extension: `./editor.svelte.js` for rune modules (`editor.svelte.ts`), `./history/index.js` for folders. Component imports keep `.svelte`.
  2. Keep tests out of `src/` (they live in `packages/svelte/tests/`), otherwise they are packaged.
  3. Type-check with `svelte-check`, not `tsc` (`tsc` cannot see `.svelte` files without an ambient shim, and a shim would hide real prop types).
  4. `tests/ssr.test.ts` renders components with `svelte/server` in a Node environment to guard against regressions.

### [core/tsup] `splitting: false` Duplicates Shared Modules Across Subpath Entries

- **Issue / Symptom**: Importing both `@pixerate/editor` and `@pixerate/editor/image-editor` (or any two subpaths) loaded two copies of shared modules: two `globalImageCache` instances, and `instanceof` checks failing across entries. The root entry also pulled in `@dagrejs/dagre` and the image renderer for consumers who only wanted the prompt editor.
- **Root Cause**: With `splitting: false`, tsup bundles every entry point independently, inlining all of its imports. The root barrel re-exported every module, including canvas, agent and image-editor.
- **Solution / Workaround**: Build with `splitting: true` so shared code lands in common chunks, and keep heavy or environment-specific modules (canvas, agent, image-editor) subpath-only. Framework packages must import them from the subpath (`@pixerate/editor/image-editor`), not the root.

### [monorepo/deps] TipTap Must Be a Peer Dependency to Avoid Duplicate ProseMirror Instances

- **Issue / Symptom**: Consumers could end up with two copies of `@tiptap/core` / `@tiptap/pm` (e.g. a v3 `@tiptap/react` from the app alongside core's v2), producing errors such as `Adding different instances of a keyed plugin`, `RangeError: Can not convert <> to a Fragment`, failed `instanceof` checks, or core extensions silently not applying.
- **Root Cause**: ProseMirror relies on module identity (plugin keys, `Node`/`Schema` classes). Listing `@tiptap/core` and `@tiptap/pm` under `dependencies` lets the package manager install a private copy per package when ranges differ; `@pixerate/editor-react` also advertised `^2 || ^3` while core only supported v2.
- **Solution / Workaround**: Declare `@tiptap/core`, `@tiptap/pm` (and `@tiptap/react` for React) as `peerDependencies` with one shared range, mirrored in `devDependencies` for local builds. Extension packages (`@tiptap/extension-*`, `@tiptap/starter-kit`, `@tiptap/suggestion`) can stay regular dependencies because they themselves peer-depend on `@tiptap/core`/`@tiptap/pm`. Only widen the range to a new TipTap major once it is installed and tested in CI. The demo app lists the peers explicitly.

### [react/tiptap] `useEditor` Dependency Arrays Destroy the Editor (and Loop on Inline Objects)

- **Issue / Symptom**: `usePromptEditor({ templateColorMap: new Map(...) })` threw "Maximum update depth exceeded"; toggling `isEditing` or changing `placeholder` lost undo history, focus and the caret.
- **Root Cause**: `@tiptap/react`'s `useEditor(options, deps)` destroys and recreates the editor whenever a dependency changes by identity. An inline `Map` is a new object every render, so each render created an editor, which triggered a re-render, which created another. Options such as `editable` were also listed as deps even though they can be applied to the live instance.
- **Solution / Workaround**: Only list options that are baked into extension configuration, and key object-valued options by value (e.g. `JSON.stringify(Array.from(map.entries()))`). Apply everything else in effects on the live editor: `editor.setEditable()`, `editor.setOptions({ editorProps })` for attributes, mutate `extension.options` and dispatch an empty transaction to refresh decorations (placeholder), and `setContent(…, false)` only when the incoming value differs from the editor's current text, so echoes of `onContentChange` never reset the caret.

### [svelte/testing] `mount()` Fails with `lifecycle_function_unavailable` in Vitest

- **Issue / Symptom**: Mounting a component with `mount()` from `svelte` in a jsdom test throws `Svelte error: lifecycle_function_unavailable` from `svelte/internal/server`.
- **Root Cause**: Vitest resolves package exports with Node conditions, so `svelte` resolves to its server runtime even in the jsdom environment.
- **Solution / Workaround**: Set `resolve: { conditions: ['browser'] }` in `packages/svelte/vitest.config.ts` (guarded by `process.env.VITEST`). Tests annotated with `// @vitest-environment node` (e.g. `tests/ssr.test.ts`) still use the server build.

### [core/spreadsheet] Recalculation Must Be Topological, and Structural Edits Must Rewrite References

- **Issue / Symptom**: Formulas computed from cells evaluated later showed 0 (`A1` = `=A2*2` loaded before `A2`); cycle markers vanished or turned into `NaN` after an insert or undo; inserting a row made formulas point at the wrong cells; column formulas using `[property]` showed the same value in every row.
- **Root Cause**: `recalculateAll` evaluated row by row and never cleared the dependency graph; cycle detection only flagged the edited cell; references are stored as A1 text, so moving cells without rewriting formulas changes what they point at; `[property]` resolved against the *selected* row.
- **Solution / Workaround**: `DependencyGraph.getEvaluationPlan()` runs an iterative Tarjan SCC pass (no recursion, so long chains don't overflow) that returns cells dependencies-first plus every member of a cycle. `recalculateAll` rebuilds the graph and follows the plan. Row/column insert/delete calls `shiftFormulaReferences()` on every formula *before* mutating the grid; growing the grid during a paste is not an insertion and must not shift references. Ranges (including whole columns `A:A`) are stored whole in an interval index, never as one key per cell (see the large-sheet entry below). The controller sets the evaluating row while evaluating so `[property]` is per-row. In formula code, never use `Math.max(...values)` or `push(...values)` on range values: large ranges overflow the stack.


### [core/canvas] Streaming Layout: Debounce Starves Layouts, and Current Positions Are Not Layout Targets

- **Issue / Symptom**: During an LLM stream, `StreamingLayoutManager` ran no layouts until the stream went quiet (updates every 20ms with `throttleMs: 50` resulted in zero layouts over 500ms). When a layout did run, nodes never glided; they stayed where they were.
- **Root Cause**: `pushStreamUpdate` cleared and re-armed a single timeout on every call. That is a *debounce*: the timer only fires after `throttleMs` of silence. Separately, the caller's `currentPositions` were passed to `ensureLayout` as `storedPositions`, which pins every known node to its current spot. So each target equalled the current position and no transition was created.
- **Solution / Workaround**: Use a real throttle. Lay out immediately on the leading edge and open a window. Inside the window, keep only the latest args, then run them on the trailing edge and re-open the window. Treat `currentPositions` only as the glide *origin*. Compute targets from the graph plus explicitly pinned `layoutOptions.storedPositions`. When re-targeting mid-glide, start from the in-flight animated positions so nodes don't jump. Test with `vi.useFakeTimers()` for the throttle and a `ManualClock` for the glide. Don't mix them: `ManualClock.advance` awaits a real `setTimeout(0)` and hangs under fake timers.

### [core/canvas] Node `style` Can Be a String (SvelteFlow) or an Object (React Flow)

- **Issue / Symptom**: `runMultiNodeTransition` with a fan-out trajectory threw `style.replace is not a function` for React Flow nodes. It also overwrote the caller's node objects, which breaks React's immutable state expectations.
- **Root Cause**: The opacity logic assumed CSS-string styles (`"opacity: 0.5;"`), which is SvelteFlow's convention. React Flow / xyflow uses `CSSProperties` objects. The runner also mutated `node.position`, `node.data` and `node.style` in place.
- **Solution / Workaround**: Use `withStyleOpacity(style, opacity, emptyFormat)`. It returns `{ ...style, opacity }` for objects, rewrites the `opacity` declaration for strings, and builds a new style in the requested format when `style` is empty. React passes `styleFormat: 'object'`. Transitions now emit updated **copies** through `onUpdate(nodes)` / `onComplete(nodes)`. Merge them into state by `id` instead of reading the input nodes.

### [core/history] Exceptions Inside `batch` / `undo` / `redo` Corrupt the Stacks

- **Issue / Symptom**: If a `batch` callback threw halfway, a partial compound entry was still pushed and could be undone. If a command's `undo` threw, the command disappeared from both stacks.
- **Root Cause**: `batch` pushed the collected commands in a `finally` block. `undo`/`redo` popped the command *before* calling its closure.
- **Solution / Workaround**: In `batch`, catch the error, undo the already-executed batch commands in reverse with `isApplying = true` so the undos are not recorded, push nothing, and rethrow. In `undo`/`redo`, peek at the top command, run its closure, and pop/push only after it succeeds.

### [core/agent] Planner Must Accept the MCP Tool Schema's Vocabulary

- **Issue / Symptom**: An agent calling `edit_canvas` with `side: 'top'` got the node placed *below* the anchor. `layout` without `incremental` discarded manual positions even though the schema says `incremental` defaults to `true`.
- **Root Cause**: The tool schema (`top | right | bottom | left`, `incremental` default true) and the planner/`placeBeside` vocabulary (`right | below | left | above`, falsy default) drifted apart. Unknown sides fell through to `placeBeside`'s `default: below` branch.
- **Solution / Workaround**: Normalize sides with `normalizeSide()` and use `command.incremental ?? true`. When changing `tools.ts`, update the planner and its tests in the same change. Validate `nearNodeId` against the snapshot before anchoring or adding an edge.


### [core/image-editor] One Canonical Coordinate Space for Crop, Annotations and Masks

- **Issue / Symptom**: At 90°/270° the crop overlay was drawn with the wrong size (the left half of an 800×600 image showed as 300×800 instead of 600×400). Crop drags went the wrong way on flipped images. The depth mask ignored rotate/flip. Inpainting masks were misaligned with the image. Undo after an AI edit could not restore the image.
- **Root Cause**: Every code path invented its own mapping. The crop box was stored in natural pixels but divided by unswapped width/height on a swapped base. `canvasToImagePoint` ignored rotation, flips and the crop offset. Annotations were stored in post-crop/post-rotate display space but rendered onto natural-size mask canvases. History snapshots left out the source image.
- **Solution / Workaround**:
  1. The crop box and **all** annotations are stored in natural pixels of the current source image. Rotation, flips, crop, fit, zoom and pan are view transforms only.
  2. `geometry.ts` owns the only mapping: `target = origin + scale · R(angle) · F(flipH, flipV) · (p − regionCenter)`, exposed as `projectImagePoint` / `unprojectCanvasPoint` (exact inverse) and `applyImageProjectionToContext` (the same transform for a 2D context). The renderer (viewport, base image, depth mask, annotations, export), `getViewportMetrics`, `hitTestCrop` and `canvas↔image` conversion all build on it. Never hand-roll `translate/rotate/scale` sequences or `x / naturalWidth * renderW` maths in new code.
  3. `hitTestCrop` returns image-space handles because that is what `calculateCropDrag` needs. Map them back with `getCropCursor(handle, transform)`. An on-screen aspect ratio is inverted in image space under a quarter turn.
  4. Annotations follow the image content: rotating or flipping the image rotates or mirrors existing annotations, text included, and they are clipped to the visible region.
  5. AI hooks get `toSourceDataURL()` (natural size, untransformed) together with `toMaskDataURL()` (same space), and the result replaces the source. History entries store the source URL, element and dimensions next to the serialized edits, so `applyInpaintedImage` / `applyBackgroundRemovedImage` are single undoable steps.
  6. Exact quarter-turn `cos`/`sin` values keep round trips free of float error. Any value that changes the base render, such as `depthMask.maskSource` or the source element, must be part of the renderer's cache key.

### [core/canvas] Layer Order: xyflow Stacks by `zIndex`, Then Array Order, and Parents Must Come First

- **Issue / Symptom**: "Bring to Front" implemented by moving a node to the end of the `nodes` array had no effect when other nodes had a `zIndex`, and moving a parent group after its children broke the sub-flow.
- **Root Cause**: SvelteFlow and React Flow render nodes with CSS `z-index` from `node.zIndex` (missing = 0, plus 1000 for selected nodes when `elevateNodesOnSelect` is on) and only fall back to array order for ties. xyflow also requires a parent to appear before its children in the array.
- **Solution / Workaround**: `reorderNodes` computes the effective order (`zIndex`, then array index) per sibling group (same `parentId`), applies the operation and returns `zIndex` rank updates. It never reorders the array. Nodes whose effective `zIndex` already equals their rank are left untouched, and a no-op operation returns no updates.

### [core/canvas] Option/Alt Shortcuts Must Match `KeyboardEvent.code`, Not `key`

- **Issue / Symptom**: Align shortcuts such as `Alt+A` never fired on macOS, and `Mod+Alt+]` (bring to front) did not match.
- **Root Cause**: On macOS, Option changes the produced character (`Alt+A` gives `key === 'å'`, `Alt+]` gives `'‘'`). Keyboard layouts also move `[`/`]`.
- **Solution / Workaround**: `matchArrangeShortcut` matches bindings by `event.code` (`KeyA`, `BracketRight`) and only derives a code from `key` when `code` is empty (synthetic events). It still bails out early through `isEventFromTextInput` so the shortcuts never hijack typing.

### [svelte/canvas] SvelteFlow `Node` Is Not Assignable to Core `CanvasNode`

- **Issue / Symptom**: `svelte-check` fails with `Types of property 'class' are incompatible` when a Svelte rune passes SvelteFlow nodes into a generic core helper such as `createCanvasArrangeController<TNode>`.
- **Root Cause**: Core's structural `CanvasNode` declares `class?: string`. SvelteFlow's `Node` declares `class?: ClassValue` (strings, arrays or objects).
- **Solution / Workaround**: Keep the public Svelte API typed with the Svelte `CanvasNode` from `./types.js` and call the core controller with a loose type parameter (`createCanvasArrangeController<any>`). The core helpers only read `id`, `position`, sizes, `style`, `parentId`, `zIndex`, `data` and the interaction flags.

### [canvas] Smart-Guide Snapping Hooks Differ Between SvelteFlow and React Flow

- **Issue / Symptom**: One snapping integration does not fit both libraries. In React Flow, a position rewritten in `onNodeDrag` is overwritten by the next `onNodesChange` batch, so the node does not stay snapped.
- **Root Cause**: React Flow is controlled through `onNodesChange`, so a position must be snapped *before* `applyNodeChanges` runs. SvelteFlow binds `nodes` and calls `onnodedrag` after it has written the dragged position. Both compute each drag frame from the pointer and the drag-start position, not from the previous frame, so writing a snapped position does not accumulate offsets.
- **Solution / Workaround**: React: `onNodesChange={(c) => setNodes((n) => applyNodeChanges(arrange.snapPositionChanges(c), n))}`. A batch with `dragging: false` ends the drag and clears the guides. Svelte: `onnodedragstart={() => arrange.beginDrag()}`, `onnodedrag={({ nodes }) => arrange.drag(nodes.map((n) => n.id))}`, `onnodedragstop={() => arrange.endDrag()}`. Snap targets are indexed once per drag (`createNodeGuideIndex`) and each frame is a binary search, so dragging stays fast with hundreds of nodes.


### [core/grammar] Escapes in `VARIABLE_REGEX` Can Backtrack Catastrophically, and Sections Are Scoped Per Body

- **Issue / Symptom**: A first attempt at allowing `\}` / `\|` inside `{name|default}` with `(?:\\.|[^{}])+` froze the tab on input such as `{` followed by thousands of backslashes and no closing brace. Separately, a `{?x}` opened inside a template body and closed in the prompt (or the other way round) behaved unpredictably once templates were expanded.
- **Root Cause**: In `(?:\\.|[^{}])+` a backslash can match either branch, so each run of backslashes can be split many ways, and a failing match tries all of them (exponential). Sections that cross template boundaries depend on expansion order, and a removed section would have to be known before its templates are expanded.
- **Solution / Workaround**: Keep the alternatives disjoint: `(?:\\[\s\S]|[^{}\\])*\\?` (a backslash is only ever an escape, except one trailing backslash, which keeps the old `{a\}` match). `tests/grammar.test.ts` has a timing guard. The resolver tokenizes each template body on its own: sections must open and close in the same body, unbalanced tags stay literal and are reported as diagnostics with `templateName`, and templates inside removed sections are never expanded. Unbalanced tags must never throw. Pair them with `matchConditionalTags()` (used by the tokenizer and by `GradientText`, which pairs across the whole document because sections may span paragraphs).

### [react/testing] Text Inputs Never Fire `onChange` When JSDOM Is Installed After `react-dom` Loads

- **Issue / Symptom**: In a React test that creates a `JSDOM` in `beforeAll` (see "React 19 Testing without `@testing-library/react`"), typing into an `<input>` (native value setter plus an `input` event) never called `onChange`. Checkbox `click()`s did work.
- **Root Cause**: `react-dom` checks once, at import time, whether the DOM exists and supports the `input` event. ES imports are hoisted above `beforeAll`, so the check runs with no `window`, and React falls back to key/selection-based change detection that synthetic `input` events never trigger.
- **Solution / Workaround**: For tests that type into inputs, put `// @vitest-environment jsdom` at the top of the file instead of creating a `JSDOM` manually, so the DOM exists before `react-dom` is imported (see `packages/react/tests/variables.test.tsx`). Then set the value with `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v)` and dispatch `new Event("input", { bubbles: true })` inside `act`.

### [core/track-changes] Tracking Must Rewrite Transactions in `appendTransaction`, Not at the Input Layer

- **Issue / Symptom**: Intercepting keys (`handleKeyDown`, `handleTextInput`) to implement suggestion mode misses most edits: browsers delete single characters natively (ProseMirror reads the DOM change, so `editor.commands.keyboardShortcut("Backspace")` does nothing in jsdom), and cut, drag-and-drop, input rules and IME all bypass key handlers. Naive tracking also broke paragraph joins, re-tracked undo/redo, turned `setContent` into one giant deletion, and parsed `<del data-change-type="deletion">` as a Strike mark.
- **Root Cause**: Only the transaction stream sees every edit. `<del>` is also claimed by StarterKit's Strike `parseHTML` at the default priority. Undo/redo (`history$` meta), remote collaboration (`y-sync$`) and other plugins' appended transactions are replays or housekeeping, not user edits.
- **Solution / Workaround**: `TrackChanges` uses `appendTransaction`. For each `ReplaceStep` it marks the inserted range and re-inserts `tr.docs[i].slice(from, to)` at `rest.map(from, -1)` with the deletion mark (dropping text the same author inserted). Slices with no inline content (paragraph splits/joins) are left alone, as is content whose parent disallows marks (code blocks). It skips transactions with `history$`, `y-sync$`, `appendedTransaction` or `TRACK_CHANGES_SKIP_META` meta. While `view.composing` is true it buffers transactions and tracks them after `compositionend`, since rewriting the DOM around an active composition breaks IMEs. The appended transaction is merged into the same undo event by prosemirror-history. Parse rules use `priority: 100`. In tests, simulate Backspace with `editor.view.dispatch(state.tr.delete(from - 1, from))`.

### [core/comments] Comment Store Updates Must Not Dispatch Synchronously Inside Commands

- **Issue / Symptom**: Redrawing comment decorations by dispatching a transaction from the `CommentStore` listener can throw `Applying a mismatched transaction` or recurse when the store changes inside a command or a plugin view `update()`.
- **Root Cause**: Commands mutate the store before their own transaction is dispatched, and `syncAnchors` runs inside the plugin view update, so a synchronous dispatch from the listener interleaves with an in-flight transaction.
- **Solution / Workaround**: Commands set a refresh meta on their own `tr`, and `decorations(state)` reads the store snapshot (cached per doc + snapshot). External store changes (UI, `load()`) schedule one refresh with `queueMicrotask`, which is skipped when the decorations already reflect the snapshot. Deleted threads are kept off-snapshot so undoing "Delete Comment" can restore them when the mark reappears.

### [core/import] `plainTextToTipTapHtml` Passes `<p>…</p>` Text Through as HTML

- **Issue / Symptom**: Importing a `.txt` file whose content is `<p><img src=x onerror=…></p>` would insert live HTML instead of literal text.
- **Root Cause**: `plainTextToTipTapHtml` treats input that already looks like paragraph HTML as HTML (so it can round-trip TipTap output) and returns it unchanged.
- **Solution / Workaround**: For untrusted text (imported files, extracted RTF text) use `plainTextToParagraphHtml`, which always escapes. Import HTML with `sanitizeImportedHtml`, which drops `<script>`/`<style>`/`<head>` with their content, strips namespaced tags such as Word's `<o:p>`, and applies the markdown allowlist in `disallowedTags: "strip"` mode.

### [core/import] Parsed HTML Slices Are Open, and Drop Positions Can Fall Between Blocks

- **Issue / Symptom**: Dropping a file with `## Heading` into `<p>x</p>` produced `<h2>Headingx</h2>`. Dropping text into a prompt editor added an empty trailing paragraph.
- **Root Cause**: `DOMParser.parseSlice` returns a slice opened as far as possible, so its first/last blocks merge into the surrounding paragraph. `view.posAtCoords` often returns a position *between* blocks (e.g. `0`); inserting an open text slice there creates a new paragraph.
- **Solution / Workaround**: For imported HTML build a closed slice (`new Slice(parser.parse(body).content, 0, 0)`) and insert it with `tr.replaceRange`. For plain text, move the position into the nearest textblock with `Selection.near(doc.resolve(pos))` and use `tr.replace` with `plainTextToSlice`.

### [core/clipboard] ProseMirror's Copy Handler Clears Extra Clipboard Types

- **Issue / Symptom**: Writing a custom MIME type (`application/x.pixerate.document+json`) in a `copy` listener had no effect.
- **Root Cause**: ProseMirror's built-in copy/cut handler calls `clipboardData.clearData()` before writing `text/html` and `text/plain`, so anything a plugin wrote earlier is lost.
- **Solution / Workaround**: Take over the event: in `handleDOMEvents.copy`/`cut`, call `view.serializeForClipboard(slice)` (which still honours `clipboardTextSerializer`, e.g. markdown), write HTML, text and the custom type, `preventDefault()`, delete the selection for `cut`, and return `true`. Return `false` when there is no writable `clipboardData` so ProseMirror's handler runs. On paste, only accept the payload when its schema signature matches; otherwise fall back. Editor-level `editorProps.handlePaste` (e.g. `usePromptEditor`'s plain-text paste) runs before plugin handlers, so the plain-text invariant still wins there, and `EditorController` disables the rich paste path in `plainTextMode`.

### [svelte/tiptap] Passing `onUpdate: undefined` to TipTap Makes Every Update Throw

- **Issue / Symptom**: Any programmatic change in an `EditableTextNodeEditor` mounted without `onUpdate` (e.g. a file drop) threw `Cannot read properties of undefined (reading 'apply')` from `Editor.emit`.
- **Root Cause**: TipTap registers `options.onUpdate`/`onCreate` as event listeners with `this.on(...)`. Spreading an explicit `undefined` overrides TipTap's no-op defaults, so `emit` calls `undefined.apply`.
- **Solution / Workaround**: Only pass callbacks that are defined (`...(onUpdate ? { onUpdate } : {})`).

### [core/agent] Tool-List Notifications Must Be Coalesced and Compared

- **Issue / Symptom**: Registering one tool provider per mounted editor sends a burst of `tools/list_changed` notifications on page load, and React StrictMode's mount → unmount → mount announces changes that didn't happen.
- **Root Cause**: Every register/unregister/provider signal changes the registry, but MCP clients only care about the resulting list.
- **Solution / Workaround**: `ToolRegistry` schedules one check per `listChangedDelayMs` window and compares a JSON signature of `listTools()` with the last announced one, so remounts and content-only editor updates notify nothing. Register providers in effects and memoize them (`useMemo`) so they aren't re-registered on every render. Colliding names are namespaced per provider (`doc-1__get_text`) rather than "first wins", so names don't depend on mount order.

### [core/spreadsheet] Moving Cells (Sort, Transpose) Is Not an Insert/Delete, and Fill Is Not a Move

- **Issue / Symptom**: After sorting, `=A2*10` in a sorted row pointed at another row's value; a total row's `=SUM(B2:B5)` broke when ranges were rewritten cell by cell; autofilled formulas either all pointed at the source row or shifted `$A$1`.
- **Root Cause**: There are three different reference rewrites. Row/column insert/delete *shifts* references (`shiftFormulaReferences`). Sort and transpose *move* cells, so a reference must follow the cell it points at regardless of `$`, and a range can only be rewritten if its cells still form the same rectangle afterwards. Copy/paste and autofill *offset* a formula, so only relative parts change and `$` parts stay.
- **Solution / Workaround**: Use `remapFormulaReferences(formula, moveCell)` for sort/transpose (applied to every formula *before* moving cells, since rewriting only depends on old positions), and `offsetFormulaReferences(formula, dRow, dCol)` for paste/autofill. Ranges spanning a sorted block keep their text (they still cover the same cells); one-row ranges inside a sorted row follow the row. Sorting areas that contain merged cells is rejected, and merges (stored by index) are adjusted in `adjustTableForStructuralChange` on row/column insert/delete.

### [core/spreadsheet] Sort and Transpose Must Move Conditional Formats and Validations Too

- **Issue / Symptom**: After sorting, a highlight or a validation list set on one row's cells stayed on that row index and applied to whatever data landed there; after transposing, rules kept their old shape.
- **Root Cause**: Rule ranges (`table.conditionalFormats`, `table.dataValidations`) are stored by index and were only adjusted for row/column insert/delete. Rule formulas are written for the first range's top-left cell, so changing the ranges silently changes what relative references mean.
- **Solution / Workaround**: `sortRows` calls `sortRules` (Excel behaviour): the part of a rule range that spans every sorted row applies to the column and stays; parts covering only some sorted rows move row by row through the permutation (`sortRuleRanges`, re-merged with `mergeRuleRanges`). Whole-row sorts move rule cells past the last column too. When the first cell of a rule changes, its formulas are re-anchored (`reanchorRuleFormula`) so `$B2` keeps meaning "this row". `transposeRange` calls `transposeRules`: cells inside the block are transposed, rule cells under the transposed block are dropped (the block replaces them), and formulas are rewritten with `transposeFormulaReferences` (relative offsets and `$` flags swap axes; `$` parts outside the block keep their text). A rule with formulas that is only partly inside the block is split into two rules (the moved part gets a new id, right after it), since one formula can't serve both layouts. Rule formulas are not remapped like cell formulas on sort. Both run inside the sort/transpose snapshot (one undo step); the overlay is rebuilt because the change recalculates everything.

### [core/spreadsheet] Filters, Hidden Rows and Categories Belong in the View Model

- **Issue / Symptom**: Filtering by deleting/hiding rows in the document made undo, formulas (`SUM` over filtered rows) and data-source syncs inconsistent; keyboard navigation landed on hidden rows; merged-cell spans broke when part of a merge was hidden or grouped elsewhere.
- **Root Cause**: Filters, user-hidden rows/columns and collapsed groups are presentation, not data. Category groups also reorder rows on screen without reordering the document.
- **Solution / Workaround**: Keep every row in `document.rows`; store user hiding as `hidden: true` on rows/columns and filter/grouping/merge state in `document.table` (so the snapshot undo covers it). Render from `controller.getViewModel()`, which returns rows (with group headers) and columns in display order, sticky offsets and `getCellSpan(row, col)` (null for cells covered by a merge). `moveCursor` steps through `viewModel.rowOrder`/`columnOrder`. `DataSourceBinder.syncRows` rebuilds record rows, so it must carry `hidden` over. A sort of a data-bound sheet lasts until the next `syncWithDataSource()`, which restores the data source's record order.

### [react|svelte/spreadsheet] Copy/Paste Events Fire on `<body>`, Not the Focused Grid; `preventDefault` on Mod+C Suppresses Them

- **Issue / Symptom**: Writing `text/html` and the custom `application/x.pixerate.spreadsheet+json` clipboard formats never happened from the grid's `onCopy`, and the keydown handler's `navigator.clipboard.writeText` overwrote the rich data.
- **Root Cause**: The async Clipboard API cannot write arbitrary MIME types; only a `copy` event's `clipboardData` can. With no text selection, browsers dispatch `copy`/`paste` at `<body>`, not at a focused non-editable `div`. Calling `preventDefault()` on the Mod+C keydown cancels the copy event entirely. In jsdom no copy event follows a synthetic keydown.
- **Solution / Workaround**: Listen for `copy`/`paste` on `document` and act only when focus is inside the grid but not in a text input (cell editor, formula bar). On Mod+C, don't prevent default; schedule a `setTimeout(0)` fallback that writes TSV with `writeText` only if no copy event handled it (the copy event fires synchronously during the keydown's default action, before any task). Tests must dispatch a `copy`/`paste` `Event` with a stubbed `clipboardData`, or wait a tick for the fallback.

### [core/spreadsheet] Formula Ranges Arrive Flat and Column-Major

- **Issue / Symptom**: Lookup functions (INDEX, VLOOKUP, XLOOKUP) picked the wrong cells.
- **Root Cause**: `EvaluationContext.resolveRange` returns one flat array, column by column (the controller's loop order), with no row/column shape.
- **Solution / Workaround**: The evaluator records each range's shape (`withRangeShape`, a `WeakMap` keyed by the array, columns taken from the range reference) and functions read ranges through `ctx.range(i)` / `rangeGet(range, row, col)`. Never assume row-major order. Custom `resolveRange` implementations must return values column-major. Functions that would return a whole row/column return a shaped array: other functions can aggregate it, `evaluateWithDiagnostics` returns it as `array` (with the top-left value as `value`), and the controller spills it (see the dynamic-arrays entry).

### [core/spreadsheet] Typed Input Must Be Parsed, or `=B1>8` Treats a Typed `7` as Text

- **Issue / Symptom**: With typed cells stored as their raw text, a typed `7` was the string `"7"`, so `=B1>8` was TRUE (text ranks above numbers), `FILTER(A:A, A:A>8)` kept small numbers, `MATCH(5, …)` missed a typed `5`, and sort put `10` before `9`.
- **Root Cause**: `CellData.value` was set to `raw` for non-formula input, and the strict Excel comparison (`"1"=1` is FALSE) is correct only if typed numbers are numbers. Patching individual functions (`numericValue` / `normalizeValue` in lookups and criteria) hid the problem without fixing operators.
- **Solution / Workaround**: `setCellValue` (and so CSV/TSV import, `importRows`, paste and autofill) stores `parseCellInput(raw).value`: numbers (`1,234`, `$5`, `10%`, `(100)`, `1e3`, `1 1/2`), booleans, error literals, ISO dates and text; `raw` stays as typed and a leading `'` forces text. `loadDocument` and the constructor re-parse stored typed cells from `raw`, so old documents with `value: "7"` work. Bound columns are different: values read from the data source are never re-parsed, and writes are coerced only for `number`/`boolean`/`date` fields. Display through `formatCellDisplay(cell)`, which applies the automatic `numberFormat` (`10%` stays `10%`, not `0.1`). Comparisons go through `compareValues` (Excel order numbers < text < booleans < errors; numbers at 15 significant digits so `0.1+0.2=0.3`); sorting through `sortCompareValues` / `compareCellValues` (blanks last). `numericValue` still accepts numeric text for lookups, criteria and SUM-style functions, because data sources can supply numbers as strings.
- **Date representation**: dates stay ISO text (`3/4/2026` → `"2026-03-04"`, with a time `"2026-03-04 18:00:00"`), because date arithmetic, DATE/TODAY and existing documents all use ISO text. A time typed alone (`10:30`) becomes a day fraction (0.4375) like Excel, shown with its `h:mm` format. ISO text can't hold Excel's fictitious 1900-02-29, so typing it keeps text (as numeric text in a formula it is serial 60). `parseNumberText` turns date text into 1900-system serials (`serialFromYmd`); `dateToSerial` counts from 1899-12-30 and so differs by one for dates before 1900-03-01.

### [core/spreadsheet] `isFormulaError` Narrows `string` to `never`

- **Issue / Symptom**: After `if (isFormulaError(text)) return text;`, TypeScript reports `Property 'trim' does not exist on type 'never'` for a `string` variable.
- **Root Cause**: `isFormulaError(value): value is string` is a type guard. For a value already typed `string`, the false branch removes `string` entirely, even though most strings are not errors.
- **Solution / Workaround**: In formula function code, use `failed()` from `functions/helpers.ts`. Its overloads only narrow unions such as `number | string` and leave plain `string` results (`ctx.text(i)`) alone. In shared helpers, test `FORMULA_ERRORS.has(value)` instead of the guard.

### [react/svelte spreadsheet] Formula Autocomplete Keys and Clicks Must Not Reach the Grid or Blur the Editor

- **Issue / Symptom**: Pressing Tab or ArrowDown to pick a formula suggestion committed the cell and moved the selection. Clicking a suggestion committed the half-typed formula. The suggestion popup was clipped inside the cell.
- **Root Cause**: The grid handles Tab/arrows/Escape in a `keydown` handler that React and Svelte 5 both delegate to the root. The cell editor commits on `blur`, and clicking elsewhere blurs it. Cells use `overflow: hidden`.
- **Solution / Workaround**: `FormulaHints` adds a native `keydown` listener on the input element itself. It runs during the target phase, before the root-delegated handlers, and calls `stopPropagation()` only while suggestions are open. Enter is never intercepted, so it still commits. Suggestions accept on `mousedown` with `preventDefault()`, so focus stays in the input. The popup uses `position: fixed` from the input's bounding rect to escape cell clipping. In Svelte, update the caret state *before* calling `onAccept`. If you only update it after `tick()`, the hints are briefly computed from the new value and the old caret.

### [core/document-structure] Derived Node State Is Missing From the Initial Document

- **Issue / Symptom**: Headings created from initial `content` had no ids, a table of contents rendered empty and footnotes were unnumbered until the first edit, so `getHTML()` right after `new Editor(...)` (e.g. markdown → HTML conversion) produced incomplete output.
- **Root Cause**: Heading ids, TOC entries, footnote numbers and cross-reference labels are stored in node attributes and kept in sync by `appendTransaction`, which never runs for the document passed to `EditorState.create`. TipTap emits `create` (and so `onCreate`) from a `setTimeout`, so a fix-up dispatched there arrives a tick late.
- **Solution / Workaround**: `syncInitialContent` (in `extensions/document-structure/utils.ts`) runs the same sync pass in `onBeforeCreate`: it parses `editor.options.content`, applies the fix, and hands TipTap the resulting node. Those extensions use a priority below the Markdown extension's (50) so markdown has already been converted to HTML when they run, and `Outline` (45) runs before the extensions that read heading ids (40).

### [core/document-structure] Custom Parse Rules Lose to `listItem` and `Link` Without a Priority

- **Issue / Symptom**: Footnotes parsed from HTML or markdown came back empty, and a cross-reference (`<a data-type="cross-reference" href="#…">`) turned into plain linked text after `getHTML()` → `setContent()`.
- **Root Cause**: ProseMirror's `DOMParser.schemaRules` orders rules by priority (default 50), then lists **all mark rules before node rules**, then schema order. `li[data-type="footnote"]` lost to StarterKit's `li` rule, and the Link mark's `a[href]` rule matched before the cross-reference node rule.
- **Solution / Workaround**: Give specific parse rules `priority: 60` (done for the TOC, footnote, cross-reference and bookmark rules). Cover new nodes with an HTML round-trip test.

### [core/markdown] tiptap-markdown Re-runs `parse.setup` Before Every Parse

- **Issue / Symptom**: Custom markdown-it rules registered in an extension's `storage.markdown.parse.setup` would be added again on every `setContent`, and `[^1]: note` footnote definitions were swallowed as link reference definitions.
- **Root Cause**: `MarkdownParser.parse` calls every extension's `setup(md)` on the same markdown-it instance for each parse. markdown-it's `reference` block rule runs before most rules and accepts `[^1]: …` as a reference definition (label `^1`), and its `link` inline rule then consumes `[^1]`.
- **Solution / Workaround**: Guard plugins with a per-instance `WeakMap` (see `document-structure/markdown-it.ts`), and register footnote/TOC block rules `before("reference")` and the reference inline rule `before("link")`.

### [core/autocorrect] Input-Rule Replacements Cannot Be Undone Separately

- **Issue / Symptom**: With TipTap input rules (e.g. Typography's `--` → `—`), Mod-z after a replacement removed the replacement *and* the surrounding typing, unlike Word where undo restores exactly what was typed. With both Typography and `Autocorrect` installed, Typography's rules won for quotes and dashes.
- **Root Cause**: TipTap's input rules insert the typed character and the replacement in one transaction, which `prosemirror-history` merges into the current typing group. TipTap's input-rule plugin is registered before extension plugins, so its `handleTextInput` runs first.
- **Solution / Workaround**: `Autocorrect` handles `handleTextInput` itself and dispatches two transactions: the typed text (normal grouping) and the correction marked with `closeHistory`, so it is its own undo step; the next typed character is also `closeHistory`-ed so it does not join the correction. `createRichTextPreset({ autocorrect })` drops Typography; do not install both.

### [core/spreadsheet] `Date.now()` + Short Random Suffix Ids Collide When Growing the Grid

- **Issue / Symptom**: A 3,000-row chain of formulas imported with `importFromTsv` sometimes evaluated to `#CYCLE!`, and only under load (full test runs). Copy/paste tests flaked the same way.
- **Root Cause**: Row and column ids were `${prefix}_${Date.now()}_${4 random base-36 chars}`. Growing the grid creates thousands of rows within a few milliseconds, so two rows could get the same id (birthday collisions on ~1.7M values). Cells are stored by row id, so the two rows shared storage and the dependency chain appeared to loop.
- **Solution / Workaround**: Generated ids (rows, columns, filter rules) include a module-wide monotonic counter. Never build ids from time plus a short random suffix where many can be created in one tick. `spreadsheet-engine.test.ts` checks that 5,000 rows created in one burst have unique ids.

### [monorepo] Feature subpaths must not import the root `@pixerate/editor` entry

- **Issue / Symptom**: A spreadsheet-only consumer still bundles TipTap, markdown-it and ProseMirror, or must install `@dagrejs/dagre`, even though the spreadsheet code uses none of them.
- **Root Cause**: The root entry re-exports the TipTap extensions and serializers, so any binding that imports a spreadsheet helper from `@pixerate/editor` (instead of `@pixerate/editor/spreadsheet`) drags the whole rich-text graph in whenever the bundler cannot tree-shake (CJS, dev builds, `sideEffects` not honoured). Separately, anything in `dependencies` is installed for every consumer, whatever entry they use.
- **Solution / Workaround**:
  1. Inside `packages/react/src/{spreadsheet,image-editor}` and `packages/svelte/src/{spreadsheet,image-editor,history}`, import from the narrow core subpath (`@pixerate/editor/spreadsheet`, `/image-editor`, `/history`), never the root.
  2. Keep feature-only third-party packages (e.g. `@dagrejs/dagre`, `@xyflow/*`) in optional `peerDependencies` plus `devDependencies`, never `dependencies`.
  3. `tests/entry-isolation.test.ts` in each package walks the built entry's import graph and fails if a forbidden package becomes reachable. These tests read `dist/`, so run `pnpm build` first.

### [core/import] `DecompressionStream` Output Must Be Pulled Incrementally to Stop Zip Bombs

- **Issue / Symptom**: A 4 KiB deflate entry that declares a 100-byte size can inflate to gigabytes; checking sizes only after `new Response(stream).arrayBuffer()` lets it exhaust memory first. jsdom's `Blob` also has no `stream()`, so `blob.stream().pipeThrough(...)` helpers fail in React/Svelte tests.
- **Root Cause**: ZIP headers are untrusted; only the bytes actually produced by the inflater count. Buffering helpers (`Response.arrayBuffer`) read the whole stream before returning.
- **Solution / Workaround**: `readZip` feeds input in 64 KiB slices and reads output chunk by chunk, cancelling the reader and aborting the writer as soon as the output exceeds the entry's declared size (or the archive's remaining `maxTotalSize` budget), then verifies CRC-32. Swallow the writer's rejection (`.catch(() => {})`) after cancelling, or it surfaces as an unhandled rejection. In tests, drive `CompressionStream` through `getWriter()` / `getReader()` instead of `Blob.stream()`.

### [core/import] DOCX Attributes Are Namespaced, and Images Need a Schema With `image`

- **Issue / Symptom**: `el.getAttribute("val")` returns `null` for `<w:b w:val="0"/>`, so formatting toggles were ignored; DOCX images vanished in editors created with `image: false`.
- **Root Cause**: WordprocessingML attributes live in the `w:` / `r:` namespaces (and Strict OOXML uses different namespace URIs). Import adapters do not know the target schema, and ProseMirror's `DOMParser` drops `<img>` when there is no `image` node.
- **Solution / Workaround**: Read attributes by `localName` (the `attr()` helper in `import/docx.ts`) and accept both transitional and strict `w:` namespaces. The DOCX adapter always emits `<img>` data URLs (PNG / JPEG / GIF / WebP only — the sanitizer's `data:` allowlist) and lets the schema decide; pass `images: false` to skip reading media entirely.

### [core/canvas] Polygon Booleans Break on Shared Edges and Touching Vertices

- **Issue / Symptom**: Uniting two shapes that share an edge (e.g. snapped side by side) or touch at a corner produced figure-eight rings, leftover zero-width slivers, or dropped the result, and the result changed when one shape moved by `1e-12`.
- **Root Cause**: Classic clipping algorithms (Greiner–Hormann, naive Martinez) assume edges cross at isolated points. Shared and collinear edges, vertices lying on edges and floating-point intersections that land a hair off both segments break their in/out bookkeeping.
- **Solution / Workaround**: `polygonBoolean` builds a planar overlay instead: points closer than `epsilon` are merged through a grid-hashed pool, segments are split at crossings, T-junctions and collinear overlaps (repeated until stable, because snapping moves segments slightly), and coincident segments are merged with a signed count per operand. Each edge's sides are classified by a winding-number ray cast from its midpoint, with the ray crossing the edge rather than running along it. Rings are traced taking the sharpest left turn, so rings touching at a vertex stay separate simple rings. Test new cases with the area identity `|A∪B| = |A| + |B| − |A∩B|` and random point membership (see `canvas-shapes.test.ts`).

### [core/canvas] SVG Arc Flags Can Be Written Without Separators

- **Issue / Symptom**: `a5 5 0 0110 0` was parsed as the flags `0`, `110` (or, with a number tokenizer, lost its leading zero), so arcs went to the wrong point.
- **Root Cause**: In SVG path data, the large-arc and sweep flags are single characters `0` or `1` and need no separator, so `0110 0` means flags `0`, `1` and `x = 10`. A regex tokenizer reads `0110` as one number.
- **Solution / Workaround**: `parseSvgPath` uses a scanner that reads exactly one character for the two flag slots of `A` / `a` and normal numbers elsewhere.

### [core/spreadsheet] Dynamic Arrays: Spill Ranges Are Only Known After Evaluation

- **Issue / Symptom**: A formula reading a spilled cell (`=A2*10` next to `A1` = `=SEQUENCE(3)`) showed 0 after loading a document or the first time the array spilled, and stayed stale when the array changed size; typing into a spilled cell or clearing a blocking cell didn't update the anchor; `=SEQUENCE(2)+A2` in A1 oscillated between a value and `#CYCLE!`.
- **Root Cause**: The dependency graph is built from formula text, but which cells an array covers depends on its *result*. Before the anchor is evaluated nothing links `A2` to `A1`, so the topological plan can evaluate `A2`'s dependents first. Spilled cells have no formula, so editing one never reached its anchor, and a blocked anchor had no edge to the cells blocking it.
- **Solution / Workaround**: Spilled values are derived state kept in the controller (never written to `document.cells`; `getCell` overlays them with `raw: ''` and `spillAnchor`). After placing a spill the controller calls `DependencyGraph.setSpillEdges(anchor, spilledKeys, blockingKeys)`: spilled cells depend on the anchor, a `#SPILL!` anchor depends on its blockers. These edges live apart from formula edges (so `setCellFormula` doesn't drop them) and `recalculateAll` clears them. `recalculateKeys` runs the plan in passes: when a pass changes which cells are spilled, it re-plans from those cells with their dependents, until nothing changes (capped). A cyclic anchor clears its values but keeps its spill edges so the cycle is still found on the next pass. `A1#` depends on the anchor only. The grid never grows to fit an array (Excel doesn't either): past the edge is `#SPILL!`. Sorting, merging or transposing a range that touches a spill is refused (`false`), like Excel's "can't change part of an array".

### [core/track-changes] Code Blocks Reject Marks via `marks: ""`, and `extendNodeSchema` Cannot Override It

- **Issue / Symptom**: Insertions and deletions inside code blocks were silently untracked, and an extension's `extendNodeSchema(() => ({ marks: "insertion deletion" }))` had no effect.
- **Root Cause**: TipTap's `CodeBlock` sets `marks: ""`, and `getSchemaByResolvedExtensions` spreads `extendNodeSchema` fields *before* the node's own fields, so the node's `marks` always wins. `NodeType.allowsMarkType` reads `markSet`, which is computed once when the schema is built.
- **Solution / Workaround**: `TrackChanges` (`trackCodeBlocks`, default on) appends the insertion/deletion mark types to `markSet` of every `code` textblock in `onBeforeCreate`, which runs after the schema is created but before the document is parsed. Formatting marks stay disallowed. Schemas built headlessly with `getSchema(extensions)` do not get the patch, so tracked marks inside code blocks are dropped there.

### [core/track-changes] Formatting and Block Changes Need Per-Step Detection and Final-State Comparison

- **Issue / Symptom**: Comparing whole documents to find formatting or block changes is slow and ambiguous; comparing per step misattributes changes when one transaction changes the same text or block twice (toggle list = wrap + join; `setNode` copies attributes, including the `blockChange` record, to the new node).
- **Root Cause**: `AddMarkStep` / `RemoveMarkStep` (and `ReplaceStep`s whose content only differs in marks) say *where* formatting changed; `ReplaceAroundStep` (setBlockType, setNodeMarkup, wrap, lift) and `AttrStep` say *which* textblocks changed. Only the old document (`oldState.doc`, or the record already stored on the old node) knows the original state.
- **Solution / Workaround**: Steps only collect ranges/textblocks (mapped to the final document). Afterwards each text segment is mapped back with the inverted mapping to the old document and its original formatting (the old `formatChange.before`, or its marks) is compared with the current marks; textblocks compare the original snapshot (type, attrs minus ignored ones like outline `id`, wrapper types) with the final one. Equal → the record is removed (the change was reverted). Textblocks with no counterpart in the old document (splits) are skipped, and `blockChange` uses `keepOnSplit: false`. Restoring wrappers on reject ports prosemirror-schema-list's `sinkListItem` / `liftToOuterList` for list items and uses `lift` / `wrap` + `join` otherwise. Limitation: outdenting a nested item that has following siblings re-parents those siblings without changing their depth, so they get no record and rejecting the outdent nests them one level deeper. Paragraph splits/joins are not tracked at all. Converting to a code block drops incompatible marks, which reject cannot restore.

### [core/compare] Whole Paragraphs Have No Inline Representation, So Compare Records Them as `blockChange` Operations

- **Issue / Symptom**: Marking an inserted paragraph's text with `insertion` (and a deleted one's with `deletion`) is not enough: rejecting the insertion (or accepting the deletion) removes the text but leaves an empty paragraph, so "reject all" never reproduced the original document after `compareDocuments`.
- **Root Cause**: ProseMirror block boundaries are not characters (unlike Word's paragraph marks), and `TrackChanges` deliberately does not track paragraph splits/joins.
- **Solution / Workaround**: `compareDocuments` records wholly inserted/deleted blocks as `blockChange` records with `operation: "insert" | "delete"` on every textblock inside (one change id per run; the text itself is not marked). `applyDecision` removes accepted deletions / rejected insertions first (`removeBlocks`), taking along containers whose textblocks are all removed (list items, lists, quotes, rows), and replaces an emptied document with an empty paragraph. The tracker never rewrites or clears records that have an `operation`. `getEditorText` strips tracked text with `<ins>`/`<del>` regexes, which cannot see whole-block operations, so documents containing them are resolved with `resolveTrackedChanges` and re-serialized before the text is extracted. Limits: atom blocks (images, rules) and textblocks without the `blockChange` attribute cannot carry a record (reported in `summary.notHonoured`); `blockChange` is `keepOnSplit: false`, so pressing Enter inside an inserted block leaves the new half untracked. Container attribute changes (task `checked`, ordered-list `start`) are not tracked either.

### [core/compare] Word Tokens With Trailing White Space Misalign Before Punctuation

- **Issue / Symptom**: With "word + trailing space" tokens (as in wordcraft), `Old line.` → `New line here.` reported `Old line` deleted and `New line here` inserted, because `line` (before `.`) and `line ` are different tokens.
- **Root Cause**: The trailing white space is part of the token key, so the same word differs by position.
- **Solution / Workaround**: Words, white-space runs and symbols are separate tokens; equal runs that are only white space between two changes are absorbed into one replacement (`stretches()`), so `a b c` → `x y z` stays a single deletion + insertion instead of alternating. Note that `ignoreCase`/`ignoreWhitespace` keep the revised text without a change, so reject-all cannot restore those differences (by design), and code blocks in a headless `getSchema()` schema (no tracked marks, see the code-block entry above) are compared as whole-block replacements.

### [react/spreadsheet] Cell Editor Drafts Must Reach the Controller

- **Issue / Symptom**: In the React `SpreadsheetEditor`, text typed into a cell was thrown away on Enter, Tab or blur (the cell kept its old value). Only the formula bar worked. Found in the demo; no jsdom test typed into the cell input.
- **Root Cause**: `useSpreadsheetEditor` returned React's own state setter as `setDraftValue`, but `commitEditing()` (called without an argument) commits `controller.draftValue`, which never changed. Svelte's `draftValue` setter already wrote through to the controller.
- **Solution / Workaround**: `setDraftValue` writes `controller.draftValue` and the React state. Any binding that keeps its own copy of the draft must keep the controller's copy in sync.

### [react|svelte/spreadsheet] Type-to-Edit Doubled the Key, and Focus Was Lost After Enter

- **Issue / Symptom**: Typing `1` on a selected cell produced `11` (React). After Enter, the next keys went nowhere because focus fell to `<body>`. In Svelte the cell input was never focused, so only the first key landed.
- **Root Cause**: The grid's keydown handler starts editing with `e.key` as the draft but did not `preventDefault()`, so the browser also typed the key into the newly focused input. When the cell input unmounts on commit, the browser moves focus to `<body>`.
- **Solution / Workaround**: Call `preventDefault()` when a printable key starts editing, focus the cell input with the caret at the end (React `autoFocus` + `onFocus`, Svelte `$effect`), and refocus the grid after Enter / Tab / Escape. In Svelte, typing in the formula bar also opens the cell editor, so only focus the cell input when no other input has focus. Browser automation that "types" with `Input.insertText` sends no keydown, so drive type-to-edit with key presses.

### [react|svelte/spreadsheet] Sticky Headers Need Opaque Backgrounds, and Fixed Menus Must Be Clamped

- **Issue / Symptom**: Scrolled cells showed through the sticky column-header row and the row numbers. The right-click menu opened near the bottom of the window ran off-screen, leaving its last items unreachable.
- **Root Cause**: The sticky cells used translucent `bg-muted/60`, `/50` and `/90`. The menu is `position: fixed` at the pointer with no viewport check, and fixed elements do not scroll with the page.
- **Solution / Workaround**: Use an opaque `bg-muted` on sticky cells. Measure the menu after render and place it with `clampMenuPosition` (core): flip above / left of the pointer, or slide back into the viewport, plus `max-height` and `overflow-y: auto`.

### [core/canvas] React Flow's Drag-Stop Change Undoes the Last Snap, and `NodeChange` Has Id-less Members

- **Issue / Symptom**: Smart guides snapped nodes while dragging, but on release the node jumped back a few pixels to the raw pointer position. Separately, `applyNodeChanges(arrange.snapPositionChanges(changes), nodes)` did not type-check with React Flow's `NodeChange[]`.
- **Root Cause**: xyflow keeps its own drag positions computed from the pointer and reports them again in the final `dragging: false` change (SvelteFlow writes them into `nodes` before `onnodedragstop`). React Flow's `NodeChange` union includes `{ type: 'add', item }`, which has no `id`, so it was not assignable to `PositionChangeLike`.
- **Solution / Workaround**: The arrange controller remembers the last snapped positions: `snapPositionChanges` rewrites the drag-stop change with them, and `endDrag()` writes them back after a SvelteFlow drop. `PositionChangeLike.id` is optional.

### [demo/theme] Library Components Read Theme Tokens Both as Tailwind Colors and as Raw CSS Variables

- **Issue / Symptom**: Without theme tokens, the spreadsheet, review panel and menus rendered unstyled in the demo (transparent popovers, invisible borders and selection).
- **Root Cause**: Components use shadcn classes (`bg-background`, `bg-primary/10`, `border-border`) and also inline styles such as `var(--primary, #6366f1)` and `var(--popover, …)`. shadcn's usual HSL-triple variables (`--primary: 240 5% 26%`) are invalid when used directly as a color, and Tailwind colors defined as plain `var(--x)` lose opacity modifiers.
- **Solution / Workaround**: The demo defines `--x-rgb` channels for Tailwind (`rgb(var(--x-rgb) / <alpha-value>)` in `apps/demo/tailwind.config.js`) and full colors `--x: rgb(var(--x-rgb))` for inline styles (`apps/demo/src/index.css`). Hosts using shadcn HSL triples should also define full-color `--primary`, `--background`, `--muted` and `--popover`.

### [core/image-editor] Changing How Saved Adjustments Render Needs a New Process Version

- **Issue / Symptom**: Improving the adjustment maths (linear-light exposure, Bradford white balance, tone LUTs) changed how every saved edit looked; `{ ...DEFAULT_ADJUSTMENTS, ...saved }` silently moved old edits to the new rendering. The old 8-bit path also clamped after each step, so exposure up then contrast down turned distinct highlights into one flat grey.
- **Root Cause**: Adjustment values have no meaning without the algorithm that interprets them, and a default spread fills a missing field with the *new* default.
- **Solution / Workaround**:
  1. `ImageAdjustments.process` selects the rendering. A missing or damaged value is process 1 (`normalizeProcessVersion`), which `applyLegacyAdjustments` renders unchanged (frozen; `tint` is ignored there). New edits and Reset get `LATEST_PROCESS_VERSION` (2). Load stored adjustments through `normalizeStoredAdjustments`, never `{ ...DEFAULT_ADJUSTMENTS, ...stored }`.
  2. Process 1 is serialized without `process` (and without a zero `tint`), so old documents round-trip byte for byte. `upgradeProcess()` is the one explicit, undoable way to move an edit forward.
  3. A future look change adds process 3 and a new branch in `applyAdjustments`; never edit process 1 or 2 output in place (bug fixes for broken output excepted). The legacy pixel snapshot in `tests/image-editor-color.test.ts` guards this.
  4. Process 2 is identity at neutral within ±1 only because the tone LUT's highlight shoulder degenerates to the identity when headroom is 1 and the encode LUT has 65 536 entries. Keep `headroom = max(1, reach)` per channel; a fixed shoulder would shift unedited highlights.
  5. The renderer's base-canvas cache key must include every field that affects pixels (`tint`, normalised `process`), or switching process shows a stale image.

### [core/image-editor] Adjustment Layers Must Not Change How Layer-Free Edits Load, Save or Render

- **Issue / Symptom**: Adding `layers` to the editor state risked re-serializing every old document (a new schema version, an empty `layers: []`), a stale preview after editing a layer, and a different look for edits that never used layers.
- **Root Cause**: Saved documents are compared and diffed as JSON; the renderer caches the adjusted base canvas by a key of the fields that affect pixels; and layer maths that ran on every pixel (even as an identity) would round values differently.
- **Solution / Workaround**:
  1. Layers live in `adjustments.layers` and are **absent** (not `[]`) when there are none: `normalizeStoredAdjustments`, `setAdjustments` and the layer methods delete the key for an empty list. Only states with layers serialize as `version: 2`; layer-free states stay `version: 1`, byte for byte. Load through `migrateSerializedImageEditorState` / `normalizeAdjustmentLayers`, which clean and clamp stored layers.
  2. `applyAdjustmentLayers` runs after the base process (1 or 2) and before blur, on the encoded 8-bit result, and skips neutral, disabled and zero-opacity layers entirely (`compileAdjustmentLayer` returns `null` for the identity), so no layers means no extra pass.
  3. The renderer's base key includes `adjustmentLayersKey(layers)`. Per-layer LUTs are cached by `kind + JSON(params)`, so slider drags only recompile the layer that changed.
  4. Levels work on whole levels (quantum 255) like Photoshop's 8-bit documents; Curves and Levels apply each channel's record before the master.

### [core/image-editor] Canvas `soft-light` Is Not Photoshop's Soft Light; Scalar Blend Fallback Must Stay Inside the Clip

- **Issue / Symptom**: Annotations drawn with `globalCompositeOperation = 'soft-light'` looked different from adjustment layers in Soft Light, and modes such as Linear Burn, Pin Light, Hard Mix, Subtract and Divide have no canvas operation at all.
- **Root Cause**: Canvas implements the W3C Compositing soft light; Photoshop's uses a different formula for a light source (`cs > 0.5`: `2·cb·(1 − cs) + √cb·(2·cs − 1)`). The other modes simply do not exist in Canvas 2D.
- **Solution / Workaround**: `BLEND_MODES[].canvas` lists an operation only where the maths match (`soft-light` is `null`). For the rest, `drawAnnotation` draws the annotation on a same-size layer with the same transform, blends it into a copy of the target pixels with `blendImageData`, and draws the result back with `globalCompositeOperation = 'copy'` under an identity transform: `copy` only replaces pixels inside the current clip, so the image-region clip still holds. Without pixel access (tainted or headless canvas) it falls back to a normal draw.

### [svelte/image-editor] Subscribing to a Controller Inside `$effect` Loops Forever

- **Issue / Symptom**: Mounting the Svelte `AdjustmentLayersPanel` threw `effect_update_depth_exceeded`, and the existing image editor test took 9 s before failing.
- **Root Cause**: `controller.subscribe(listener)` calls the listener synchronously; a listener doing `tick++` reads and writes `tick` inside the effect, so the effect depends on the state it writes.
- **Solution / Workaround**: Subscribe inside `untrack(() => controller.subscribe(...))` and return the unsubscribe function. Keep large per-render objects such as the histogram in `$state.raw`, so they are not deep-proxied on every render.


### [core/history] Keyed Gestures Merge Commands, so Commands Must Be Absolute or Untagged

- **Issue / Symptom**: A held gesture (`beginGesture`) that drags two parameters (volume and pan) into one undo step would redo only the last one, and undo would restore only one of them, if the merge kept "first undo + last redo" as the time-window `executeMerged` does.
- **Root Cause**: "Keep the first undo, take the last redo" is only correct when every merged command sets the *same* thing to an absolute value. Different parameters (or relative commands like "increment") need every command's undo and redo.
- **Solution / Workaround**: A keyed step keeps a list of parts. A merged command whose `tag` equals the last part's `tag` replaces that part's redo (absolute-command assumption, as before); anything else is appended, and undo runs the parts in reverse. Give absolute "set" commands a `tag` so long drags stay one small part; leave relative commands untagged. Gestures end on any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()`; reads, marks and empty batches do not end them.

### [core/history] Undo Marks Must Detect a Lost Start, Not Just a Lost Top

- **Issue / Symptom**: `revertTo(mark)` for a mark taken on an empty history (Escape on the first drag) would undo steps that existed before the drag once `maxDepth` / `maxBytes` had dropped the bottom of the stack, and a naive mark would survive `clear()`.
- **Root Cause**: A mark that points at "no top step" cannot be found in the stack, so "undo until the top is the marked step" runs to the bottom of whatever is left.
- **Solution / Workaround**: Marks carry the marked step's id plus a `dropped` counter and an `epoch` (bumped by `clear`). An empty-history mark is valid only while nothing has been dropped; any mark from an older epoch is a no-op returning 0. Reverted steps are removed outright (and undone steps made after the mark are filtered out of redo), so redo never brings a cancelled drag back.

### [core/dirty] Dirty Tracking Must Compare Values, Not Count History Steps

- **Issue / Symptom**: Navigation guards kept prompting after undoing back to the saved state, selecting text or zooming marked the document modified, and loading a file marked it dirty before the user typed anything.
- **Root Cause**: A "changed since save" boolean set by every edit never goes back to false on undo; whole-state comparison counts view state (selection, viewport); programmatic loads go through the same change paths as user edits.
- **Solution / Workaround**: Use `bindDirtyToHistory({ history, getValue, normalize })` (React `useHistoryDirty`, Svelte `createHistoryDirty`): every history change re-compares `normalize(value)` with the saved baseline (cached per `history.getRevision()`), so undo-to-saved is clean. Strip view state in `normalize`. Wrap loads/restores in `suppress(fn)`: it is re-entrant (depth counter), lasts until a returned promise settles, and rebaselines to the loaded value even if the load bypassed the history. Changes made outside the history (e.g. selection) need `refresh()`, which ignores the revision cache.

### [core/canvas] xyflow Resizers Report Raw Sizes, and SvelteFlow Writes Them After `onResize`

- **Issue / Symptom**: Resize snapping flickered back to the unsnapped size when the pointer was released (React Flow), or did nothing at all (SvelteFlow `onResize`).
- **Root Cause**: `XYResizer` keeps its own raw `prevValues`; React Flow's end change (`type: 'dimensions'`, `resizing: false`) carries those raw values, undoing the last snap. SvelteFlow's `ResizeControl` calls `onResize` *before* writing the raw `x` / `y` / `width` / `height` to `store.nodes`, so anything written from `onResize` is overwritten. The changes also do not say which handle is dragged.
- **Solution / Workaround**: React: `snapResizeChanges` remembers the last snapped size and rewrites the `resizing: false` change. Svelte: `resizerHandlers(id)` defers `resize(id)` / `endResize()` with `queueMicrotask`, after the resizer has written the raw size. The handle is inferred from the edges that moved since `beginResize` (`inferResizeHandle`). While resizing, read `width` / `height` before `measured` (`getResizingNodeRect`): `measured` is stale until xyflow re-measures.

### [core/canvas] Corner Detection on Polylines Breaks on Noisy or Coarsely Flattened Input

- **Issue / Symptom**: Curve fitting a freehand stroke produced dozens of tiny segments; fitted boolean results of small ellipses stayed polylines.
- **Root Cause**: A turning-angle test between adjacent edges reads sample jitter as corners (alternating ±0.3 px noise on 2 px steps turns ~33° per vertex), and a coarsely flattened small circle (radius ≲ 5 at tolerance 0.25) really does turn more than 30° per vertex.
- **Solution / Workaround**: `fitCubics` measures each vertex's turn to the nearest neighbours at least 4 × `tolerance` away and keeps only the sharpest vertex in that neighbourhood. For very coarse polygons raise `cornerAngleDeg`, or flatten with a smaller `tolerance`. `fitPathData` falls back to the original polyline when fitting would not remove vertices.

### [core/commands] Shortcut Handlers Must Not `preventDefault` Disabled Commands, and Mod Differs Per Platform

- **Issue / Symptom**: A global shortcut listener that calls `preventDefault()` on every bound chord blocks the browser and focused editors even when the command can't run (e.g. `Mod+Z` with nothing to undo). Separately, `Mod+Y` (redo) and an app binding on `Ctrl+Y` look different in the keymap but collide on Windows and Linux, and the collision is invisible when tests only run on macOS.
- **Root Cause**: Whether a chord should be consumed depends on the command's enablement at that moment, not only on the binding. `Mod` is ⌘ on macOS and Ctrl elsewhere, so whether two chords collide depends on the platform.
- **Solution / Workaround**: `CommandRegistry.handleKeyDown` resolves the command, checks `isEnabled`, and only then calls `preventDefault()` and runs it. `ShortcutMap.findConflicts(platform)` compares effective chords (with `Mod` resolved for that platform), and `commands.test.ts` asserts that the default keymaps have no conflicts on mac, windows and linux. Bindings that only make sense on some platforms use `platforms` (e.g. `Mod+Y` redo off macOS). Keys match by `event.code` (see "Option/Alt Shortcuts Must Match `KeyboardEvent.code`"). The one exception is `shortcutCode`: a letter key that produces a different Latin letter without Alt uses that letter, so `Mod+Z` follows the Z label on AZERTY, QWERTZ and Dvorak, as browsers do. Matching both the code and the key would fire `Mod+Z` from two different physical keys.

### [core/commands] Agent `listChanged` Only Fires When Tool Definitions Change

- **Issue / Symptom**: Registering or removing commands did not send `tools/list_changed` to agents using the command tool provider.
- **Root Cause**: `ToolRegistry` compares a JSON signature of `listTools()` (see "Tool-List Notifications Must Be Coalesced and Compared"). The three command tools (`list_commands`, `run_command`, `run_commands`) never changed, so their signature never changed either.
- **Solution / Workaround**: `run_command`'s `id` schema carries an `enum` of the visible command ids. The tool definition now changes when commands are added or removed, but not when they run or their enablement changes. `run_commands` keeps a free `id` string so that each step can report `unknown_command` on its own instead of the whole batch being rejected.

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide in `dist` on Case-Insensitive File Systems

- **Issue / Symptom**: `svelte-check` warned `Cannot write file '.../dist/commands/CommandPalette.svelte.js' because it would be overwritten by multiple input files` after adding `CommandPalette.svelte` next to a rune file `commandPalette.svelte.ts`.
- **Root Cause**: Both compile to `…alette.svelte.js` / `.d.ts`. On macOS and Windows file systems, which are case-insensitive, these are the same path, so one output silently replaces the other.
- **Solution / Workaround**: Give rune modules names that differ from component names by more than case (`palette.svelte.ts` next to `CommandPalette.svelte`).

### [monorepo/licensing] Ported Code Needs Its Notice in the Published Package, Not Just in Source

- **Issue / Symptom**: Files ported from the MIT/Apache ArtCraft apps carry a header comment and a root `THIRD_PARTY_NOTICES.md`, but neither reached npm: tsup strips comments from `dist`, and `@pixerate/editor` publishes only `dist`.
- **Root Cause**: MIT requires the copyright and permission notice in every copy, including the published package. A root-level file is outside the package's `files`.
- **Solution / Workaround**: `packages/core/THIRD_PARTY_NOTICES.md` is a copy listed in `files`. `tests/third-party-notices.test.ts` fails if it drifts from the root file. When porting more code, add a section to the root file and copy it into the package (and into `packages/react` / `packages/svelte` too if ported code lands there).

### [core/persistence] Autosave Must Not Overwrite the Previous Session's Snapshot Before the User Decides

- **Issue / Symptom**: After a crash, reopening the app showed the "Restore unsaved changes?" prompt, but the snapshot it offered was already replaced by the freshly loaded (unchanged) document, or by a clean meta written when the new session "saved".
- **Root Cause**: Autosave started as soon as the editor mounted: loading the document counted as a change, and a save in the new session retired whatever snapshot was in storage, including one this session never wrote.
- **Solution / Workaround**: `createAutosaveController` writes nothing until `ready()` (the hydration gate); `useAutosave` / `createAutosave` call it only after the recovery check found nothing or the user chose Restore / Discard. `markClean()` only writes a clean meta for a snapshot this session wrote (`createRecoveryPolicy().ownsSnapshot`), so a clean start never consumes an earlier session's snapshot. The snapshot is written before its dirty meta, so the meta never points at a missing snapshot.

### [core/persistence] Revision Listeners Can Run Before the Dirty Binding Updates

- **Issue / Symptom**: With `bindDirtyToHistory` and an autosave both subscribed to the same `HistoryManager`, undoing back to the saved state still wrote a snapshot (or a save was not noticed) depending on subscription order.
- **Root Cause**: `HistoryManager` notifies listeners in subscription order. If the autosave's listener runs first, the binding's `dirty` flag is still stale when it is read.
- **Solution / Workaround**: `createRevisionTracker` reads the dirty flag lazily in `savedRevision()`, and `AutosaveController.notify()` never ticks synchronously (it schedules a timer), so every history listener has run before the policy looks at the revisions. A stale clean read heals itself: when the binding then flips to dirty, the tracker bumps the revision.

### [core/persistence] OPFS Writes: `createWritable` and `move` Are Not Everywhere

- **Issue / Symptom**: An OPFS adapter that works in Chromium rejects every write in some Safari versions, or a crash mid-write leaves a truncated file.
- **Root Cause**: `FileSystemFileHandle.createWritable()` is missing on Safari's main thread in older versions (only `createSyncAccessHandle` in workers), and `FileSystemHandle.move()` (rename) is not universally available. Writing a file in place is not atomic.
- **Solution / Workaround**: `createOpfsAdapter` writes `<file>.tmp` and renames it over `<file>` where `move` exists, and otherwise alternates two slots (`.a` / `.b`) and swaps a `.ptr` file only after the slot is complete. Without `createWritable`, `set` rejects with `StorageUnavailableError`; feature-detect with `isOpfsAvailable()` and fall back to `createIndexedDbAdapter` or `createLocalStorageAdapter`. Only localStorage writes are synchronous, so on `pagehide` it is the only backend guaranteed to finish; `flushNow()` still starts the async write for the others.

### [core/generation] Prompt Limits Count Resolved Text, So the Planner Cannot Truncate Them

- **Issue / Symptom**: A 40-character prompt such as `{{style}} portrait` passed a model's 1000-character limit in the UI, but the provider rejected it: the template expanded to 1,400 characters. Truncating `request.prompt` to fix it cut the raw template text, which did not shorten the resolved prompt and could break a `{{tag}}` in half.
- **Root Cause**: Models limit what they receive (the resolved prompt), but the request carries the raw template. The length that counts and the text you can edit are different strings.
- **Solution / Workaround**: `prompt.countResolved` defaults to `true`. Pass the resolved text as `planGenerationRequest(…, { resolvedPrompt })`. When the resolved text is over the limit, the planner reports an error under every strategy and leaves the prompt alone. It only truncates when it measured the same string it would edit. `capabilitiesToJsonSchema` puts `maxLength` on `prompt` only when `countResolved: false`; otherwise the limit appears only in the description, so schema validation of a raw template does not give false passes or failures.

### [core/generation] Retried `generate` Calls Need Idempotency Keys That Compare Arguments and Forget Failures

- **Issue / Symptom**: An agent that timed out waiting for `generate` retried and was billed for two generations. A naive "seen this key" cache then made things worse: a call that failed upstream could never be retried, and reusing a key with a different prompt silently returned the old result.
- **Root Cause**: MCP clients retry on transport errors without knowing whether the first call ran. A key on its own does not say whether the retry is the same request.
- **Solution / Workaround**: `createGenerationToolProvider` stores `key → { signature, promise }`. The signature is a stable (sorted-key) JSON of the other arguments. A retry with the same key and arguments while the call is still running joins the same promise; once it has finished, the retry returns the cached result marked `deduplicated: true`. The same key with different arguments is an error. A rejected call removes its key so it can be retried. Keys are evicted oldest-first past `maxIdempotencyKeys`. The tool keeps `destructiveHint: true` together with `idempotentHint: true`, because repeating it with the same arguments has no further effect.

### [core/generation] Nearest-Option Snapping Hits Exact Ties on Log Scales

- **Issue / Symptom**: Snapping `720p` to `["480p", "1080p"]` or `1:1` to `["9:16", "16:9"]` returned whichever option came first, which changed when the server reordered its options.
- **Root Cause**: Resolutions and aspect ratios are compared on a log scale (pixel count, width/height). Common presets form geometric series, so 720p lies exactly between 480p and 1080p (both ratios are 1.5), and 1:1 lies exactly between 9:16 and 16:9.
- **Solution / Workaround**: `snapToOption` compares distances with an epsilon and breaks ties by rank, never by option order: `downgrade` picks the lower option, while `upgrade` and `nearest` pick the higher one. Integer and step rounding use the same rule (`count: 3` against `[2, 4]`). Tests for snapping should include an exact tie.

### [core/generation] Batch Resolvers Must Resolve Each Batch's Own Promises When the Cache Is Cleared Mid-Flight

- **Issue / Symptom**: After `resolver.clear()` was called while a batch was still fetching, the `load()` promises waiting on that batch never settled.
- **Root Cause**: The batch looked up waiters in the shared in-flight map when the fetch returned, but `clear()` had already emptied that map.
- **Solution / Workaround**: `createBatchResolver` captures each batch's pending entries when the fetch starts and always resolves them. It only writes the result to the cache if the in-flight entry is still the same object, so values from before a `clear()` do not come back. A failed batch resolves its keys to `undefined` and records them as failed (`failed(key)`), so a bad response does not cause a retry storm. `clear(key)` allows a retry.

### [core/grammar] New Syntax Inside `{?…}` Collides With Names That Were Already Valid

- **Issue / Symptom**: Adding comparison conditions as `{?amount>100}…{/amount>100}` (or any new syntax inside `{?…}`) would have silently changed prompts that already used `=`, `<` or `>` in a section name, and `JSX` attribute strings like `defaultSource="a\nb"` in tests kept a literal backslash-n instead of a newline.
- **Root Cause**: A section name was "anything but `|` and `\`", so every candidate syntax inside the braces (`{?a>1}`, `{?=a>1}`, even `{?a|>1}`, which is a variable) already meant something. JSX attribute strings are not JavaScript string literals and do not process escapes.
- **Solution / Workaround**: The comparison is recognised only when the open tag is closed by its bare subject (`{?amount>100}…{/amount}`), a pairing the old grammar always reported as unbalanced; `{?a>1}…{/a>1}` keeps its old meaning. `matchConditionalTags` searches for an exact name or a comparison subject, which picks the same partner as before for every diagnostic-free prompt. `grammar.test.ts` proves this by swapping `= < >` for neutral symbols and comparing old and new results on random prompts. Record-level directives (`{!next}`) were rejected for the same reason: `{!next}` is already an "unless" section. In JSX tests, pass multi-line strings as `{"a\nb"}`.

### [core/canvas] Auto Layout Must See Flow Changes Before They Are Applied, and Must Not Ping-Pong With Measuring

- **Issue / Symptom**: Deleting a child of an auto layout frame left the frame at its old (hugging) size, and relayout after every measured `dimensions` change could keep re-writing node sizes.
- **Root Cause**: A React Flow `remove` change only carries the id; once `applyNodeChanges` has run, the node and its `parentId` are gone, so the frame to relayout is unknown. SvelteFlow calls `ondelete` after removing the nodes. Writing `width` / `height` makes xyflow re-measure the node, which emits another `dimensions` change.
- **Solution / Workaround**: Pass each `onNodesChange` batch through `autoLayout.noteChanges(changes)` *before* applying it (it records the parents of removed nodes) and flush after the nodes update (`useCanvasAutoLayout` flushes in a layout effect, the Svelte rune on a microtask; Svelte's `nodesDeleted(nodes)` reads `parentId` from the deleted node objects). Layout passes only return updates that differ by more than 1e-6 and `flush` writes nothing when there are none, so a re-measure with the same size ends the loop.

### [core/canvas] Child Order in Auto Layout Frames Is the Node Array, Which Must Keep Parents First

- **Issue / Symptom**: Moving a flow child to a new slot by splicing the node array made xyflow warn about (or misplace) the moved node's own children.
- **Root Cause**: xyflow requires every parent to come before its children in the array. Moving a node later than its descendants breaks that, and moving it earlier than its parent too.
- **Solution / Workaround**: `moveLayoutChild` puts the siblings back into the array slots they already occupied (in the new order) and then runs a stable parents-first pass. Use it (or `autoLayout.moveChild`) instead of splicing; `zIndex` stays independent of layout order.

### [react/svelte] Spreading a Controller Object Snapshots Its Getters

- **Issue / Symptom**: `useCanvasAutoLayout(...).hasPending` (and `guides` before it was re-declared) never changed after the first render.
- **Root Cause**: `{ ...controller }` copies the *value* a getter returns at spread time, not the getter.
- **Solution / Workaround**: Re-declare live properties as getters (or state) on the object the hook / rune returns after the spread, as `useCanvasAutoLayout` and `createCanvasAutoLayout` do for `hasPending` and `guides`.

### [core/spreadsheet] Number Formats Must Round the 15-Digit Decimal String, Not the Binary Value

- **Issue / Symptom**: `(2.675).toFixed(2)` is `"2.67"` and `(1.005).toFixed(2)` is `"1.00"`, but Excel shows `2.68` and `1.01` with `0.00`. Porting Rust's `format!("{:.*e}")` to `toExponential` also differs on exact ties (Rust rounds half to even, JS picks the larger digit), and `toExponential` stops at 100 digits, too few for the exact expansion of a double (up to 767 digits).
- **Root Cause**: Excel first writes a number with 15 significant digits, then rounds that decimal string half away from zero. An exact tie at the 16th digit (`1234567890123455`) goes toward zero.
- **Solution / Workaround**: Always format through `numfmt/decimal.ts` (`decimalDigits` → `fixedFromDigits`), never `toFixed`. It takes 16 digits from `toExponential(15)`; only when the 16th digit is a 5 does it check for an exact tie, using the exact decimal expansion computed with `BigInt` from the double's bits. The tie rules are covered by `tests/number-format.test.ts`.

### [core/spreadsheet] Number Formats See Dates as ISO Text, and the 1900 Leap Day

- **Issue / Symptom**: A date cell (`"2026-03-04"`) formatted with `0.00` or `dddd` must behave like Excel's serial 46085; `dateToSerial` gives serials one too low before 1900-03-01, and serial 60 (the fictitious 1900-02-29) has no ISO text.
- **Root Cause**: Our engine stores dates as ISO text and times as day fractions, while format codes work on 1900-system serial numbers.
- **Solution / Workaround**: `dateValueToSerial` (used by `NumberFormat.format`, `formatCellForDisplay` and `TEXT()`) converts ISO text with `serialFromYmd`, which counts the fictitious leap day; `renderDate` maps serial 60 to 2/29/1900 and serial 0 to 1/0/1900, as Excel does. Only ISO text is converted in cell display: other numeric-looking text stays text (Excel shows text through the `@` section). Only the 1900 date system is supported.

### [svelte/spreadsheet] Mutating a Cell Object in Place Does Not Re-Render It

- **Issue / Symptom**: Setting `cell.numberFormat` on the stored cell object and calling `notifyChange()` updated the controller, but the Svelte grid kept showing the old text (React happened to re-render).
- **Root Cause**: The Svelte grid reads cells through `{@const cell = sheetState.getCell(...)}`; Svelte deriveds compare with `===`, so the same object means nothing downstream re-runs.
- **Solution / Workaround**: Controller operations replace cell objects (`cells[colId] = { ...cell, numberFormat }`) instead of mutating them. Do the same for spilled display cells (`spillCells.set(id, {...})`).

### [core/spreadsheet] A Format-Only Blank Cell Over a Bound or Column-Formula Value

- **Issue / Symptom**: `setCellNumberFormat` on a bound record cell or a column-formula cell has nowhere to put the format: those cells are derived, and a stored blank cell normally hides the derived value (it means "cleared").
- **Root Cause**: `getCell` returns a stored cell with empty `raw` before looking at derived values.
- **Solution / Workaround**: A stored blank cell with `explicitNumberFormat` is treated as format-only: `getCell` returns the derived value with that format (`{ ...derived, numberFormat }`). Known limitation: a cleared column-formula cell that also has an explicit format therefore shows the column value again.

### [core/find-replace] JavaScript `RegExp` Backtracks, So Word Wildcards Cannot Be Translated to a `RegExp`

- **Issue / Symptom**: Translating Word's wildcard patterns to a `RegExp` (as WordCraft does for Rust's linear-time `regex` crate) freezes the tab on patterns such as `(a@)@b` (`(a+)+b`) or `*a*a*b` (`.*?a.*?a.*?b`) against a long paragraph without a match: exponential or high-polynomial backtracking inside a single `exec`, which cannot be interrupted.
- **Root Cause**: V8's irregexp is a backtracking engine. Rejecting nested quantifiers is not enough: several adjacent lazy `*` runs are polynomial (O(n^k)), and a time check between `exec` calls never runs while one call is stuck.
- **Solution / Workaround**: Special-character and wildcard patterns compile to a small program run by a Pike VM (`packages/core/src/extensions/find-replace/pattern.ts`), which is O(text × program) for any pattern; counted repeats are expanded and the program is capped at 20 000 instructions (`too_complex`), the Find text at 1 024 characters (`too_long`), and every search has a shared budget (VM steps, wall-clock `timeLimitMs`, `maxMatches`) reported as `truncated`. Only the raw `regex` option uses `RegExp`: it rejects a repeated group containing a repeat (`(a+)+`, `(\w*)*`) and checks the deadline before each `exec`, but cannot stop a single runaway call; leave regex mode out of your UI if users can search very large documents. Also: in a VM thread loop, when no thread is alive at a position (an assertion like `<` failed), advance and bump the list generation instead of stopping, or later matches are missed.

### [core/find-replace] Search Text Must Skip Tracked Deletions but Keep Their Neighbours as Context

- **Issue / Symptom**: With Track Changes on, Replace found its own struck-through text again and never advanced; `catfish` was found across a deleted space; or `fish` (whole word) was found right after a deleted space although the live text reads `catfish`.
- **Root Cause**: Tracked deletions stay in the document with a `deletion` mark, and replacing while tracking re-inserts the found text as a deletion. Simply concatenating all text nodes searches deleted text; searching each live run separately loses the neighbouring live characters that word-boundary assertions need.
- **Solution / Workaround**: Build one search string per textblock from the non-deleted runs (with a per-character map back to document positions), record a "cut" wherever deleted text was skipped, and search each cut segment with the whole string as context (the Pike VM checks assertions against the full string; the regex path searches a prefix with `lastIndex`). Paragraphs are only joined (with `\r`) when the pattern can match `^p`. Replacements go through ordinary `replaceWith`, so the `TrackChanges` `appendTransaction` turns them into tracked deletions and insertions in the same undo step.


### [core/serializers] Lazy and `[^>]*` Regexes Are Quadratic (or Cubic) on Malformed HTML

- **Issue / Symptom**: `extractMentions` took 227 s on 4,000 repetitions of `<span data-type='mention' ` (no `>`), and `htmlToPlainText` grew 4× per doubling of such input. A "linear time" test only passed because its input was small enough to stay under an absolute 1 s budget, and it flaked once the suite grew.
- **Root Cause**: `/<span\b[^>]*\b(?:a|b)[^>]*>/` backtracks over every split of the two `[^>]*` runs (cubic) when no `>` follows; `/<[^>]+>/g`, `/<pre[\s\S]*?<\/pre>/g`, ```` /```[\s\S]*?```/g ```` and `/\]\([^)]*\)/g` rescan to the end of the input from every opener that has no closer (quadratic).
- **Solution / Workaround**: Use the scanners in `packages/core/src/serializers/html-scan.ts` (`findTagSpans`, `replaceTagSpans`, `stripTags`, `replaceDelimited`). They find each closer once, reuse it until the scan passes it, and stop when none is left. `tests/html-scan.test.ts` checks they match the old regexes on random input and that time grows linearly. When testing performance, assert growth between two sizes rather than an absolute time, which depends on machine load. `preprocessMarkdownMentions` had the same problem through `MARKDOWN_MENTION_SPLIT_REGEX` (219 s on 4,000 unclosed mention spans); it now splits with `splitMarkdownMentionParts`, a single forward scan with cached closers. The regex stays exported as the reference definition only, so don't use it on untrusted input.

### [core/canvas] Token-Bound Properties Are Materialised Into the Nodes, Not Resolved at Render Time

- **Issue / Symptom**: Resolving token bindings inside node renderers would leave auto layout, measuring, exports and copy / paste seeing stale literals (a bound `gap` would never move children), and a node whose variable was deleted would show nothing.
- **Root Cause**: Auto layout, arrange, clipboard and xyflow itself read ordinary node fields (`data.layout.gap`, `style`, `data.shape.fill`); only a renderer knew about the binding. Deleted variables no longer resolve, so a render-time lookup has no value to show.
- **Solution / Workaround**: `resolveCanvasTokens` writes each resolved value into the node field it drives and returns the same array when nothing changed, so it can run after every token or node change without looping (`useCanvasTokens` / `createCanvasTokens` do this). A binding that does not resolve keeps the last written value; on delete, detach with `detachTokenBindings(nodes, event.previous, event.deletedVariableIds)` using the state from *before* the delete. Canvas undo is separate from token undo: undoing a token delete brings the variable back but not the detached bindings.

### [core/tokens] Alias Cycles Must Be Checked Across Every Mode, and W3C Names Cannot Be Both Token and Group

- **Issue / Symptom**: `a → b` in Light and `b → a` in Dark looked acyclic per mode, but resolving `a` with a context of another collection (or after the default mode moved) looped; exporting `color` and `color/bg` produced invalid DTCG JSON (a token with children).
- **Root Cause**: Aliases are resolved with the target's own collection mode, so a chain can switch modes part-way; DTCG distinguishes tokens (`$value`) from groups, and names map onto paths.
- **Solution / Workaround**: `checkTokenAlias` searches alias edges of all modes (refusing any cycle), `resolveToken` still guards with a visited set and reports `cycle`. Variable names refuse `.`, `{`, `}` and a leading `$` per group, and a name that is a prefix group of another (`color` vs `color/bg`) is refused with `name-conflict`.

### [core/import] PDF Column Gutters: One Stray Line Hides a Table's Column Gap, and Tolerating It Lets the Gap Leak Into a Column

- **Issue / Symptom**: An unruled table under a paragraph lost its columns (the paragraph's short last line crossed every column gap), and after tolerating a few crossing lines the header cell `Unit` was read as a separate full-width line, splitting `Meter` off the table.
- **Root Cause**: Gutters were the strips no narrow fragment covers. A strict "no coverage" rule fails on any stray crossing line; a coverage depth tolerance (`≤ 8 %` of narrow fragments) also accepts strips where one fragment merely *ends* or *starts* inside, so the strip starts inside a column and that fragment "crosses" it.
- **Solution / Workaround**: `readingOrder` in `packages/core/src/import/pdf-layout.ts` sweeps coverage depth with the tolerance, then shrinks each strip to the last fragment end and first fragment start inside it, so only fragments spanning the whole strip count as strays, and keeps it only when the strays are fewer than the fragments on either side (otherwise the "gutter" is the ragged end of one long line next to a short one). Short lines crossing gutters right above or below a grid are pulled into it (spanning header / totals rows) and peeled back to the neighbouring paragraph by `alignedTable` when they don't start on a column edge.

### [core/import] pdf.js: Bold Is Only Known After the Operator List, `constructPath` Changed in v5, and Clip Paths Look Like Rules

- **Issue / Symptom**: Every text item looked regular-weight (item `fontName` is an id like `g_d0_f2`, `styles[...].fontFamily` is usually `sans-serif`); rule extraction found nothing on pdf.js 5; every clipped cell (`re W n`) became a table border.
- **Root Cause**: `page.commonObjs.get(fontName)` (with `name`, `bold`, `black`, `italic`) only resolves once fonts are loaded, which `getOperatorList()` does; `get` throws for unresolved ids. pdf.js ≤ 4 encodes `constructPath` as `[ops, args, minMax]` followed by a paint operator; pdf.js 5 as `[paintOp, [Float32Array path], minMax]` with its own path codes. Clipping paths end with `endPath`, not a paint operator.
- **Solution / Workaround**: The adapter calls `getOperatorList()` before `getTextContent()`, checks `commonObjs.has(id)` before `get` (inside `try`), and `pdfOperatorListToRules` handles both `constructPath` forms, keeps path pieces only until a stroke/fill operator paints them (dropping them on `endPath`), and keeps filled rectangles only when they are thin bars. Pass `rulingLines: false` to skip the operator list.

### [core/import] PDF Running-Header Detection Normalises Digits, So Synthetic Fixtures Must Vary Words

- **Issue / Symptom**: A three-page test fixture lost its first body line on every page as a "running header".
- **Root Cause**: Edge rows are compared with digits replaced by `#` so `Page 3 of 9` matches `Page 4 of 9`; generated prose like `p1w0 p1w1 …` / `p2w0 p2w1 …` then normalises to the same text on every page.
- **Solution / Workaround**: Build multi-page fixtures from different words per page (not just different numbers). Real body text practically never repeats at the same page edge across half the pages. Separately, use loop-based `minOf` / `maxOf` instead of `Math.min(...values)` on per-page arrays: spreading tens of thousands of fragments overflows the call stack.

### [core/track-changes] A Move Is a Cut and a Later Paste, So It Must Be Linked Across Transactions

- **Issue / Symptom**: Cutting a paragraph and pasting it elsewhere with tracking on produced an unrelated deletion and insertion (two changes to accept or reject separately), and accepting the deletion of a whole paragraph left an empty paragraph behind. Typing right after moved text joined the move.
- **Root Cause**: ProseMirror's cut is one transaction (`uiEvent: "cut"`) and the paste another (`uiEvent: "paste"`); nothing in the paste says where the text came from, and `transformPasted` strips review marks from the pasted slice. Only a drag (`uiEvent: "drop"`) deletes and inserts in one transaction. Block boundaries are not characters, so removing a paragraph's text leaves the block. `adjacentAttributes` reuses a neighbouring change's attributes, including `moveId`.
- **Solution / Workaround**: The tracker gives a tracked cut a change of its own and remembers it (id, normalized text, author) in the plugin closure; the next user transaction clears it unless it is a paste by the same author of the same text (white space ignored) whose deletion is still in the document. Then the deletion marks get `moveId` = the cut's change id and the pasted text an insertion with the same `moveId`. A drop links its own deletion and insertion when their texts match. Both are gated by `isMove` (default `isMoveSized`: a paragraph or a sentence of two or more words, as in Word). `adjacentAttributes` skips marks with a `moveId`. When a move is resolved, a removed end that fills a whole top-level textblock deletes the block (`deleteWholeBlock`); nested blocks (list items, quotes) keep their emptied paragraph. `getEditorText` resolves documents with moves through `resolveTrackedChanges` for the same reason; `htmlToPlainText` on HTML alone cannot remove the emptied block. Limitation: moving text that is itself the destination of an earlier move by the same author really deletes it (own insertion), leaving the earlier move with only its source.

### [core/paragraph-styles] Style CSS Loses to Inline Attributes, `onCreate` Is Deferred, and Enter Handlers Race

- **Issue / Symptom**: (1) A style's alignment from the injected stylesheet did not show on paragraphs with direct alignment, and with `TextAlign.configure({ defaultAlignment: "left" })` it never showed. (2) The `<style>` element added in `onCreate` was missing right after `new Editor(...)`. (3) Implementing next-style as an Enter keymap makes it depend on extension order: it either never runs (core keymap's `splitBlock` first) or pre-empts other Enter handlers (lists, suggestion popups). (4) Heading 5 applied in an editor configured with `levels: [1, 2, 3, 4]` rendered as `<h1>`.
- **Root Cause**: (1) TextAlign renders `style="text-align: …"` inline, which beats any stylesheet rule; with a non-null default every paragraph has it. (2) TipTap emits `create` in a `setTimeout`. (3) TipTap orders keymaps by priority and then reversed extension order. (4) Heading's `renderHTML` falls back to the first configured level.
- **Solution / Workaround**: (1) Applying a style resets `textAlign` to its default (`null`), so the stylesheet's alignment shows; when the default is not `null`, the style's alignment is written to the attribute instead. (2) CSS is injected in `onBeforeCreate` and removed in `onDestroy`. (3) Next-style runs in `appendTransaction`: when a single transaction turned an empty-selection caret at the end of a styled textblock into a new empty sibling block, the new block gets the style's `next` (merged into the same undo step). Splitting mid-paragraph keeps the style (`keepOnSplit: true`). (4) `isParagraphStyleAvailable` checks the heading extension's `levels`; `setParagraphStyle` refuses and the gallery hides unavailable styles. Style values are sanitized (`safeCSSValue`) and ids restricted to `[A-Za-z][A-Za-z0-9_-]*` because both end up in a stylesheet.

### [core/mentions] A Mention Role Attribute Named `role` Would Capture Existing Entity Fields

- **Issue / Symptom**: Adding a `role` node attribute to the Mention extension made `data-role="admin"` appear on user mentions. Apps pass their whole entity (with a job-title `role` field) as suggestion props, and TipTap keeps every prop that matches a declared attribute.
- **Root Cause**: TipTap's mention `command` inserts `{ type, attrs: props }`, so any attribute name you declare picks up a same-named field from existing entity objects. Before, undeclared attributes were dropped.
- **Solution / Workaround**: The node attribute is `assetRole` (rendered as `data-role`). `extractMentionsFromDoc` reports it as `role`. Text syntax (`@fox:style`) is opt-in (`{ roles }`), because `@john:hi` already meant "mention john, then `:hi`". Only `preprocessMarkdownMentions` and `extractMentions` with `roles` set, and `findTextMentions`, read it.

### [core/generation] `generation` Must Not Import the Mention Serializers, and Recreate Must Not Re-Plan Twice

- **Issue / Symptom**: Re-exporting `findTextMentions` from `@pixerate/editor/generation` broke the entry-isolation test, which pulled ProseMirror into the generation bundle. Separately, recreating a record by re-planning the original settings in `exact` mode changed values the user never saw change: a record planned when `4k` snapped to `2k` re-snapped to `4k` once the model gained `4k`.
- **Root Cause**: `serializers/mentions.ts` imports `escapeHtml` from `plain-text.ts`, which imports ProseMirror. An exact reproduction has to start from what was sent (the planned request), not from what the user asked for.
- **Solution / Workaround**: The text-only mention helpers live in the dependency-free `serializers/mention-text.ts`, and both entries re-export them. `exact` plans the recorded planned request (any change is `setting-unsupported`). `latest` plans the recorded original settings (differences are `setting-changed`). Mentions are kept in `record.mentions` so `latest` can rebuild them. Capability hashes leave out presentation fields and `timing`, so renaming a model is not drift.

### [svelte/packaging] `import type` in a `.svelte` File Still Counts as an Entry Dependency

- **Issue / Symptom**: The Svelte entry-isolation test failed for `generation/index.js` with `@pixerate/editor/grammar` after `GenerationHistory.svelte` gained `import type { Template } from '@pixerate/editor/grammar'`. The React build of the same import passed.
- **Root Cause**: `svelte-package` ships `.svelte` sources as they are, so type-only imports stay in the published file (tsup erases them from React's JS).
- **Solution / Workaround**: In Svelte components, take types only from the entry's own core subpath. Derive the rest when needed (`type Template = NonNullable<RecreateOptions['templates']>[number]`).

### [core/image-editor] Iterated Box Blurs Must Run on Padded Lines, or a Zero-Edge Feather Loses Mass

- **Issue / Symptom**: Feathering a selection with a large radius (the three-box-pass Gaussian used above σ 8) was up to 0.18 off a direct Gaussian next to the image border; the direct kernel below σ 8 matched to 1/255.
- **Root Cause**: "Zero beyond the image" means one convolution of the zero-padded signal. Running each box pass on the clipped line throws away the coverage the previous pass spread outside the image, so every pass loses more of it at the edges.
- **Solution / Workaround**: `gaussianBlur` (`selection/modify.ts`) runs the three passes on a line padded by the passes' total radius (zeros, or replicated ends for `clamp`) and only crops at the end. The remaining difference (≤ 0.03) is the box approximation itself; `tests/image-editor-selection.test.ts` checks both regimes against a direct Gaussian and that the cost does not grow with the radius.

### [core/image-editor] Selections Are Immutable Masks Shared by History; Layer Masks Are RLE Strings

- **Issue / Symptom**: Encoding the selection into every undo snapshot made each slider commit cost O(pixels); a `Uint8Array` inside an adjustment layer did not survive the `JSON.parse(JSON.stringify(...))` copies the controller makes of layers; adding a `selection: null` or `mask: undefined` key would have changed how every existing document serializes.
- **Root Cause**: History entries are built from `serializeState()` on every recorded change, layers are deep-copied as JSON everywhere, and saved documents are compared as JSON.
- **Solution / Workaround**:
  1. `SelectionMask` objects are never mutated; every operation returns a new one, and history entries keep a reference next to the serialized state (`HistoryEntry.selection`). Only `toJSON()` run-length encodes it, and only when something is selected.
  2. `AdjustmentLayer.mask` stores the RLE string (`{ width, height, rle, density?, feather?, enabled? }`); `decodeLayerMask` / `layerMaskCoverage` decode on render behind a small LRU keyed by the string. `normalizeAdjustmentLayer` only sets `mask` when it is usable and leaves default density / feather / enabled out.
  3. The renderer's base key includes a hash of the mask (`layerMaskKey`), and `buildLayerMaskPlanes` returns `undefined` for mask-free stacks so they take the old code path.
  4. Layer masks live in natural pixels like annotations: `projectMaskCoverage` unprojects each base pixel through the same `ImageProjection` as the image (crop, rotation, flips), so never draw a mask with hand-rolled transforms.

### [react/image-editor] `useImageEditor({ image })` Reloads Whenever `image` Is a New Object

- **Issue / Symptom**: A test host doing `useImageEditor({ image: fakeImage(20, 10) })` hung the render (the test timed out on the first `act`).
- **Root Cause**: The hook reloads the source when `options.image` changes identity; `loadImage` notifies, the host re-renders, builds a new image object, and the cycle repeats.
- **Solution / Workaround**: Pass a stable `image` (a string, or an element created once outside the render). Selection tools also need pixels: a new source clears the sampled pixels, so call `controller.setSamplePixels(...)` after loading when there is no canvas (tests, workers, cross-origin images).

### [core/spreadsheet] Multiple Sheets: `document` Is the Sheet Being Worked On, and Dependency Keys Must Name Their Sheet

- **Issue / Symptom**: With several sheets, `A1` in the dependency graph meant a different cell on every sheet, so editing `Data!A1` recalculated the wrong formulas (or none), and cross-sheet cycles went undetected. Rewriting the whole controller to take a sheet argument would have touched every method.
- **Root Cause**: The controller was written for one `document` (`getCell`, spills, `evalSingleCellByKey`, table operations all read `this.document`), and graph keys were bare A1 text.
- **Solution / Workaround**: Each sheet is a runtime (`doc` plus its spill maps and saved selection). `document` and the spill maps are getters on the *current* runtime, which is the active sheet except inside `withSheet(rt, fn)`: cross-sheet reads (`resolveCell(col, row, sheet)`), recalculation and imports into another sheet switch to that sheet's runtime and back (in `finally`). Graph keys are always `SHEETID!A1` (`qualify` / `unqualify`, upper-cased, so whole-column keys become `SHEETID!A:`); spill maps keep bare keys because they are per sheet. One workbook-wide graph keeps recalculation topological across sheets. Notify bindings with the *active* sheet (`this.active.doc`), not the current one. Use sheet ids, not names, for keys, name scopes and undo entries: names change.

### [core/spreadsheet] Sheet Prefixes in Formulas: `Sheet1` Looks Like a Cell, `!=` Is an Operator

- **Issue / Symptom**: Rewriting `Sheet1:Sheet3!A1` after a rename produced `'Sheet1:End'!A1`; `=A1!=B1` and `='text'!=1` stopped parsing once `X!` became a sheet prefix; a quoted-prefix look-ahead could rescan the rest of a formula full of apostrophes from every quote.
- **Root Cause**: The lexer's cell pattern (`[A-Za-z]+\d+`) has no column limit, so it calls `Sheet1` a cell reference; Excel only quotes names that are cells within its grid (columns up to `XFD`). `!=` is this engine's alias for `<>`. `'` also starts this engine's single-quoted strings.
- **Solution / Workaround**: `sheetNameNeedsQuotes` uses a bounded cell test (1–3 letters ≤ XFD, row ≤ 1048576) plus R1C1 and boolean look-alikes. The lexer treats `X!` as a prefix only when `!` is not followed by `=`, and looks for `'name'!` at most 64 characters ahead (31-character names with doubled quotes), falling back to a string; the workbook test checks the growth ratio. Tokens carry `sheet`, `sheetEnd`, `refStart` and `end`, so `mapFormulaReferences` rewrites only the reference text after the prefix and keeps the prefix unless the result is `#REF!`.

### [core/spreadsheet] LAMBDA Needs Environment Chains, Not a Scope Stack, and Names Must Not See the Caller's Variables

- **Issue / Symptom**: With LET's scope stack, a lambda created in one LET and called inside another saw the caller's variables (`LET(k,10,f,LAMBDA(x,x+k),LET(k,1000,f(1)))` gave 1001), a defined name `=Rate*2` could pick up a LET variable named `Rate`, and runaway recursion (`Loop = LAMBDA(n, Loop(n+1))`) overflowed the JavaScript stack.
- **Root Cause**: Closures capture the environment where they are created; a stack only knows where they are called. A defined name is evaluated where it is used, but its formula belongs to the name's scope.
- **Solution / Workaround**: Variables live in linked `FormulaEnvironment`s; `FormulaLambda` keeps its creation environment (and, for sheet-scoped names, the sheet unqualified references mean), and calls install `{ params, parent: lambda.env }`. Defined names evaluate with `env = null` and a name stack that reports self-reference as `#CYCLE!`. Calls deeper than `MAX_LAMBDA_DEPTH` return `#NUM!`, and a `RangeError` from a smaller stack is caught in `evaluateWithDiagnostics` and reported as `#NUM!` too, so every save/restore of evaluator state must be in `finally`. Omitted arguments bind `''` but are recorded per environment, so `ISOMITTED(x)` is FALSE for an explicitly passed blank cell. Dependencies through names are expanded when a formula is registered (the cells a name refers to become the formula's dependencies), and any name change runs `recalculateAll`, because a new sheet-scoped name can shadow a workbook one.

### [core/spreadsheet] Defined Names Lived Only in `getWorkbook()`, So Apps Saving `onDocumentChange` Lost Them

- **Issue / Symptom**: An app that saves only the document from `onDocumentChange` (the single-sheet API, `useSpreadsheetEditor`, `createReactiveSpreadsheet`) lost every defined name on reload, and formulas using them showed `#NAME?`. `new SpreadsheetController({ document })` had nowhere to read names from.
- **Root Cause**: Names were kept in the controller's workbook-wide `this.names`, and only `getWorkbook().names` saved them. A sheet document had no field for them.
- **Solution / Workaround**: `SpreadsheetDocument.names` holds the names a sheet uses: all workbook-scoped names plus its own sheet-scoped names. `this.names` stays the source of truth. `notifyChange` (and the constructor) rewrites every live sheet document's `names` with copies (`syncDocumentNames`), so the document passed to `onDocumentChange`, `controller.document` and the bindings' copies are always current, after undo and redo too. When names are loaded from a document, any `sheetId` means "this sheet", because the sheet's id can change on load. `loadDocument` replaces that sheet's names, and also the workbook names when it is the only sheet. With several sheets, it merges the workbook names instead (the document's names win). `addSheet({ document })` only adds names that are missing. When a workbook is loaded, `workbook.names` wins and names found only in `sheets[*].names` are added (first sheet wins), so a workbook rebuilt from saved documents works. To avoid duplicating names in every sheet, `getWorkbook()` and workbook undo snapshots leave out the per-sheet copies (`withoutNames`). If they kept them, an undo could bring back stale names. The constructor makes shallow copies of `options.workbook.sheets`, so `names` is never written into the caller's objects. Without these copies, reusing those objects later (for example in `loadWorkbook`) brought back names the caller had dropped.

### [core/spreadsheet] One Edit Can Change the Conditional Look of Cells It Does Not Touch

- **Issue / Symptom**: Re-evaluating conditional formats only at the edited cell left colour scales, data bars, top-N, above-average and duplicate highlights stale in the rest of the range, and missed formula rules (`=$A1>B$1`) and cells whose formulas depend on the edited cell.
- **Root Cause**: Scales, bars, icons, top/bottom, averages and duplicates are computed from statistics over the whole applies-to range; formula rules can read any cell; and a typed value changes every dependent formula's value.
- **Solution / Workaround**: The controller records every cell key its evaluation plan visits (the edited cell, its dependents and their spilled cells) and `ConditionalFormatEngine.update(rules, changed)` re-evaluates: the whole range of statistical rules whose range contains a changed cell (dropping their cached statistics), the whole range of rules that use formulas, and only the changed cells for local rules (cell value with constants, text, blanks, errors, dates). Any other document change (structural edits, sort, undo, rule edits) re-evaluates everything. A test compares incremental and full results.

### [core/spreadsheet] Custom Validation Formulas Must See the Value Being Entered

- **Issue / Symptom**: `=COUNTIF($A$1:$A$9,A1)=1` (no duplicates) accepted a duplicate, and `=A1>10` checked the cell's old value.
- **Root Cause**: Validation runs before the input is committed, so evaluating the rule formula against the sheet reads the cell's current value.
- **Solution / Workaround**: `DataValidationSheet.evaluateFormula(formula, row, col, entered)` receives the parsed input; the controller sets a temporary `valueOverride` that `resolveCellByCoord` and `resolveRangeByCoords` return for that cell, restored in `finally`. Rule formulas (validation and conditional formatting) are written for the top-left cell of the first range and offset with `offsetFormulaReferences` for other cells, so `$` parts stay put.

### [react|svelte/spreadsheet] The Validation Alert Steals Focus, Which Blurs (and Re-commits) the Cell Editor

- **Issue / Symptom**: After a rejected Enter, the dialog took focus, the cell input's `onBlur` called `commitEditing()` again and the alert re-opened in a loop; Enter also moved the cursor down although nothing was committed.
- **Root Cause**: The cell editor commits on blur, and the grid's Enter/Tab handler always called `moveCursor` after `commitEditing`.
- **Solution / Workaround**: While `controller.validationPrompt` is set, `commitEditing` / `commitCellInput` return `{ status: 'pending' }` without doing anything. Enter/Tab only move when the result is `committed`. The dialog backdrop calls `preventDefault()` on `mousedown` so clicks don't move focus, and after `resolveValidationPrompt` the editors refocus the cell input (retry) or the grid. Unchanged input is not validated, so blurring an untouched editor never alerts.

### [svelte/spreadsheet] `{@const}` Calling a Controller Method Does Not Re-run on Controller State

- **Issue / Symptom**: Turning on "Circle invalid data" drew no circles in Svelte (React re-renders everything and showed them).
- **Root Cause**: `{@const circled = sheetState.controller.isInvalidDataCircled(r, c)}` reads only non-reactive controller state, so Svelte never re-evaluates it when the document state changes.
- **Solution / Workaround**: Compute such values in a `$derived.by` that reads `sheetState.document` first (`void sheetState.document`), e.g. the set of circled cells, and look cells up in it. The conditional-format overlay is exposed the same way (`sheetState.conditionalFormatOverlay`).

### [core/canvas] Tangent Curves Look Like Ties (or Clusters of Hits) to a Curve Boolean Engine

- **Issue / Symptom**: Uniting two externally tangent circles, or a circle touching another from inside, traced a figure-eight ring or split curves into dozens of tiny pieces; repeated split passes kept finding "new" intersections next to the touch point.
- **Root Cause**: Near a tangency the two curves stay within `epsilon` of each other over an arc of length about `√(ε·R)`, far longer than `ε`. Subdivision reports a hit for every flat sub-curve pair along it, and the vertex where they meet sits anywhere in that stretch, so the tangent directions there differ by numerical noise (`√(ε/R)` radians) and ordering the edges around the vertex by tangent angle picks an arbitrary one.
- **Solution / Workaround**: In `packages/core/src/canvas/pathops/boolean.ts`, consecutive hits of one pair between which the curves never separate by more than a few `ε` are one contact (shared end points take part in the clustering, so hits next to an existing vertex are dropped). When tangent angles at a vertex tie within `1e-3` rad, edges are ordered by the chord to a point a short way along each curve, which separates them by curvature.

### [core/canvas] Stroking With a Width Larger Than the Curvature Radius Leaves Spurious Holes

- **Issue / Symptom**: Outline Stroke of a small circle with a thick stroke (or Offset Path growing a small curved shape) left a hole in the middle that the stroke really covers.
- **Root Cause**: The inner offset of a curve turns inside out where the offset distance exceeds its radius of curvature; its loops wind the other way, so the non-zero fill of the raw outline cancels to 0 there.
- **Solution / Workaround**: After normalising, drop a face (and its descendants) when a point deep inside it is closer to the source path than the offset distance: holes when growing or stroking, islands when insetting (`dropSpurious` in `packages/core/src/canvas/pathops/stroke.ts`). The deep point must be taken in the face (the ring minus its direct children); a ring's own interior can lie inside a legitimate hole, e.g. the middle of a stroked square.

### [core/canvas] Gauss–Legendre Areas Need Both Halves

- **Issue / Symptom**: Exact Bézier areas (lines and curves) came out twice too large next to the shoelace formula.
- **Root Cause**: The area is `½ ∫ (x y′ − y x′) dt`, and mapping Gauss–Legendre nodes from `[-1, 1]` onto `[0, 1]` contributes another `½`. A line's term `x0 y1 − x1 y0` is already the integral, so it needs only the first `½`.
- **Solution / Workaround**: `segmentAreaTerm` divides the 3-point Gauss–Legendre sum (exact for the degree-5 integrand of a cubic) by 4 and the line term by 2; tests compare `bezierPathSignedArea` of rectangles and quadratics with closed forms.

### [core/extensions] TipTap Command Typings Vanish From the Published Declarations

- **Issue / Symptom**: `editor.chain().focus().toggleBold().run()` (and `toggleHeading`, `toggleBulletList`, `toggleTaskList`, `setTextAlign`, …) failed to typecheck with "Property 'toggleBold' does not exist on type 'ChainedCommands'" in the demo, and in any app that uses `createRichTextPreset` without depending on the TipTap extension packages itself. The Vite build doesn't typecheck, so it went unnoticed.
- **Root Cause**: Each extension package adds its commands by augmenting `@tiptap/core`'s `Commands` interface in its own `.d.ts`. That augmentation only applies when the consumer's TypeScript program loads that file. Core imports the extensions as runtime values, which leave no trace in the emitted declarations, and tsup's declaration bundler drops `/// <reference types="…" />` directives, so nothing pulled the packages in.
- **Solution / Workaround**: `rich-text-preset.ts` exports `RichTextPresetCommandPackages`, a type naming `typeof import("@tiptap/…")` for every package whose commands the preset installs; the bundled `.d.ts`/`.d.cts` then import those packages (resolved from core's own dependencies). Add a package there when the preset gains an extension with commands. `apps/demo` now has a `typecheck` script, so `pnpm typecheck` (run in CI) catches regressions.

### [tests] Timing Tests Flake in the Release Run Unless They Use `measureGrowth`

- **Issue / Symptom**: Release runs failed (so nothing was published) on "grows linearly" tests whose code was fine, e.g. `pdf-layout` at 10.4× against a limit of 10, `html-scan` at 31×, `mention-roles` at 20×.
- **Root Cause**: Each test timed its own sizes once or best-of-three, often for well under a millisecond. On a loaded CI runner (or with many test files in parallel) a single GC pause or descheduling dominates such a sample, so a linear function can look quadratic.
- **Solution / Workaround**: Use `measureGrowth(small, large, { limit })` (or `growthRatio(unit, run)` for repeated strings) from `packages/core/tests/helpers/growth.ts`: it repeats each sample until it takes at least 10 ms, alternates small and large, keeps the best of several runs, and retries while the ratio is at or above the limit. `tests/growth-helper.test.ts` checks it still fails real quadratic work. Prefer 4× size steps (linear ≈ 4×, quadratic ≈ 16×) and keep absolute-time limits at least 20× above the measured local time.

### [core/canvas] Animated Nodes: Render the Evaluated Frame, but Send Edits Back Through `applyDisplayChanges`

- **Issue / Symptom**: Dragging an animated node in React Flow snapped it back on the next frame. Writing the evaluated values into the stored nodes baked one frame's values into the base, so scrubbing showed wrong values afterwards. Rotating a node through `style.transform` moved it to the flow origin.
- **Root Cause**: The canvas shows `applyAnimation(nodes, time)`, but xyflow reports changes against the nodes it renders. Applying those changes to the stored nodes either loses them (the animated value wins on the next frame) or stores evaluated values. xyflow positions nodes with `transform: translate(…)` on the same element as `node.style`, so a `transform` in the style replaces it.
- **Solution / Workaround**:
  - Render `display()` / `displayNodes` and pass edits through `applyDisplayChanges(applyNodeChanges(changes, displayNodes))`. It calls `recordAnimationChanges`, which keys animated properties at the playhead (all changed properties in record mode) and restores their stored values; other changes pass through.
  - The keying is one undo step that only restores `data.animation`, merged by tag while a drag continues.
  - Rotation and scale are written to the CSS individual transform properties `style.rotate` / `style.scale`, which compose with xyflow's `transform`.
  - Run `applyAnimation` after `resolveCanvasTokens`, never before.

### [core/canvas] Keyframe Caches Keyed by Array Identity Go Stale When the Array Is Edited in Place

- **Issue / Symptom**: After `keys[0] = { ...keys[0], easing: 'hold' }`, `evaluateTrack(keys, t)` kept interpolating linearly.
- **Root Cause**: `normalizeKeyframes` (sort, drop invalid, merge duplicate times) is cached in a `WeakMap` keyed by the keyframe array so every frame does not re-sort. An in-place edit keeps the same array.
- **Solution / Workaround**: The cache stores a shallow copy of the elements and is reused only while every element is still the same object (an O(n) identity check, no sort). Editing functions always write new arrays and keyframe objects. Treat keyframe objects as immutable: mutating `k.time` in place is still not detected.

### [core/canvas] Frame Times Are Not Exact, and Keying at the Playhead Must Not Snap

- **Issue / Symptom**: A keyframe recorded at 500 ms was stored as `500.00000000000006`, so it no longer matched refs at 500. Pressing "Add keyframe" with the playhead at 250 ms keyed 233.333 ms.
- **Root Cause**: `Math.round(t / (1000 / fps)) * (1000 / fps)` is not exact in binary floating point. Snapping every keyed time to a frame moves keys the user placed deliberately.
- **Solution / Workaround**: `snapTimeToFrame` rounds its result to a microsecond, and refs compare times with `ANIMATION_TIME_EPSILON`. Only keyframe drags snap to frames, when no other target is in range. Keys at the playhead use the playhead time unchanged.

### [core/canvas] CSS Cannot Reproduce OKLab Colour Tweens or Split `x` / `y` Timing

- **Issue / Symptom**: Exported CSS animations faded colours through a different (muddier) midpoint than the canvas. When `x` and `y` had different easings, one of them followed the wrong curve.
- **Root Cause**: CSS keyframes interpolate colours in sRGB and cannot choose a space. `translate` takes both axes, and a keyframe block has one `animation-timing-function` for every property in it.
- **Solution / Workaround**: Export one `@keyframes` per CSS property, so each track keeps its own per-segment easing. Use `rotate` / `scale` / `translate` instead of a combined `transform`. Colour segments between different colours, `x` / `y` pairs whose key times or easings differ, and motion paths are sampled at `sampleFps` with linear timing and reported as `exact: false`.

### [svelte/canvas] Timeline Rows Do Not Refresh After Undo When the Nodes Are Not `$state`

- **Issue / Symptom**: In tests (and apps that keep nodes in a plain variable or store), undoing a keyframe move left the Svelte timeline showing the moved diamonds.
- **Root Cause**: The rows are a `$derived` of `animation.timelineRows()`, which reads the nodes through `getNodes()`. Undo changes the nodes without changing the controller's state snapshot (time, selection and duration are equal), so nothing reactive was read.
- **Solution / Workaround**: `createCanvasAnimation` bumps a `revision` `$state` whenever it writes the nodes (edits, undo and redo all go through its `setNodes`). `<AnimationTimeline>` and `displayNodes` read `revision`. Changes made outside the rune need a `revision` prop bump or `refresh()`.

### [react/svelte] `ReturnType` of a Generic Hook Fixes the Default Type Parameter

- **Issue / Symptom**: The demo's `useCanvasAnimation<DemoNode>(…)` result could not be passed to `<AnimationTimeline animation>`: "Two different types with this name exist, but they are unrelated."
- **Root Cause**: `type CanvasAnimation = ReturnType<typeof useCanvasAnimation>` instantiates the hook with `TNode = CanvasNode`. Methods taking or returning `TNode[]` make the result invariant in `TNode`.
- **Solution / Workaround**: Make the alias generic (`CanvasAnimation<TNode> = ReturnType<typeof useCanvasAnimation<TNode>>`, likewise `SvelteCanvasAnimation<TNode>`), and have components accept `CanvasAnimation<any>`.

### [core/tables] prosemirror-tables `deleteRow` / `deleteColumn` Say They Can Run on the Whole Table

- **Issue / Symptom**: `editor.can().deleteRow()` returned `true` in a one-row table, so the toolbar enabled "Delete row", but running it did nothing (`runTableAction` returned `false`, the command registry reported a failure).
- **Root Cause**: prosemirror-tables only checks "the selection covers every row/column" inside its `if (dispatch)` branch, so a dry run (`can()`, no `dispatch`) never sees it. `mergeCells` / `splitCell` / `goToNextCell` do check without dispatching.
- **Solution / Workaround**: `getTableActionState` checks `selectedRect(state)` itself for `deleteRow` / `deleteColumn` and returns "These are all the rows: delete the table instead." Don't trust `can()` alone for prosemirror-tables commands; test enablement by running the action, not only by asking.

### [core/tables] Table Cells Accept `block+`, So Pastes and Imports Nested Tables Inside Cells

- **Issue / Symptom**: Pasting HTML or markdown that contained a table plus other blocks, pasting a table through the rich clipboard, or importing a DOCX / PDF / HTML file while the cursor was in a table cell put a `table` inside the `tableCell`, although `insertTable` refuses to nest.
- **Root Cause**: TipTap's cell content is `block+` and `table` is in the `block` group, so the schema allows nesting. prosemirror-tables' `handlePaste` only takes over for cell selections and for slices that are nothing but a table (`pastedCells`); everything else falls through to the default paste. `RichClipboard`'s `handlePaste` runs before the table plugins and called `replaceSelection` directly, and `insertImportedDocument` used `replaceRange` at the cursor. ProseMirror content expressions cannot say "any block except table", and narrowing the schema would make existing documents with nested tables fail to load or be restructured by the parser.
- **Solution / Workaround**: `packages/core/src/extensions/table/nesting.ts`. `handleTablePasteWithoutNesting` (the `Table` extension's `tableNesting` plugin and `RichClipboard`) hands cell selections and table-only slices to prosemirror-tables' `handlePaste` (fills cells from the cursor, growing the table), and inserts other slices that contain a table after the outermost table (`insertSliceAfterTable`). `insertImportedDocument` always inserts after the table (an import never overwrites cells). The plugin's `appendTransaction` moves any table a local edit puts into a cell to after its outermost table, checking only tables that start inside the ranges the transaction changed. It skips whole-document replacements (`setContent`), undo/redo, `y-sync$`, other plugins' appended transactions (Track Changes re-inserts a deleted nested table for review) and `ALLOW_NESTED_TABLES_META`, so existing nested tables are kept. Map changed ranges with `assoc` pointing inwards and drop empty ranges: otherwise a pure deletion's empty range grows over content a later transaction re-inserts at the same position.

### [core/track-changes] Deleted Table Rows and Columns Have No Inline Text to Mark, So They Are Whole-Block Changes

- **Issue / Symptom**: With tracking on, Delete Row put the row back with its text struck through, but accepting left an empty row; Delete Column really deleted the empty cells of the column and restored only the cells with text, leaving a ragged table that `fixTables` then padded in the wrong place. Inserted rows (empty paragraphs) were not tracked at all.
- **Root Cause**: The tracker only restores deleted slices that contain inline content and only marks inserted inline content; rows, cells and tables are structure, like paragraph boundaries (see "Whole Paragraphs Have No Inline Representation").
- **Solution / Workaround**: Closed slices made only of `tableRole` nodes (table, row, cell, header cell) are tracked as whole-block operations: a deletion is re-inserted unchanged and every textblock inside gets `blockChange: { operation: "delete" }`; inserted tables/rows/cells (found by walking the step's slice, skipping open edge nodes) get `operation: "insert"`, with any insertion marks inside removed. `removeBlocks` already removes containers whose textblocks are all removed, so accepting/rejecting removes whole rows, cells or the table. Rows the same author inserted are really deleted. Merging/splitting cells (span changes plus cell deletions in one step) cannot be represented and is refused while tracking; cell attribute changes (`setCellAttribute`, column widths) are `ReplaceAroundStep`s that leave the textblocks' wrapper types unchanged, so they stay untracked. Header toggles change the wrapper type and are tracked as ordinary block changes (rejecting restores the cell type via `restoreWrappers`).

### [core/markdown] tiptap-markdown's Table Serializer Does Not Escape `|`, and Its HTML Fallback Was Escaped by Our Sanitizer

- **Issue / Symptom**: A cell containing `A|B` exported as `| A|B | 3 |`, which reads back as three cells. Tables with spans were exported as HTML containing `<colgroup><col>`, which `markdownToTipTapHtml` turned into literal `&lt;colgroup&gt;` text. Header alignment was lost.
- **Root Cause**: tiptap-markdown 0.8 writes cells with `renderInline` and its text serializer escapes markdown characters but not the pipe; it always writes `---` delimiters. TipTap's `table` `renderHTML` emits a `<colgroup>`, and `colgroup` / `col` were missing from the embedded-HTML allowlist.
- **Solution / Workaround**: The `Table` extension provides `storage.markdown.serialize` (tiptap-markdown merges it over its default and keeps the default parser): cells are rendered in place mid-line and their output is rewritten with `|` → `\|` and newlines → spaces; delimiters come from the header cells' `align`. Non-GFM tables are written as HTML (a block that parses back). `colgroup`, `col` and `colwidth` are in the sanitizer allowlist; `style` is still dropped.

### [react|svelte/tables] Toolbar Tests: `focus()` Needs `requestAnimationFrame`, and the Bubble Menu Element Is Detached

- **Issue / Symptom**: Table commands run through the command registry failed in jsdom with "requestAnimationFrame is not defined"; `document.querySelector` could not find a `TableBubbleMenu`'s toolbar; a table store test started "inside a table" before any selection was made.
- **Root Cause**: `chain().focus()` schedules with `requestAnimationFrame`, which plain JSDOM setups don't define. TipTap's `BubbleMenuView` removes its element from the DOM until tippy shows it, so a React portal or Svelte child rendered into it is not in the document. A document that starts with a table puts the initial selection in its first cell.
- **Solution / Workaround**: Polyfill `requestAnimationFrame` in tests that focus. Find bubble menu content through `editor.view.pluginViews` (`view.element`). Move the selection out of the table before asserting the "outside" state.

### [core/export] DOCX Round Trips: `<ins>` Was Not in the Sanitizer Allowlist, the Hyperlink Style Underlines, and Word Has No Change or Thread Ids

- **Issue / Symptom**: Tracked insertions imported from Word vanished as marks (only their text stayed); exported links came back underlined; one tracked change became several after export and re-import; comment threads and moves lost their link to each other.
- **Root Cause**: `sanitizeImportedHtml` stripped `<ins>` (not in `ALLOWED_HTML_TAGS`), so `ins[data-change-type]` never reached the `insertion` mark. Word marks links with the `Hyperlink` character style, whose underline the importer applied as formatting. WordprocessingML gives every `w:ins` / `w:del` element its own `w:id` and has no thread or change id: replies point at the `w14:paraId` of their parent comment's last paragraph (`commentsExtended.xml`), moves are paired only by the `w:name` of their `w:moveFromRangeStart` / `w:moveToRangeStart`, and author ids exist only in `people.xml`.
- **Solution / Workaround**: `ins` is now allowed (attributes still go through the allowlist; this also means `<ins>` in markdown renders instead of being escaped). The importer ignores the `Hyperlink` style's formatting inside hyperlinks, merges adjacent changes with the same kind, author, date and move into one change id, maps move range names to fresh move ids, attaches replies to the root of their chain, and reads author ids from `people.xml` (the export writes it unless `privacy: "strip-authors"`). Ids are regenerated on import (`createReviewId`), so comparing round trips must use bodies, authors and texts, not ids. Other limits: `Title` paragraphs come back as `<h1>` (existing import rule), headings with custom styles lose `data-style`, block-change wrappers (lists, quotes) are not exported, and dates keep whole seconds only.

### [core/export] Word Needs a Paragraph Between and After Tables, and `w:delText` Is Only for Real Deletions

- **Issue / Symptom**: Two adjacent tables merged into one in Word; a document or cell ending in a table was reported as damaged; moved-away text showed as missing.
- **Root Cause**: Word joins consecutive `w:tbl` elements, requires every `w:tc` to end with a `w:p`, and expects a paragraph before the final `w:sectPr`. Moved-away text (`w:moveFrom`) must stay in `w:t` (ECMA-376 §17.13.5.22); only `w:del` content uses `w:delText`.
- **Solution / Workaround**: The exporter writes an empty `w:p` between adjacent tables, at the end of cells that are empty or end with a table, and after a final table (which the importer reads back as an empty paragraph), and writes `w:delText` only for deletions without a `moveId`.

### [core/canvas] Component Sync Needs the Nodes From Before the Edit, and No-Op Rebuilds Must Keep Node Identity

- **Issue / Symptom**: Deciding overrides by comparing an instance layer with its main layer recorded the main's *old* value as an override whenever the main was edited before its instances were rebuilt (the instance simply had not caught up). Separately, rebuilding instances on every React Flow change re-rendered forever.
- **Root Cause**: "Differs from the main" is ambiguous on its own: it means either "the user changed the instance" or "the user changed the main". Rebuilding an instance creates new node objects even when nothing changed, so a hook that sets nodes after a sync triggers another change, and another sync.
- **Solution / Workaround**: `syncCanvasComponents(before, after)` diffs each node against its version *before the edit*: only groups that changed on an instance layer become overrides (and only while they differ from the main), while changes inside a main rebuild its instances. Rebuilt nodes that deep-equal their previous version keep their identity, so a no-op sync returns `after` itself. The controller keeps the last synced array and syncs against it; its own actions and undo / redo set that snapshot, so changes made by a rebuild are never re-read as edits.

### [core/canvas] Token-Bound Values and Component Property Values Look Like Overrides

- **Issue / Symptom**: An instance in Dark mode (its own `data.tokenModes`) would show every bound fill as overridden; binding another variable inside an instance recorded both `token.fill` and `shape.fill`. Conversely, filtering out every group a component property drives meant that typing over a property-driven label, or swapping a nested instance whose main an instance-swap property drives, recorded no override at all.
- **Root Cause**: Bound values are materialised into the nodes (see the token entry above), so a layer resolved in another mode really does differ from its main. Property values are written by the rebuild, not by the user, so they never need filtering out of user edits.
- **Solution / Workaround**: Value groups written by a node's token bindings are never overrides (found by probing `property.write` with a different value and diffing); a different binding is the override (`token.<key>`). Property values are applied during the rebuild, which the sync never re-reads as an edit, so a user edit to a property-driven layer is an override that wins over the property, as in Figma. Only `rebaseInstance` (detach, paste, restore), which compares values rather than edits, skips property-driven groups.

### [core/canvas] Variant Switches Match Layers by Name, and Text Layers Are Often Named by Their Content

- **Issue / Symptom**: Switching an instance from `State=Default` to `State=Hover` lost the text override on its label and gave the label a new id.
- **Root Cause**: Layers of two variants are different nodes, so the rebuild matches old copies to the new variant's layers by their name path (`Frame/Label`). `getLayerName` falls back to `data.label`, which for text nodes is the text itself, and that differs between variants ("Default" / "Hover").
- **Solution / Workaround**: Give layers that must match across variants (or swaps) a stable `data.name`; it wins over `data.label` for matching. Matching inside one main uses the source id first, so plain main edits never depend on names.

### [core/canvas] Removing a Variant Must Re-Point Its Instances Before Deleting It

- **Issue / Symptom**: Deleting a variant and re-pointing its instances to another variant in the same edit kept every override of the instances, including ones the two variants disagreed on (a fill that only made sense on the removed variant stuck).
- **Root Cause**: A variant switch filters overrides by diffing the old source layer (`data.componentSource`, in the old variant) against the new one. When the old variant is already gone, the source can't be found, so nothing is filtered.
- **Solution / Workaround**: `removeCanvasVariant` syncs twice: first it re-points the instances (and instance swap values) while the variant still exists, then deletes the variant's subtree. Likewise, when editing variant values (`setCanvasVariantProperties`, renames), write the explicit `data.component.variant` and the formatted name together, since a variant without `variant` falls back to parsing its name.

### [core/spreadsheet] Large Sheets: Ranges Expanded per Cell, Whole-Sheet Undo Snapshots and Quadratic Id Lookups

- **Issue / Symptom**: On a 50k-row sheet a CSV import took 23 s, loading 100 formulas over `$A$1:$A$50000` took 3.2 s and editing one of their inputs 0.8 s, and even an edit nothing depended on took ~25 ms.
- **Root Cause**: The dependency graph expanded every range into one key per cell (100 × 50k set entries), and planning scanned those lists; `rows.find((r) => r.id === …)` in `getCell` / `setCellValue` / `getCellKey` made imports O(n²) (and range reads over blank cells too); every single-cell edit serialised the whole sheet (`JSON.stringify`) for undo.
- **Solution / Workaround**: `DependencyGraph` keeps ranges whole (`SHEETID!A1:A50000`) in a per-column interval index (ported from gridcraft's `Intervals`: sorted starts plus a max-end segment tree, insertions/removals merged lazily on the next query) and a per-sheet index for ranges wider than 64 columns; `getDependents` is O(log n + k). Planning turns each distinct range into one virtual node whose edges are the planned cells inside it (binary search), so ranges shared by many formulas cost once. `getDependencies` now returns range keys (`A1:A3`, `A:`) instead of expanded cells; use `dependsOn(formula, cell)` to ask about one cell. Rows and columns are found through a validated `PositionCache` (never `find` in a per-cell path). Single-cell edits push a `cells` undo entry (the cell's previous state); `getRecalculationStats()` gives deterministic work counts for tests. Paste/import inside the grid recalculates the written cells with their dependents in one plan; when the grid grows (or for `loadWorkbook`), `recalculateAll` evaluates everything once.

### [core/spreadsheet] Spill Edges Can Close False Cycles: Blockers Don't Order, and New Input Makes Old Edges Stale

- **Issue / Symptom**: Random edit sequences left `#CYCLE!` (or skipped spills) that a full recalculation of the same workbook didn't show, e.g. an anchor blocked by a cell whose formula (indirectly) read the anchor, `A1` = `=SEQUENCE(4)` then pasting `=MAX(A2:A9)*2` into A1 and `=SEQUENCE(3)` into A2, or replacing an anchor's formula with one reading the cells it used to spill into. The old graph had the same bugs.
- **Root Cause**: A blocked anchor's edges to its blockers were ordering edges, but whether a cell blocks depends on its input, not its value. Spilled-cell → anchor edges outlive the input that made them true (a cell that now has its own formula, an anchor with a new formula) until the anchor is evaluated again, so the plan made before that sees cycles that no longer exist, and a cyclic anchor keeps its edges.
- **Solution / Workaround**: Blocker edges are only followed for propagation (`getDependents`), never for ordering or cycle detection. Writing a cell drops the spill edges it anchored and its edge to the anchor whose values it held (`dropStaleSpillEdges`). Because dropped edges lose ordering, `placeSpill` reports every spilled cell not previously linked to the anchor as a spill change, so its dependents are recalculated in the next pass. `tests/spreadsheet-recalc.test.ts` compares incremental and full recalculation on random sheets with ranges, spills, cross-sheet, 3-D and name references, pastes, undo and redo: run more seeds after changing recalculation.

### [core/spreadsheet] Per-Plan Range Cache and Blank-Skipping Ranges Are Only Safe in Narrow Cases

- **Issue / Symptom**: Caching a range's values for a whole recalculation, or leaving blank cells out of ranges, can return stale or wrong results.
- **Root Cause**: Formulas evaluated later in the same plan (or spills re-placed) change cells inside a cached range; `COUNTBLANK`, `COUNTIF(…,"")`, `INDEX`, `MATCH` and array results depend on blank positions.
- **Solution / Workaround**: The controller caches only ranges of 256+ cells, only while `runEvaluationPlan` runs and no `valueOverride` (validation) is set; evaluating a cell drops cached ranges covering its column, and any spill change drops the sheet's entries; hits return a copy. Blanks are skipped only for direct `Range` arguments of `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` (`RangeResolveOptions.skipBlanks`, a hint resolvers may ignore). Keep document order: floating-point sums depend on it.

### [react|svelte/spreadsheet] Virtualised Grid: jsdom Has No Layout, Merges Cross the Window, and Scroll-Into-View Must Not Track Scrolling

- **Issue / Symptom**: In jsdom the window computed from `clientHeight` (0) rendered no rows and `scroll` events never fired after programmatic scrolling; a merged cell whose top-left row was above the window vanished (or its `rowspan` covered the spacer); an effect that scrolled the active cell into view snapped back whenever the user scrolled away.
- **Root Cause**: jsdom does no layout (sizes are 0, no `ResizeObserver`), but it stores `scrollTop`. A merge is rendered from its top-left cell. An effect reading the viewport state re-runs on every scroll.
- **Solution / Workaround**: The core helpers (`getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell`) assume a 1200×600 viewport when the size is 0, and widen the window until no merge crosses its edges. The bindings update their viewport state directly after scrolling to the active cell, and only re-render when the window changes. The scroll-into-view effect depends only on the active cell and the mode (`untrack` in Svelte, refs in React). Frozen rows/columns are rendered before the spacers so sticky offsets still work; group rows get the same spacer cells as body rows (`leadingColumns`, `leftSpace`, `rightSpace`). Small sheets (≤ 200 rows, ≤ 60 columns) render every cell, so existing DOM tests are unchanged. Browser automation must press keys (not `insertText`) to type into the grid.

### [react/svelte spreadsheet] Scrolled Rows Show Through Frozen Rows in a Collapsed-Border Table

- **Issue / Symptom**: With frozen rows and a sheet scrolled far down (e.g. the demo's 10,000-row "Large" sheet), thin slivers of the scrolling rows' text appeared along the top of every frozen row. Hit-testing showed no gap; hiding the scrolled rows made the slivers disappear.
- **Root Cause**: The grid `<table>` used `border-collapse: collapse` with the row separator on the `<tr>` (`border-b`). In the collapsing border model the shared borders belong to the table grid, not the cells, so when frozen cells are `position: sticky` their backgrounds don't cover the border band and the browser paints the rows scrolled underneath through it.
- **Solution / Workaround**: The table uses `border-separate border-spacing-0`, and the row separator is drawn on the cells (`[&>*>tr:not([data-spacer])>*]:border-b`; spacer rows get none so the virtual-scroll heights stay exact). Don't switch the grid back to `border-collapse` while frozen panes are sticky cells. Consumers' Tailwind must scan the package sources (as for every other class the components use) for the arbitrary variant to compile.

### [core/tools] The Tool Registry Lives in `/tools` So Non-Text Hosts Don't Need TipTap

- **Issue / Symptom**: A host that only wanted `ToolRegistry` (an effect editor exposing `createCommandToolProvider`, a canvas-only or spreadsheet-only app) had to install `@tiptap/core`, `@tiptap/pm` and `@dagrejs/dagre`, because importing `@pixerate/editor/agent` loads them. Consumers worked around it by copying `callTool` / `toolDefinitions` helpers or importing the tool types from `/generation`.
- **Root Cause**: `/agent` re-exports `providers.ts`, which imports `@tiptap/core` and `@tiptap/pm/state` at load time for `createRichTextToolProvider`, and `planner.ts`, which imports `canvas/layout.ts` (dagre). The registry itself depends on none of them.
- **Solution / Workaround**: The registry, the JSON Schema validator and the static MCP tool definitions live in `src/tools/` and ship as `@pixerate/editor/tools`; `/agent` re-exports `../tools/index.js` so existing imports keep working. Dependency-free modules (`commands`, `generation`, `image-editor`) import from `../tools/*.js`, never from `../agent/*`. Anything that needs TipTap or the planner (including `createEditorMcpToolProvider`, whose `layout` operation runs dagre) stays in `/agent`. `tests/entry-isolation.test.ts` fails if `tools/index.js` or `tools/index.cjs` reaches any third-party package.

### [core/animation] The `/animation` Entry Must Not Reach Canvas Code, and tsup Chunks Can Pull It In Silently

- **Issue / Symptom**: Keyframe evaluation used to live under `src/canvas/animation/`, so the only way to get `evaluateTrack` or `AnimationPlayer` was `@pixerate/editor/canvas`, which statically imports the optional `@dagrejs/dagre` peer.
- **Root Cause**: The node-independent parts (easing, OKLab colour, keyframes, `evaluateTrack`, player, clock) shared files with node code (`model.ts` / `evaluate.ts` import `CanvasNode`, `arrange`, `tokenBindings`). With `splitting: true`, one stray import from `src/animation/` into `src/canvas/` would put canvas code (and dagre) into a chunk the `/animation` entry loads, with no type error.
- **Solution / Workaround**: The node-independent code lives in `src/animation/` and imports nothing from `src/canvas/` (only `src/tokens/color.ts`). `src/canvas/clock.ts` and `src/canvas/animation/{easing,color,player}.ts` are one-line re-exports, and the canvas `model.ts` / `evaluate.ts` re-export the keyframe types and `evaluateTrack`, so `/canvas` still exports the same bindings. `tests/entry-isolation.test.ts` checks the built `dist/animation/index.js` reaches no packages; `tests/animation-entry.test.ts` checks `/canvas` re-exports the same functions and that nothing node-specific leaked into `/animation`. Add new node-independent helpers to `src/animation/`, never the other way round.

### [svelte] A Variable Named `state` Turns `$state(...)` Into a Store Subscription

- **Issue / Symptom**: `svelte-check` reports `Block-scoped variable '$state' used before its declaration` and `Cannot use 'state' as a store` in a component that declares `let state = $state.raw(...)` (for example a `ParametersState` snapshot).
- **Root Cause**: In a `.svelte` file, `$name` means "subscribe to the store `name`" whenever a variable called `name` is in scope. Declaring `state` makes the compiler read `$state` as a store reference instead of the rune.
- **Solution / Workaround**: Never name a component-level variable `state` (or `derived`, `effect`, `props`). The parameters panel keeps its snapshot in `view`. Props named `state` are fine only in components that use no `$state` rune.

### [core/commands] A Command's `params` Can Be a Getter, but Only While the Spec Is Not Spread

- **Issue / Symptom**: The JSON Schema agents see for `parameters.set` must follow the parameter schema, which changes with `ParametersController.setSchema`, but `CommandSpec.params` is a plain property read by `list()` and validated on every `execute()`.
- **Root Cause**: `CommandRegistry` stores the spec object as given and reads `spec.params` each time, so a getter works. Spreading the spec (`{ ...spec, scope }`) evaluates the getter once and freezes the schema.
- **Solution / Workaround**: Define `params` with `get params() { … }` on the object literal that is registered, and add shared fields (`group`, `scope`) by spreading them *into* that literal, not by spreading the spec into a new object. Note the registry validates params against this schema before `run`, so range and enum errors come back as `invalid_params` with `validateJsonSchema` wording (`/values/speed Must be <= 4.`); only checks the JSON Schema cannot express (vector component bounds, text patterns) reach the controller's sentence errors.

### [core/parameters] Command `execute` Runs Before `HistoryManager` Records the Step

- **Issue / Symptom**: A store that rebuilds its snapshot inside a history command's `execute` / `undo` reports stale `canUndo` / `canRedo` / `undoLabel` (the undo button stays disabled after the first edit).
- **Root Cause**: `HistoryManager.execute` calls `command.execute()` first and only then pushes the step and notifies; `undo` / `redo` likewise notify after the closure ran.
- **Solution / Workaround**: Notify from the command (so values update immediately) and also subscribe to the history, re-notifying only when the undo / redo fields actually changed. `ParametersController` does both, which keeps one snapshot per edit in the common case and never leaves the history fields stale.

### [core/animation] Parametric Elastic Easing Boundary Guarantees and Sampling

- **Issue / Symptom**: Parametric damped harmonic oscillators ($e^{-\lambda t} \cos(\omega t)$) used for elastic animations can drift from boundary conditions due to floating point inaccuracies, resulting in jumps at $t = 0$ or $t = 1$. Furthermore, CSS transitions cannot natively parse parameterised spring/elastic curves like `cubic-bezier`.
- **Root Cause**: When computing $t = 0$ or $t = 1$, damped sine/cosine equations evaluate to fractional residuals ($1 \pm \epsilon$) unless strictly bounded. Additionally, CSS transitions require standard cubic beziers or modern CSS `linear(...)` piecewise approximations.
- **Solution / Workaround**: In `elasticAt`, clamp boundary evaluations explicitly ($t \le 0 \to 0$, $t \ge 1 \to 1$). In `easingToCss`, sample elastic curves over discrete intervals (e.g. 20 samples) to generate a standards-compliant CSS `linear(...)` function for performant GPU rendering.

### [core/parameters] Range Mapper Degenerate Interval Safeguards

- **Issue / Symptom**: Passing identical bounds for the input range (`from: [v, v]`) to `createRangeMapper` or `mapRange` produces `NaN` or `Infinity` upon interpolation.
- **Root Cause**: The domain normalization formula $(value - inMin) / (inMax - inMin)$ results in division by zero ($0 / 0 = NaN$) when $inMin == inMax$.
- **Solution / Workaround**: Check for degenerate intervals (`inSpan === 0`). When degenerate, bypass division and return the lower target bound (`toMin`), preserving safety and avoiding cascading `NaN`s in downstream transform math.

### [react/dependencies] Peer Dependency Range Alignment with Sibling Pixerate Packages

- **Issue / Symptom**: Installing `@pixerate/editor-react` alongside `@pixerate/flair@0.13.0` or sibling ecosystem packages triggers `npm ERR! code ERESOLVE` peer dependency collision errors on clean `npm install`.
- **Root Cause**: `@pixerate/flair@0.13.0` declares `peerDependencies: { "@pixerate/editor": ">=0.29.0 <1" }`, while `@pixerate/editor-react` previously kept `@pixerate/editor` under direct `dependencies` pinned to an exact version (`workspace:*` resolving to `0.27.0` or `0.29.0`), causing npm's strict peer dependency resolver to detect conflicting version constraints.
- **Solution / Workaround**: Move `@pixerate/editor` to `peerDependencies` with the ecosystem-aligned range `">=0.29.0 <1"` in `@pixerate/editor-react` (paired with `devDependencies: { "@pixerate/editor": "workspace:*" }` for local monorepo builds and tests) and omit it from direct `dependencies`.

### [core/canvas] Freehand Eraser Gesture Undo Snapshot Preservation

- **Issue / Symptom**: Dragging an eraser across multiple nodes and subsequently executing undo either restored erased strokes out of order (distorting z-index ordering) or failed to restore earlier nodes in the same drag stroke when batching deletions.
- **Root Cause**: If each node erasure removes the node dynamically or splices indices step-by-step without a baseline snapshot, undoing the compound command by re-inserting elements or reversing individual removals drifts relative to remaining nodes or fails to preserve original sibling ordering.
- **Solution / Workaround**: In `createCanvasDrawController`, capture `dragStartNodes = [...options.getNodes()]` upon `startStroke` when `tool === 'eraser'`. During `endStroke`, if any nodes were deleted, register a single history command whose `undo` action restores the exact pre-drag snapshot (`options.setNodes(dragStartNodes)`), ensuring absolute fidelity of node list order, layer hierarchy, and z-indexes across continuous eraser sweeps.

### [changesets/release] Peer Dependency Range Assertions in Package Tests

- **Issue / Symptom**: The `Release` workflow fails at the `pnpm test` step after `pnpm version-packages` (`changeset version`), with an assertion error such as `expected '>=0.30.0 <1.0.0-0' to be '>=0.29.0 <1'`.
- **Root Cause**: `@changesets/cli` automatically synchronizes and bumps `peerDependencies` across monorepo workspace packages when a core package version increments. Any unit tests asserting strict exact string equality against a static version string fail as soon as Changeset bumps the package in the release pipeline.
- **Solution / Workaround**: Test package.json `peerDependencies` using regex patterns that accommodate dynamic minor/patch version increases (e.g. `expect(pkg.peerDependencies["@pixerate/editor"]).toMatch(/^>=0\.\d+\.0.*<1/)`) while still enforcing exclusion from direct `dependencies`.


### [react|svelte/canvas] Pointer-Events and Spacebar Panning in Freehand Drawing Overlays

- **Issue / Symptom**: When an interactive SVG drawing overlay (`CanvasDrawLayer`) covers the canvas, standard xyflow panning, node dragging, and canvas selection are blocked. Conversely, if pointer events are disabled, drawing gestures cannot be captured. Furthermore, users cannot pan the canvas without first switching away from the drawing tool.
- **Root Cause**: An overlay with `pointer-events: auto` intercepts all pointer gestures before they reach React Flow or Svelte Flow's pane and node layers.
- **Solution / Workaround**:
  1. Set `pointer-events: auto` on `CanvasDrawLayer` only when `tool !== 'select'`. When `tool === 'select'`, set `pointer-events: none` to let xyflow handle selection, dragging, and box selection natively.
  2. Implement spacebar hold detection (`isSpacePressed` via `keydown` / `keyup`). While spacebar is held down, toggle the overlay's pointer events to `none` and switch the cursor to `grab`, allowing users to hold Space and drag to pan the xyflow canvas seamlessly without changing their active drawing tool.



### [core/vector] Live Corners Vanish When an Anchor Is Copied Field by Field

- **Issue / Symptom**: A rounded corner turns sharp after moving, scaling, reversing or pasting a path, with no error.
- **Root Cause**: The radius lives on the anchor (`anchor.corner`), and several helpers build anchor copies by hand (`{ x, y, in, out, type }`), so any copy that lists the fields drops it.
- **Solution / Workaround**: Copy anchors with `cloneAnchor`, or add `...(a.corner ? { corner: { ...a.corner } } : {})` to hand-built copies (`bakeIntoGeometry`, `reverseSubpath`, `curvatureMoveAnchor`, `subpathsIn` do). Tests in `vector-corners-strokes.test.ts` move, scale, rotate and paste a rounded path.

### [core/vector] `subpathsToBezier` Draws Live Corners, So Its Segments No Longer Match the Anchors

- **Issue / Symptom**: Code that walks the Bézier commands of a path and maps segment `i` back to anchor `i` gets the wrong segment (or one too many) on a path with corner radii.
- **Root Cause**: `subpathsToBezier` runs `expandVectorCorners`, the one place live corners are cut; a cut corner adds an anchor and trims both neighbouring segments.
- **Solution / Workaround**: Use `subpathSegment(sp, i)` / `nearestSegment` for anchor-indexed segments, or `subpathsToBezier(subpaths, { corners: false })` for the sharp outline. `expandVectorCornersOf` also returns `sources`, the stored anchor each drawn anchor came from.

### [core/vector] One Cubic per Corner Cut Loses Accuracy at Sharp Angles

- **Issue / Symptom**: The round cut of a very acute corner (a star's tip) is visibly not quite circular when zoomed far in.
- **Root Cause**: A cubic arc's radial error grows with roughly the sixth power of the angle it turns through: about 0.03 % of the radius for a 90° turn, about 0.6 % for the 150° turn of a 30° corner.
- **Solution / Workaround**: Acceptable for drawing (figcraft does the same); the tests assert < 1 % at 30°. If an exact arc ever matters, split cuts turning more than 90° into two cubics in `cutCorner`.

### [core|react|svelte/vector] Clip Paths and Masks for Aligned Strokes Need Node-Local Coordinates and Explicit Mask Bounds

- **Issue / Symptom**: An inside / outside stroke is clipped in the wrong place on rotated nodes, or an outside stroke (and its arrowheads) is cropped at the shape's bounding box.
- **Root Cause**: `clipPathUnits` / `maskContentUnits` default to `userSpaceOnUse`, which is the user space of the *referencing* element, transform included, so the clip shape must use the node's own coordinates (the same `d` as the fill), not document ones. A `<mask>` without `maskUnits="userSpaceOnUse"` and a box covers only the object's bounding box plus 10 %, which cuts a wide outside stroke.
- **Solution / Workaround**: `vectorStrokeSvgParts` returns `clip.bounds` (the outline's bounds padded by `vectorStrokeReach`) and both canvases and the SVG export write `<mask maskUnits="userSpaceOnUse" x y width height>` with a white rect and the shape in black, inside the node's own `<g transform>`. Ids come from the canvas `idPrefix`, so two canvases on a page don't share clips.

### [core/vector] `render.ts` and `svg.ts` Import Each Other's Module Graph

- **Issue / Symptom**: Moving a render helper that the SVG exporter needs into `render.ts` creates an import cycle (`svg.ts → render.ts → controller.ts → svg.ts`).
- **Root Cause**: `render.ts` already imports `vectorPaintToSvg` from `svg.ts`, and the controller imports `svg.ts` for `toSvg` / `loadSvg`.
- **Solution / Workaround**: Keep helpers both need in `svg.ts` (or lower: `stroke.ts`, `corners.ts`, `geometry.ts`), e.g. `vectorStrokeSvgParts` and the `VectorRenderStrokeParts` type, and import them into `render.ts`. `stroke.ts` and `corners.ts` import only path ops and types, so `geometry.ts` can use them.

### [core/vector] Width Handles Only Hit-Test on Paths the Overlay Already Shows

- **Issue / Symptom**: A width-tool press or double-click on a width point added a new point (or opened the editor on a stroke spot) instead of grabbing the existing one, when no pointer move had hovered the path first (tests, touch, a double-click straight after a tool switch).
- **Root Cause**: `getVectorWidthHandles` lists the points of the hovered, selected and dragged paths only, and `hitWidthHandle` searched that list.
- **Solution / Workaround**: `hitWidthHandle` falls back to the points of the stroke under the pointer (`strokeSpotAt`) when the shown ones miss. Keep any new width gesture going through it rather than `getVectorWidthHandles(state)` directly.

### [core/vector] Moving Several Width Points Re-Sorts the Profile and Renumbers Them

- **Issue / Symptom**: After a multi-point move (or a copy, or `setWidthPoint` with a new `t`) the selection pointed at the wrong points, or a step's two halves swapped.
- **Root Cause**: Width points are addressed by index into a profile kept sorted by `t`; a group move or a copy can pass other points. `setWidthPoint` from `width.ts` clamps a single point between its neighbours to keep indices stable, but group moves and the numeric editor deliberately don't.
- **Solution / Workaround**: Sort stably with the old index as the tie-break and carry an old → new map (`shiftWidthPoints` in `controller.ts`, `drag.renumber`); insert copies and moved points with `insertWidthPoint(…, { step: true })` and use the returned index. Undo restores the profile but not the selection, so `restore` drops selected refs whose index no longer exists and closes the width-point editor.

### [react|svelte/vector] HTML Inside the Canvas `<svg>` Must Stop Its Events

- **Issue / Symptom**: Typing Delete in the width-point editor deleted width points, clicking it started a width drag, and copying from its inputs copied the drawing.
- **Root Cause**: The editor lives in a `<foreignObject>` inside the canvas `<svg>`, whose `pointerdown` (focus + pointer capture), `keydown`, `dblclick` and clipboard handlers see every bubbling event. `isVectorTextTarget` only covers keys typed into text fields, not buttons.
- **Solution / Workaround**: `VectorWidthPointEditor` stops propagation of pointer, double-click, key and clipboard events on its `<form>` (Svelte's delegated handlers honour `stopPropagation` too) and hands focus back to the closest `<svg>` when it closes.

### [core/vector] Shape Builder Edges Run Between Junctions, Not Anchors, and Cutting One Flattens Live Corners

- **Issue / Symptom**: Alt-erasing what looks like one side of a rectangle can take two sides (and the corner between them); a cut path loses its live corner radii; and a filled open path's erased edge can bring back its invisible closing segment.
- **Root Cause**: `PlanarMap.chains()` only breaks a run where other paths meet it (or it ends), so a corner inside another shape is mid-edge. The edges are cut out of the document-space outline from `vectorPathWorldBezier`, which already has live corners cut into curves. A filled open subpath that encloses an area is closed in the map, so its edges may run over the closing segment.
- **Solution / Workaround**: Pick test points and expectations by junctions, not anchors. `cutOutPiece` treats filled open subpaths as rings with an invisible closing span (`real..len`) and stops kept runs at it, so it never becomes a visible segment. The cut result is mapped back through the inverse of the node's matrix and written with `bezierToSubpaths`, keeping the node's transform; the corner radii are not kept. `VectorShapeBuilderMap.edges` is a lazy getter: spreading the map evaluates it, so pass the map itself around.

### [tests] `randomize()` Tests Flake When the Random Value Lands on the Default

- **Issue / Symptom**: The React and Svelte parameters binding tests occasionally failed in CI at `expect(state.modified).toBe(true)` right after `randomize(["speed"])`.
- **Root Cause**: The controller used `Math.random`, and the field snaps to its step: any draw in about [0.2375, 0.2625) gives back the default `speed` of 1, so nothing is modified (about a 1 in 40 chance).
- **Solution / Workaround**: Give the controller a fixed source in tests (`new ParametersController({ schema, random: () => 0.75 })`) or call `randomize({ seed })`, and assert the value it picks. Never assert a change after an unseeded randomize.

### [core/vector] Picking a Morph's Start Anchor by Position Squashes Turned Shapes

- **Issue / Symptom**: Blending a horizontal bar into the same bar turned 90° gave a middle step that was a fat square (area up a third) instead of the bar half turned, even with the Procrustes in-between.
- **Root Cause**: effectcraft's `correspond` scores each cyclic start by how far corresponding anchors are apart once both shapes are centred and scaled. That cost is not rotation-invariant: the start that pairs each corner with the nearest one (a squash) beats the one that pairs it with the turned corner, and Procrustes then finds no rotation to follow. Its absolute-angle shape-context histograms push the same way.
- **Solution / Workaround**: `bestStart` in `vector/blend.ts` scores what is left after the best-fit rotation and scale (`1 − (dot² + cross²) / n²` on unit-RMS point sets, O(n) per start), plus `0.1 · (1 − cos θ)` so the least turning wins among equal fits (circles, squares), plus shape contexts whose angles are measured from the contour's direction (rotation-invariant).

### [core/vector] Largest-Remainder Anchor Allocation Must Treat Rounding Noise as a Tie

- **Issue / Symptom**: A star and the same star turned did not keep their area through a blend: the in-betweens came out slightly distorted.
- **Root Cause**: When a contour's segments all have the same length, the fractional parts of their anchor shares differ only by floating-point noise, and that noise — different for the turned copy — decided which segments got the extra anchors. The two shapes were refined differently, so no start lined them up exactly.
- **Solution / Workaround**: `refineMorphContour` sorts remainders with a 1e-9 tolerance and breaks ties by segment index, so congruent shapes are split alike.

### [core/vector] `mapTree` Visits the Node It Just Returned

- **Issue / Symptom**: Adding a shape to a blend with `mapTree(nodes, (n) => n.id === key ? null : n.id === blend ? { ...blend, children: [...children, key] } : n)` reported success, but the key vanished from the document.
- **Root Cause**: The controller's `mapTree` recurses into the children of whatever the callback returns, so the moved key was found inside the new group and removed again.
- **Solution / Workaround**: Remove first, then insert with `spliceTree` (or any pass that does not re-run the callback on its own output).

### [core/vector] Blend Steps Are Rebuilt in `notify()` and `commit()`, Keyed by Key Identity

- **Issue / Symptom**: A live blend has to follow every edit of its keys (drags included) without each tool knowing about blends, and undo must restore steps that match the keys.
- **Root Cause**: Steps are derived data stored in the document (so the scene, bounds, hit-tests and SVG export see them), and the controller mutates `this.doc` in many places.
- **Solution / Workaround**: `refreshVectorBlends` runs on the document in `notify()` (live during drags) and at the start of `commit()` (so history snapshots hold the refreshed document). It returns the same objects when nothing changed: generated children are cached per first key and reused while the keys are the same objects and the blend options serialise the same, and morph correspondences are cached per key pair. Steps are locked (`locked: true`) so the select tool picks the blend group and the direct tool only reaches keys; transforms of the group bake its replaced spine with the children (`bakeIntoGeometry`).

### [core/vector] Expanded Appearance Paths Have Ids That Are Not in the Document

- **Issue / Symptom**: After path effects and live booleans were routed through `vectorPathEntries`, the Pathfinder and `booleanOp` failed to put their result back: `findVectorNode([root], entry.node.id)` found nothing, so the result replaced no node.
- **Root Cause**: `expandVectorAppearance` turns a node drawing several shapes (a repeater, a live group) into a group of paths with ids `<id>~fx<n>`. Those are derived nodes, never stored; only the top node keeps its stored id.
- **Solution / Workaround**: Look entries up through the expanded tree as well (`controller.holds(rootId, id)` checks `findVectorNode` on the node and on `expandVectorAppearance(node)`), drop the roots by their stored ids, and give derived nodes fresh ids before storing them (Expand Appearance does). Code that edits the shapes it reads (the Shape Builder) must ask for the stored geometry with `vectorPathEntries(doc, roots, { expand: false })`.

### [core/vector] Merged Undo Steps Need the Command's `tag` Equal to Its Gesture Key

- **Issue / Symptom**: A slider drag committed with `history.executeMerged(command, { key })` folded into one undo step, but the step kept growing: every move added another undo / redo part.
- **Root Cause**: `HistoryManager.executeMerged` only replaces the top step's last part ("the same absolute command again") when the new command's `tag` equals that part's tag; otherwise it appends a part.
- **Solution / Workaround**: The controller's `commit(name, before, merge)` sets `tag: merge` on the snapshot command, so the step keeps the pre-drag `before` and only the latest `after`. Ending the drag calls `endMergedEdit()` (`history.endGesture()`) so the next drag of the same control starts a new step.

### [core/vector] Wiggle's Hash Needs Exact 64-bit Arithmetic

- **Issue / Symptom**: A wiggle ported with JavaScript numbers gave different (and less random) noise than the source, and lost precision past 2⁵³.
- **Root Cause**: effectcraft's `splitmix` / `hash` rely on wrapping `u64` multiplication and shifts; `Math.imul` is 32-bit and doubles lose the low bits.
- **Solution / Workaround**: `pathEffects.ts` runs `splitmix` on `BigInt`s masked to 64 bits (`BigInt.asUintN(64, …)` for negative lattice indices) and converts only the final `h >> 11` to a number. It is called a few thousand times per wiggle, which is cheap; results are cached per node anyway.

### [core|react/vector] StrictMode's Double Effect Destroys the Controller `useVectorEditorController` Keeps

- **Issue / Symptom**: In the dev demo (React StrictMode) the toolbar's History buttons lagged one step: after an edit Undo stayed disabled, after an undo Redo stayed disabled — though `controller.getState()` was right whenever it was next read.
- **Root Cause**: `useVectorEditorController` creates the controller once in a ref and calls `controller.destroy()` in an effect cleanup. StrictMode runs effects, cleans them up and runs them again, so `destroy()` dropped the controller's history subscription while the same controller stayed in use. History-only changes (labels, `canUndo`/`canRedo`) then reached the UI only with the next document change.
- **Solution / Workaround**: The controller's history connection is idempotent (`connect()`), made in the constructor and again on every `subscribe()`, catching up on history changes missed while disconnected. StrictMode's re-run of `useSyncExternalStore`'s subscribe effect reconnects it. Any core controller whose `destroy()` a React hook calls from a ref-kept instance needs the same treatment (or must be created inside the effect).

### [core/vector] `objectBoundingBox` Gradients Paint Nothing on a Straight Line

- **Issue / Symptom**: A gradient stroke on a horizontal or vertical line (or a stroke part drawn on a different element than the fill) disappears or shifts.
- **Root Cause**: SVG maps `objectBoundingBox` gradients onto the painted element's own geometry box; a box with no height (or width) is singular, so browsers paint nothing, and each element of a stroke drawn in parts has its own box.
- **Solution / Workaround**: The vector editor writes every gradient in `userSpaceOnUse` with the shape's box as the `gradientTransform` (`vectorBoxMatrix`), computed once per node from its outline, and a side with no extent takes the other side's (centred). Fill, stroke parts and effect copies then share one frame.

### [core/vector] A Linear Gradient's t Is a Projection, Not a Frame Coordinate

- **Issue / Symptom**: A `userSpaceOnUse` linear gradient on a sheared shape exported to SVG paints at the wrong angle, though the editor's own sampling is right.
- **Root Cause**: The model measures t as the u coordinate in the start / end / width frame (exact under any affine map), but SVG's `x1 y1 x2 y2` measures the projection onto x1 → x2, which only agrees while the width axis is square to the main axis.
- **Solution / Workaround**: `vectorGradientSvgDefs` writes `x1 y1 x2 y2` when the frame is square and `x1=0 x2=1` with the frame as `gradientTransform` otherwise. Keep that check if the export changes.

### [core/vector] Adaptive Stop Expansion Must Probe Near the Ends of Each Piece

- **Issue / Symptom**: Oklab or linear-light gradients exported as stops were off by two colour levels just after a stop whose colour has a zero channel.
- **Root Cause**: Converting back to sRGB applies the gamma curve, whose slope is steepest next to 0, so the error of a straight piece peaks close to its end; checking only the quarter points missed it.
- **Solution / Workaround**: `expandVectorGradientStops` checks each piece at 3 %, 10 %, 25 %, 50 %, 75 %, 90 % and 97 % before accepting it. The tests compare 2000 samples against the true ramp.

### [core/vector] Gradient Samples on a Period's Edge or a Conic Centre Are Ambiguous

- **Issue / Symptom**: Tests comparing a `repeat` gradient (or a conic one) with its exported paint server fail at a few grid points with a completely different colour.
- **Root Cause**: At t exactly on a whole number, `repeat` gives 0 or 1 depending on rounding (the first or last stop), and a conic gradient's angle is undefined at its centre and jumps at its seam.
- **Solution / Workaround**: Skip sample points within 1e-4 of a period edge, the centre and the seam; anywhere else the paint server must match the model within 2 / 255. The canvases' checkerboard is also a `<pattern>`: select a gradient pattern by its id (`pattern[id$="fill-a"]`), not by tag.

### [core|react|svelte/vector] Pattern Content Starts at the Tile's Corner

- **Issue / Symptom**: Conic and diamond fills (patterns of gradient tiles) drew nothing, or the wrong part of the sweep, in the browser although every `<pattern>`, tile and gradient was there.
- **Root Cause**: Without a `viewBox`, an SVG `<pattern>`'s content coordinate system has its origin at the tile's `(x, y)`, not at the user-space origin, so content written in user space was shifted by the tile's position (outside the tile).
- **Solution / Workaround**: `patternAttrs` gives every pattern a `viewBox` equal to its tile (`x y width height`), which maps content coordinates one to one onto the user space. Keep it when rendering `VectorSvgPatternDef.attrs`.

### [core/vector] Warp Meshes Must Extrapolate Outside Their Box

- **Issue / Symptom**: Curved shapes under an envelope gained far more anchors than straight ones and came out lumpy near the box edges, although the warp itself was smooth.
- **Root Cause**: The envelope's box is the paths' tight curve bounds, so Bézier handles routinely lie outside it. The ported `locate` clamped the box fraction to 0–1, which squashed every handle outside the box onto the border; the adaptive mapper then saw the mapped control polygon stray from the mapped curve and kept splitting.
- **Solution / Workaround**: `locate` in `warp.ts` no longer clamps: outside 0–1 the end patches' polynomials simply continue, so handles past the box map smoothly. Callers that need a point on the surface (`vectorMeshParamAt`) clamp their own parameters.

### [react|svelte/vector] Two Panels Editing One Effect Collide on Their Labels

- **Issue / Symptom**: After switching an envelope to Mesh, tests still found the "Envelope Bend % slider" the Envelope panel had just hidden.
- **Root Cause**: The generic Effects panel builds a control per entry of `VECTOR_EFFECT_PARAM_SPECS` and labels it `${effect label} ${param label}`, so it rendered the envelope's bend, distortion, orientation and mesh-size controls with exactly the Envelope panel's labels, regardless of the style.
- **Solution / Workaround**: `getVectorEffectsPanel` returns no `specs` for an envelope (it still lists it to toggle, reorder and remove); `VectorEnvelopePanel` edits it. The specs stay in `VECTOR_EFFECT_PARAM_SPECS` because `normalizeVectorEffectParams` validates against them.

### [core/vector] Free Distort Takes Over Mod on the Selection Box

- **Issue / Symptom**: Mod-dragging a box handle normally scales without snapping; in Free Distort mode it skews (sides) or, with Shift+Alt, makes a symmetric perspective (corners).
- **Root Cause**: Illustrator's Free Transform modifiers (Cmd on a side shears, Cmd+Alt+Shift on a corner is perspective) clash with the editor's "hold Mod to bypass snapping".
- **Solution / Workaround**: The distort modifiers apply only while `state.freeDistort` is on (the toolbar's Distort toggle); out of that mode the box scales as before. Distort drags never snap.

### [core/agent] Agents Can't Turn Plain Text into ProseMirror Positions

- **Issue / Symptom**: An agent read the document with `get_text`, counted characters to the word it wanted, and called `insert_text { at }`. The text landed a few characters off, more so further down the document.
- **Root Cause**: Editing tools take ProseMirror document positions. Each block boundary adds positions that don't exist in the plain text (`<p>a</p><p>b</p>`: "b" is at 4, not at offset 2), and inline nodes count as one position. Plain-text offsets and document positions only agree at the start of the first paragraph.
- **Solution / Workaround**: Never ask a model to compute positions. `find_text` returns `{from, to}` for each match, and `get_text { blocks: true }` returns each textblock's `from`/`to`. Edits by content go through `replace_text`, which searches and replaces in one transaction (last match first, so earlier positions stay valid). Any new tool that takes positions must have a read tool that returns them.

### [core/agent] The Planner Is Lenient, So Tool Providers Must Validate First

- **Issue / Symptom**: `edit_canvas { operation: "remove_nodes", nodeIds: ["typo"] }` reported `applied: 1`, and nothing happened. An added node without an id got a generated id the agent never saw, so its next `connect` call used a made-up id.
- **Root Cause**: `planAgentCommand` is built for UI choreography. It falls back instead of failing (unknown anchor → place beside the last node) and plans steps for ids that don't exist, leaving `applySteps` to ignore them. The provider returned only step types.
- **Solution / Workaround**: `createEditorMcpToolProvider` runs `validateAgentCommand(command, snapshot)` before planning. Unknown ids, an id that already exists, self-edges and unordered ranges come back as tool errors naming the bad id. Results include `created: { nodes, edges }` with the generated ids. Hosts that call the planner directly should call `validateAgentCommand` too. Prompt positions are host-defined, so only their order is checked.

### [core/tools] `anyOf` / `oneOf` Errors Must Point at the Closest Branch

- **Issue / Symptom**: With composition keywords, a validator that only says "does not match any schema" leaves a model guessing. A model that retries blindly tends to swap to the other branch instead of fixing the one field it got wrong.
- **Root Cause**: Every branch fails for its own reasons, and reporting all of them buries the useful one.
- **Solution / Workaround**: `validateJsonSchema` reports one summary error plus the errors of the branch with the fewest errors (usually the one whose `const` discriminator matched). `$ref` only resolves local pointers (`#`, `#/$defs/...`) and stops after 32 hops, so recursive schemas (`items: { $ref: "#" }`) work and cycles can't hang the registry. Keywords it doesn't know are ignored, so tool authors should stick to the documented list.

### [core/tools] MCP Distinguishes Protocol Errors from Tool Errors

- **Issue / Symptom**: A server that reports every failure the same way breaks clients. If a call to a tool that was removed (its editor unmounted) comes back as a normal tool result, the model keeps retrying it. If a cancelled `tools/call` still sends its late result, the client sees a response to a request it no longer tracks.
- **Root Cause**: The MCP spec puts an unknown tool or malformed `params` at the JSON-RPC level (`-32602`), while invalid arguments and execution failures are `isError` results the model reads. Cancellation (`notifications/cancelled`) means the server must not respond to that request.
- **Solution / Workaround**: `createMcpServer` returns `-32602` for unknown tools and non-object `arguments`, passes `invalid_arguments` / `tool_failed` through as `isError` results, aborts the call's `AbortSignal` on cancellation and resolves `handle()` to `null` for it. `notifications/tools/list_changed` is only sent after `notifications/initialized`.

### [core/chart] Tick Steps Below the Float Spacing Stall a Running Sum

- **Issue / Symptom**: `niceScale(1e16, 1e16 + 4)` returned up to 1000 identical ticks, and axis labels with a 2.5 step merged (`0 | 3 | 5 | 8 | 10`).
- **Root Cause**: Ticks were built with `t += step`. Near 1e16 the float spacing is 2, so adding 1 rounds back to the same value and the loop only stops at its cap. Separately, label decimals came from the step's order of magnitude, which says 0 decimals for 2.5 and 1 for 0.25. `clean()` (`toPrecision(12)`) also flattens 1e16 + 2 to 1e16.
- **Solution / Workaround**: Compute tick `i` as `(firstIndex + i) * step`, drop neighbours that round to the same float, and only `clean` when that moves a value by less than a millionth of the step. `stepDecimals` counts the decimals of the step itself. When `hi - lo` overflows (±`Number.MAX_VALUE`), take the step from the half span and double it.

### [core/chart] A Drag Must Freeze the Value Axis and Drop No-op Steps

- **Issue / Symptom**: Dragging a bar past the axis maximum rescaled the axis under the pointer, so the bar seemed to run away. Dragging back to the start, or setting a value to what it already was, still left an undo step.
- **Root Cause**: Every move relaid the chart with a fresh `niceScale` over the new data. The controller recorded every commit and merged gesture steps without comparing them to the starting spec.
- **Solution / Workaround**: `startChartPointDrag` returns `valueDomain`. Canvases keep it in state and pass it to `layoutChart({ valueDomain })` until `end()`. `ChartController.commit` returns early when the next spec is structurally equal to the current one, and `endGesture` calls `history.revertTo(mark)` when the spec is back where the gesture began.

### [svelte] A Variable Named `state` Breaks `$state` in the Same Component

- **Issue / Symptom**: `let state = $state.raw(...)` in `ChartPresenceLayer.svelte` failed svelte-check with "Block-scoped variable '$state' used before its declaration" and "Cannot use 'state' as a store".
- **Root Cause**: In a component, `$name` means "subscribe to the store `name`". With a local variable called `state`, the compiler reads `$state` as a store subscription to it, not as the rune.
- **Solution / Workaround**: Never name a component variable `state` (or `derived`, `effect`, `props`). Use `current`, `view` or similar.

### [core/import] Imported HTML Drops `data:image/svg+xml` Images

- **Issue / Symptom**: Charts imported from DOCX as SVG `<img>` tags vanished from the HTML.
- **Root Cause**: `sanitizeImportedHtml` validates `src` with markdown-it's `validateLink`, which only allows `data:image/(gif|png|jpeg|webp)`. SVG data URLs are rejected on purpose (SVG can carry script when opened directly).
- **Solution / Workaround**: The DOCX importer writes each chart as `<div data-type="chart" data-chart="{spec}">` around a caption and a data table, and returns the full spec in `DocumentImport.charts`. With the `chart` node in the schema the div becomes a live chart; without it the div is a plain wrapper and the caption and table stay. The chart node's own HTML carries its static SVG inline (the sanitizer drops it with its content on import; the spec in `data-chart` is what is parsed). Do not widen the URL allowlist for SVG.

### [core/chart] Atomic `run_commands` Only Covers Edits in the Registry's History

- **Issue / Symptom**: `run_commands { atomic: true }` left chart edits applied after a later step failed.
- **Root Cause**: The batch is a `history.batch` on the `CommandRegistry`'s own `history`. A `ChartController` created without `history` records into its own `HistoryManager`, which the batch never sees.
- **Solution / Workaround**: Share one `HistoryManager` between the registry (`new CommandRegistry({ history })`) and the controllers (`new ChartController({ history })`). Without a registry history, atomic batches are refused with a sentence.

### [core/chart] A User Drag During an Agent Performance Ends the Agent's Undo Step

- **Issue / Symptom**: If the user drags a bar while `ChartDirector` is acting out an agent's edits, the agent's edits before and after the drag become separate undo steps.
- **Root Cause**: `ChartController` holds one gesture at a time; `beginGesture` from the user's drag ends the director's gesture.
- **Solution / Workaround**: Accepted: both sets of edits still apply and undo correctly, only the grouping differs. Hosts that need strict grouping can disable editing (`editable={false}`) while `presence` shows an active actor.

### [monorepo] A Patch Changeset Moves the React Peer Range Off `.0`

- **Issue / Symptom**: The Release run failed after merging a patch changeset: `expected '>=0.46.1 <1.0.0-0' to match /^>=0\.\d+\.0.*<1/` in `packages/react/tests/react.test.ts`. PR CI passed because it runs the tests before `changeset version`.
- **Root Cause**: `updateInternalDependencies: "patch"` makes `changeset version` raise the react package's `@pixerate/editor` peer range to the new core version, which ends in `.1` after a patch release. The test assumed it always ends in `.0`.
- **Solution / Workaround**: The test accepts any `>=0.x.y <1` range. To catch this class of failure before merging, run `pnpm version-packages && pnpm test`, then discard the version changes.

### [monorepo] Dependabot Bumps Can Load Two Copies of `prosemirror-model`

- **Issue / Symptom**: After a grouped Dependabot bump (#136), table, track-changes and document-structure tests failed with `Can not convert <…> to a Fragment (looks like multiple versions of prosemirror-model were loaded)`.
- **Root Cause**: `prosemirror-markdown@1.13.8` resolved `prosemirror-model@1.25.12`, while the TipTap packages stayed on 1.25.11. ProseMirror checks node types by identity, so nodes from one copy are rejected by the other.
- **Solution / Workaround**: Run `pnpm dedupe` and commit the lockfile. After any dependency bump, check that `pnpm-lock.yaml` has a single `prosemirror-model@` entry.

### [core/extensions] An Attribute's `parseHTML` Overrides the Parse Rule's `getAttrs`

- **Issue / Symptom**: A ```` ```mermaid ```` block parsed into a chart node with an empty spec, although the `pre` parse rule's `getAttrs` returned the spec read from the code.
- **Root Cause**: TipTap wraps every parse rule: it calls the rule's `getAttrs`, then each attribute's own `parseHTML(element)`, and spreads the attribute values over the rule's. Only `null` / `undefined` leave the rule's value in place, so `parseHTML: (el) => read(el) ?? fallback` always wins.
- **Solution / Workaround**: When a node has several parse rules, attribute `parseHTML` must return `null` when its source is missing (the chart's `spec` and `height` do); the attribute `default` still applies when neither sets it.

### [core/extensions] `addNodeView` Cannot Opt Out by Returning `null`

- **Issue / Symptom**: A node whose `addNodeView` returned `null` when no framework view was configured would throw when ProseMirror created the node view.
- **Root Cause**: TipTap only checks that the `addNodeView` *field* exists, then calls the factory it returns for every node; a `null` factory is called like a function.
- **Solution / Workaround**: Always return a factory. `createChartNodeView(mount, renderStatic)` mounts the framework component when there is one, and otherwise draws (and redraws on update) the same static SVG as `renderHTML`.

### [core/agent] Quick Agent Edits Merge Into One Undo Step

- **Issue / Symptom**: `insert_chart` followed by two `update_chart_in_document` calls was undone in one Mod-Z, removing the chart.
- **Root Cause**: `prosemirror-history` groups transactions that arrive within `newGroupDelay` (500 ms), and tool calls come back to back.
- **Solution / Workaround**: The chart tools mark their transaction with `closeHistory(tr)` (`@tiptap/pm/history`), so each call starts its own undo step.

### [react|svelte/chart] A Chart Node View Keeps Its Own Controller in Step With the Document

- **Issue / Symptom**: Writing every `ChartController` change into the document turned one bar drag into dozens of document steps, and undo in the editor left the canvas showing the old chart.
- **Root Cause**: The canvas, inspector and data grid edit a `ChartController`; the document stores the spec as a node attribute. They are two sources of truth.
- **Solution / Workaround**: `ChartNodeView` (core) subscribes to the controller and writes the spec with `setNodeMarkup` only when no gesture is running, skipping specs equal to the node's. Its `update(node)` loads a changed spec into the controller with `clearHistory: true` (undo, agent tools, collaborators). While the inspector is open `stopEvent` returns `true`, so inputs and keys stay in the inspector, and `ignoreMutation` always returns `true`. The React view renders in its own root (`createRoot`), so app context does not reach it, and it unmounts in a microtask because ProseMirror can destroy node views during a React render. The Svelte component takes the state as `view`, not `state` (see "A Variable Named `state` Breaks `$state`").

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide on Case-Insensitive Disks

- **Issue / Symptom**: `svelte-check` warned "Cannot write file `dist/chart-node/chartNodeView.svelte.js` because it would be overwritten by multiple input files", next to `ChartNodeView.svelte`.
- **Root Cause**: A component `ChartNodeView.svelte` and a rune module `chartNodeView.svelte.ts` both emit `…/[Cc]hartNodeView.svelte.js` / `.d.ts`; macOS and Windows file systems treat the names as one file.
- **Solution / Workaround**: Give rune modules a name that differs from every component in the folder by more than case (here `createChartNodeView.svelte.ts`).

### [core/export] Charts Round-Trip Through Word Without Their Series Ids

- **Issue / Symptom**: A chart exported with `exportDocx` and imported again has the same data, colours and options, but its series ids are `series-1`, `series-2`, … instead of the originals, and colours come back lower-case.
- **Root Cause**: `chartToOoxml` writes a DrawingML `c:chartSpace`, which has no place for a series id; `chartFromOoxml` numbers series on read and writes colours as lower-case hex. The import also does not read the drawing's `wp:extent`, so the node's `width` / `height` fall back to the defaults.
- **Solution / Workaround**: Compare round-tripped specs without series ids (as `tests/docx-export.test.ts` does), and do not key anything that must survive a Word round trip on series ids. Sparklines have no Word equivalent here and are exported as text (label, or `▁▅█` bars).

### [core/chart] A Chart SVG Drawn to a Canvas Comes Out Black

- **Issue / Symptom**: A PNG made from a live chart's SVG (or `chartToSvg` with `CSS_VARIABLE_CHART_THEME`) had black text, axes and grid lines, and a serif font, although the chart looked right on the page.
- **Root Cause**: An SVG loaded through an `<img>` (which is how it reaches a canvas) is a separate document: the page's stylesheets and custom properties do not apply. `fill="var(--foreground, #0f172a)"` then has no `--foreground`, and some browsers treat `var()` in a presentation attribute as invalid outright, falling back to the initial paint (black). `currentColor` and `font-family="inherit"` have nothing to inherit either.
- **Solution / Workaround**: Run `resolveChartSvgPaints(svg, { scope })` before drawing (`rasterizeChartSvg` does): it replaces `var()` with the custom property's computed value on `scope` (or the fallback), `currentColor` with the scope's colour and `inherit` fonts with its font, and drops attributes left empty. Pass the chart's container as `scope` when the theme is scoped to a wrapper (e.g. `.dark`). Agent tools render with `DEFAULT_CHART_THEME` (concrete colours), so their PNGs do not depend on the page. jsdom has no canvas: tests stub `getContext`, `toDataURL` and `Image`.
