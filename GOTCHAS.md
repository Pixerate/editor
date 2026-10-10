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
  3. Externalize `@xyflow/svelte` and `@dagrejs/dagre` in `packages/svelte/tsup.config.ts`.

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

