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
- **Solution / Workaround**: `DependencyGraph.getEvaluationPlan()` runs an iterative Tarjan SCC pass (no recursion, so long chains don't overflow) that returns cells dependencies-first plus every member of a cycle. `recalculateAll` rebuilds the graph and follows the plan. Row/column insert/delete calls `shiftFormulaReferences()` on every formula *before* mutating the grid; growing the grid during a paste is not an insertion and must not shift references. Whole-column ranges (`A:A`) register a column dependency key (`"A:"`) instead of a million cell keys. The controller sets the evaluating row while evaluating so `[property]` is per-row. In formula code, never use `Math.max(...values)` or `push(...values)` on range values: large ranges overflow the stack.


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
- **Solution / Workaround**: Use the scanners in `packages/core/src/serializers/html-scan.ts` (`findTagSpans`, `replaceTagSpans`, `stripTags`, `replaceDelimited`). They find each closer once, reuse it until the scan passes it, and stop when none is left. `tests/html-scan.test.ts` checks they match the old regexes on random input and that time grows linearly. When testing performance, assert growth between two sizes rather than an absolute time, which depends on machine load.
