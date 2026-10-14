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

### [core/spreadsheet] Formula Ranges Arrive Flat and Column-Major, and Typed Cell Values Are Text

- **Issue / Symptom**: Lookup functions (INDEX, VLOOKUP, XLOOKUP) picked the wrong cells, and `MATCH(5, A1:A3, 0)` returned `#N/A` even though a cell showed `5`.
- **Root Cause**: `EvaluationContext.resolveRange` returns one flat array, column by column (the controller's loop order), with no row/column shape. Separately, cells typed by the user store their raw text as the value, so a typed `5` is the string `"5"`, and `compareValues` ranks numbers and text differently (`"1"=1` is FALSE by design).
- **Solution / Workaround**: The evaluator records each range's shape (`withRangeShape`, a `WeakMap` keyed by the array, columns taken from the range reference) and functions read ranges through `ctx.range(i)` / `rangeGet(range, row, col)`. Never assume row-major order. Custom `resolveRange` implementations must return values column-major. Lookups, criteria (`SUMIF` etc.) and `ISNUMBER` normalize numeric text with `numericValue` / `normalizeValue`, while the `=` operator keeps its strict typed comparison. Functions that would return a whole row/column return a shaped array: other functions can aggregate it, `evaluateWithDiagnostics` returns it as `array` (with the top-left value as `value`), and the controller spills it (see the dynamic-arrays entry).

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
