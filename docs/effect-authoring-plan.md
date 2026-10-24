# Effect authoring: implementation plan

A plan for a **general-purpose effect editor** in `@pixerate/editor` that can edit effects from
any effects provider, with Flair as the first real one. It is written to be followed step by step.
Do the phases in order, and finish each phase's checklist before you start the next.

## Why it is shaped this way

- `@pixerate/editor/effects` already has a provider contract (`EffectProvider`, see
  [effects.md](./effects.md)) for **using** effects: list, search, describe, render. It has
  nothing for **authoring** them: changing an effect's source, keyframing its controls, saving
  presets.
- Flair already has a headless authoring engine, `EffectEditor` in `@pixerate/flair/editor`. It
  covers GLSL source with line-numbered compile errors, values, keyframes, presets, a timeline and
  undo, and it depends on this repo's `/history`, `/commands`, `/tools`, `/animation` and
  `/parameters`.
- **This repo must never import Flair** (only `apps/demo` uses it). So the shader-specific logic
  stays in Flair. This repo gets:
  1. an optional **authoring extension to the provider contract** (types only),
  2. a **generic session** that gives any provider values, presets, keyframes, a timeline and
     undo with no source editing (the fake provider uses it, and so can any provider that has
     nothing better),
  3. **agent tools** for a session,
  4. **React and Svelte editor components** that work with any session,
  5. a **demo tab**.
- Flair then implements the extension by wrapping its own `EffectEditor`. That is phase 7, in the
  Flair repo, in a separate PR made after this repo's release.

```
@pixerate/editor/effects            EffectAuthoringSession (interface)
  ├─ createEffectAuthoringSession   generic: values, presets, keyframes, timeline, undo
  ├─ createEffectAuthoringToolProvider  agent tools over any session
  └─ fake provider                  openAuthoring → generic session
@pixerate/editor-react/effects      EffectAuthoringEditor, useEffectAuthoring
@pixerate/editor-svelte/effects     EffectAuthoringEditor, effectAuthoringOf
@pixerate/flair/integrations        flairEffects().openAuthoring → wraps Flair's EffectEditor (source, compile errors)
```

## Before you start

Read these first. They are the rules the work is checked against:

- `Agents.md`: Conventional Commits, changesets, tests, React/Svelte parity, agent tools as
  first-class, skills, `GOTCHAS.md`.
- `GOTCHAS.md`
- `docs/effects.md` and every file in `packages/core/src/effects/`, especially `types.ts`
  (the contract), `fake.ts` (reference provider), `conformance.ts`, `tools.ts` (agent tools in
  the house style) and `ui.ts` (`effectParameterFields`).
- `packages/core/src/history/HistoryManager.ts`: undo/redo, and how it merges a drag into one
  step.
- `packages/core/src/animation/`: easing types (`AnimationEasing`, `evaluateEasing`,
  `isAnimationEasing`) and the keyframe track shapes (`AnimationKeyframe`, `AnimationTrack`).
- `packages/react/src/effects/` and `packages/svelte/src/effects/`: `EffectParameters`,
  `EffectsBrowser`, `useEffects`. Copy their style.
- `packages/core/tests/effects-contract.test.ts`, `tests/entry-isolation.test.ts`,
  `tests/agent-skills.test.ts` and `tests/command-tools.test.ts`.
- If the Flair repo is checked out next to this one, also read `flair/src/editor/editor.ts`
  (`EffectEditor`) and `flair/src/integrations/effects.ts` (`flairEffects`). The interface below
  is modelled on `EffectEditor`, so phase 7 should be a thin wrapper.

Commands, run from the repo root:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm format:check
```

All of them must pass before every commit. Work on the branch you were given, never on `main`.

## Rules that apply to every phase

- **`packages/core/src/effects/` stays dependency-free.** No DOM access at runtime, no
  framework, no TipTap or ProseMirror. Type-only references to `ImageBitmap` and the like are
  already used and are fine. `tests/entry-isolation.test.ts` must keep passing.
- **Everything new is optional.** Existing providers that don't implement authoring must
  compile, pass `checkEffectProvider` and behave exactly as before.
- **Edits return results; they don't throw.** Every session write returns
  `{ ok: true, ... } | { ok: false; message: string }`. A refusal changes nothing, and its message
  says what was wrong and what the valid choices are, e.g.
  `there is no control "uSpd"; the controls are uSpeed, uTint`. Only `openAuthoring` throws, with
  the contract's typed errors (`UnknownEffectError`, `EffectUnsupportedError`).
- **One user action is one undo step.** A slider drag (same `gesture` key) merges into one step.
- **Times are milliseconds** everywhere, as in the rest of the contract.
- **Write tests as you go**, not at the end. Every phase lists the tests it needs.
- **Commit at the end of each phase** with a Conventional Commit, e.g.
  `feat(core): effect authoring sessions in the effects contract`.

---

## Phase 1: contract types (core)

**File:** new `packages/core/src/effects/authoring.ts`, exported from
`packages/core/src/effects/index.ts` (`export * from './authoring.js';`).

**1.1 Capability flag.** In `types.ts`, add an **optional** field to
`EffectProviderCapabilities`:

```ts
/** Implements `openAuthoring`: effects can be edited, not only used. */
supportsAuthoring?: boolean;
```

**1.2 Provider method.** In `types.ts`, add an **optional** method to `EffectProvider`:

```ts
/**
 * Opens an effect for editing. Present when `capabilities.supportsAuthoring`. Unknown ids throw
 * `UnknownEffectError`; an effect the provider cannot edit throws `EffectUnsupportedError`.
 */
openAuthoring?(from: EffectAuthoringSource): MaybePromise<EffectAuthoringSession>;
```

`MaybePromise` is file-local in `types.ts`. Export it, or repeat it in `authoring.ts`.

**1.3 The types in `authoring.ts`.** Write them with a JSDoc comment on every field, in the same
style as `types.ts`:

```ts
/** What to open: a catalog effect (optionally with a preset applied), or a document saved earlier by `exportDocument`. */
export type EffectAuthoringSource =
  | { effectId: string; preset?: string }
  | { document: unknown };

/** The language of an editable source, or null when the effect has no source to edit. */
export type EffectSourceLanguage = "glsl" | "svg" | null;

export interface EffectKeyframe {
  /** Ms from the start of the effect. */
  time: number;
  value: EffectValue;
  /** Easing into the next keyframe (default `linear`). */
  easing?: AnimationEasing;
}

/** A problem with the effect, e.g. a compile error. `line` is 1-based in `source` when known. */
export interface EffectAuthoringIssue {
  message: string;
  line?: number;
  severity: "error" | "warning";
}

export interface EffectAuthoringState {
  providerId: string;
  /** The id the effect was opened from, or null for a document with no catalog id. */
  effectId: string | null;
  name: string;
  kind: EffectKind;
  /** The current controls, defaults and presets. They change when the source changes. */
  description: EffectDescription;
  /** Editable source, or null (see `sourceLanguage`). */
  source: string | null;
  sourceLanguage: EffectSourceLanguage;
  /** Every control's value at the playhead (keyframes applied). */
  values: EffectValues;
  /** Keyframes per control. A control with no entry is not animated. */
  tracks: Readonly<Record<string, readonly EffectKeyframe[]>>;
  issues: readonly EffectAuthoringIssue[];
  /** Whether the source compiled: true, false, or null when that is not known yet (no preview has compiled it). */
  compiled: boolean | null;
  /** Playhead (ms). */
  time: number;
  /** Length of one play (ms). */
  duration: number;
  loop: boolean;
  playing: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export type EffectAuthoringResult<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

export interface EffectAuthoringSession {
  /**
   * The current state. It returns the same object until something changes, so React's
   * `useSyncExternalStore` can use it as it is.
   */
  getState(): EffectAuthoringState;
  /** Called after every change. Returns a function that unsubscribes. */
  subscribe(listener: (state: EffectAuthoringState) => void): () => void;

  /** Replaces the source. Refused when `sourceLanguage` is null. */
  setSource?(
    source: string,
  ): MaybePromise<
    EffectAuthoringResult<{ issues: readonly EffectAuthoringIssue[] }>
  >;

  /**
   * Sets a control at the playhead: the value if the control is not animated, else a keyframe at
   * `time`. Calls with the same `gesture` key merge into one undo step.
   */
  setValue(
    name: string,
    value: EffectValue,
    options?: { gesture?: string | null },
  ): EffectAuthoringResult;
  /** Sets several controls as one undo step, all or nothing: one bad value refuses the lot. */
  setValues(
    values: EffectValues,
    options?: { gesture?: string | null },
  ): EffectAuthoringResult;
  /** Puts controls back to their defaults (default: all of them). */
  resetValues(names?: readonly string[]): EffectAuthoringResult;
  applyPreset(name: string): EffectAuthoringResult;
  /** Saves the current values as a preset, or replaces one with the same name. */
  savePreset(name: string): EffectAuthoringResult;

  /** Adds or replaces a keyframe. `value` defaults to the control's value at that time. */
  setKeyframe(
    name: string,
    time: number,
    value?: EffectValue,
    easing?: AnimationEasing,
  ): EffectAuthoringResult;
  removeKeyframe(name: string, time: number): EffectAuthoringResult;
  /** Removes every keyframe of a control. The value it has at the playhead becomes its value. */
  clearTrack(name: string): EffectAuthoringResult;
  setTiming(timing: {
    duration?: number;
    loop?: boolean;
  }): EffectAuthoringResult;

  play(): void;
  pause(): void;
  /** Moves the playhead (clamped to 0..duration). */
  seek(time: number): void;
  undo(): boolean;
  redo(): boolean;

  /**
   * A renderer that draws this session's current effect (source and values as they are at each
   * `render` call). `render({ time })` draws the effect at `time` with the keyframed values for
   * that time unless `values` is given. A compile failure shows in `issues` and `compiled`.
   */
  createPreview(options: EffectRendererOptions): MaybePromise<EffectRenderer>;

  /** The document as plain JSON, to save and reopen with `{ document }`. */
  exportDocument(): unknown;
  dispose(): void;
}
```

Use `EffectValue`, `EffectValues`, `EffectKind`, `EffectDescription`, `EffectRenderer` and
`EffectRendererOptions` from `./types.js`, and `AnimationEasing` **as a type-only import** from
`../animation/...`. Find the exact file with `grep -rn "export type AnimationEasing"
packages/core/src/animation`. Check that the import doesn't break `entry-isolation.test.ts`. If it
does, define the easing type locally the way `types.ts` reuses `FlairSvgAnimation`.

**Checklist**

- [ ] `pnpm typecheck` and `pnpm test` pass. Nothing else uses the types yet.
- [ ] Commit: `feat(core): effect authoring types in the effects contract`.

---

## Phase 2: the generic session (core)

**File:** new `packages/core/src/effects/authoring-session.ts`, exported from `index.ts`.

```ts
export interface GenericAuthoringOptions {
  /** The provider whose `describe` and `createRenderer` the session uses. */
  provider: EffectProvider;
  /** Undo history to record into (default: a new HistoryManager). */
  history?: HistoryManager;
  /** Time source for playback: called with a frame callback, returns a cancel function. Default: requestAnimationFrame where it exists, else a 16 ms timer. Tests pass a manual one. */
  schedule?: (frame: (now: number) => void) => () => void;
  /** Ms within which `setValue` calls on one control with no gesture merge (default 400). */
  mergeWindowMs?: number;
}

/** A session with values, presets, keyframes, timing and undo, over any provider. It has no source editing (`sourceLanguage: null`). */
export async function createEffectAuthoringSession(
  source: EffectAuthoringSource,
  options: GenericAuthoringOptions,
): Promise<EffectAuthoringSession>;
```

How it works:

1. **Opening.** `{ effectId }` calls `provider.describe(effectId)` and starts the values at
   `defaults`, then applies `preset` if given (an unknown preset throws
   `EffectUnsupportedError` naming the presets there are). `{ document }` validates the JSON
   (see step 7) and describes `document.effectId`. Motion effects (`kind: 'motion'`) have no
   pixels: throw `EffectUnsupportedError` for now. That is out of scope (see the end).
2. **Document model** (plain JSON, `version: 1`):
   ```ts
   {
     version: (1,
       providerId,
       effectId,
       name,
       values,
       tracks,
       presets,
       duration,
       loop);
   }
   ```
   `presets` holds the **user-saved** presets only. `description.presets` in the state is the
   provider's presets followed by the saved ones (a saved preset replaces a provider preset with
   the same name).
3. **Validation.** Check every value with `effectValueErrors(description, { [name]: value })`
   from `helpers.ts`. An unknown control is refused, with a message that lists the controls.
   Times must be finite and `>= 0`. `duration` must be `> 0`. Easing goes through
   `isAnimationEasing`.
4. **Values at a time.** For an animated control, find the keyframes on either side of `t` and
   ease between them with `evaluateEasing`:
   - Numbers: linear.
   - Arrays of numbers: per component.
   - `#rrggbb` colours: per channel in sRGB. Write a small private `lerpHex` helper. Don't
     import Oklab helpers from other modules.
   - Booleans, other strings and enum values: hold the earlier keyframe's value.
   - Before the first keyframe, use the first keyframe's value. After the last, use the last.
5. **Undo.** Every write goes through the `HistoryManager`. Read how it merges steps and use the
   `gesture` key (or the control name inside `mergeWindowMs`) as the merge key. Flair's
   `EffectEditor.setValue` (`mergeKey`) does the same thing. `undo()` and `redo()` return
   whether anything changed.
6. **State identity.** Rebuild the state object only when something changes, then notify the
   subscribers. `getState()` returns the cached object.
7. **Playback.** `play()` uses `schedule` to move `time` forward. It wraps at `duration` when
   `loop`, and stops at the end otherwise. Playback and seeking are **not** undo steps.
8. **Preview.** `createPreview(opts)` calls `provider.createRenderer(effectId, opts)` and returns
   a wrapper `EffectRenderer` whose `render(req)` fills in `values: req.values ?? valuesAt(req.time)`.
   `compiled` stays `null` because the provider renders a known effect. Set it to `true` after the
   first successful render.
9. **`setSource`** is not defined on the generic session (the method is optional).
   `sourceLanguage` is `null`.
10. `dispose()` stops playback, removes listeners and disposes the previews it created. Calls
    after `dispose` are refused with `{ ok: false, message: 'the session is closed' }`.

**Tests:** `packages/core/tests/effects-authoring.test.ts`, using `createFakeEffectProvider()`:

- [ ] opens by id and by preset; an unknown id rejects with `unknown_effect`; an unknown preset
      rejects and lists the presets there are
- [ ] `setValue` with a valid value updates `values` and is one undo step; `undo` restores it
- [ ] `setValue` with a bad type, an out-of-range number and an unknown control is refused with a
      useful message, and the state object is unchanged (`toBe` the same object)
- [ ] three `setValue` calls with the same `gesture` make one undo step
- [ ] `setValues` with one bad value changes nothing; with good values it is one undo step
- [ ] keyframes: two keyframes on a number control interpolate at the midpoint; a colour
      interpolates per channel; a boolean holds; `removeKeyframe` and `clearTrack` work and undo
- [ ] `savePreset` then `applyPreset` round-trips; a saved preset shows in `description.presets`
- [ ] `exportDocument()` → `createEffectAuthoringSession({ document })` gives the same state
- [ ] playback with a manual `schedule` moves `time` forward, loops, and stops when `loop` is false
- [ ] `createPreview().render({ time })` passes the keyframed values to the provider's renderer
      (spy on the fake provider)
- [ ] `getState()` returns the same object when nothing changed

**Checklist**

- [ ] All tests pass. Commit: `feat(core): generic effect authoring session`.

---

## Phase 3: fake provider and conformance (core)

1. **Fake provider.** In `fake.ts`, set `supportsAuthoring: true` and add
   `openAuthoring: (from) => createEffectAuthoringSession(from, { provider: self })`, where `self`
   is the provider object itself. Restructure the object literal into a `const` first if needed.
   Add an option `authoring?: boolean` (default `true`) to `FakeEffectProviderOptions` so tests
   can also get a provider without it.
2. **Conformance.** In `conformance.ts`, when `capabilities.supportsAuthoring` is true:
   - `openAuthoring` must exist. Open the first checked effect that is not `motion`.
   - `getState()` twice returns the same object, and `state.description` passes
     `checkDescription`.
   - `setValue` with an unknown control returns `ok: false` with a message, and the state is
     unchanged.
   - `setValue` of a valid default makes `canUndo` true, and `undo()` restores the value.
   - `exportDocument()` survives `JSON.parse(JSON.stringify(...))`, and reopening it gives the
     same `values`.
   - When `sourceLanguage` is not null, `setSource` must exist.
   - `dispose()` doesn't throw.
   - Add an option `authoring?: boolean` (default `true`) to skip these checks.
   - Report problems as `EffectConformanceIssue`s like the other checks do. Don't throw.
3. **Tests.** Extend `effects-contract.test.ts`:
   - The fake provider (with authoring) conforms.
   - A hand-made provider with `supportsAuthoring: true` but no `openAuthoring` gets an issue.
   - A provider without the flag is not checked for authoring.

**Checklist**

- [ ] All tests pass. Commit: `feat(core): authoring in the fake effects provider and conformance check`.

---

## Phase 4: agent tools and skill (core)

**File:** new `packages/core/src/effects/authoring-tools.ts`, exported from `index.ts`.

```ts
export interface EffectAuthoringToolHost {
  /** The open session, or null when nothing is open (write tools then refuse with a message saying how to open one). */
  session(): EffectAuthoringSession | null;
  /** Optional: a PNG data URL of the preview, for a `view_effect` tool. */
  capture?(): Promise<string>;
}
export function createEffectAuthoringToolProvider(
  host: EffectAuthoringToolHost,
  options?: { id?: string },
): AgentToolProvider;
```

Copy the structure of `createEffectToolProvider` in `tools.ts`: the same `AgentToolProvider`
shape, strict `inputSchema`s and annotations. **One tool per operation**:

| Tool                                              | Args                                   | Returns                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect_authoring_describe`                       | —                                      | name, kind, sourceLanguage, controls (from `effectParameterFields`), presets' names, animated controls with keyframe counts, duration, loop, issues |
| `effect_authoring_get_source`                     | —                                      | `{ language, source }`, or an error when the effect has no source                                                                                   |
| `effect_authoring_set_source`                     | `source`                               | `{ issues }`, with compile errors and line numbers. Only listed when the session has `setSource`                                                    |
| `effect_authoring_set_values`                     | `values` (object)                      | the values it set; all or nothing, one undo step                                                                                                    |
| `effect_authoring_reset_values`                   | `names?`                               | the values after the reset                                                                                                                          |
| `effect_authoring_apply_preset`                   | `name`                                 | the values after                                                                                                                                    |
| `effect_authoring_save_preset`                    | `name`                                 | the preset's name and values                                                                                                                        |
| `effect_authoring_set_keyframe`                   | `control`, `time`, `value?`, `easing?` | that control's track                                                                                                                                |
| `effect_authoring_remove_keyframe`                | `control`, `time`                      | that control's track                                                                                                                                |
| `effect_authoring_clear_track`                    | `control`                              | the control's value now                                                                                                                             |
| `effect_authoring_set_timing`                     | `duration?`, `loop?`                   | `{ duration, loop }`                                                                                                                                |
| `effect_authoring_seek`                           | `time`                                 | values at that time                                                                                                                                 |
| `effect_authoring_undo` / `effect_authoring_redo` | —                                      | whether it changed anything                                                                                                                         |
| `effect_authoring_view`                           | `time?`                                | an image content block. Only listed when `capture` is given                                                                                         |

- `set_values` calls `session.setValues`, which already applies all or nothing as one undo step.
- `ok: false` results become `isError` tool results carrying the message.
- **Skill.** Add a new skill `packages/core/skills/pixerate-effect-authoring/SKILL.md`, following
  `packages/core/skills/README.md`. Cover: when to use each tool, the order to work in (describe
  → set values / source → view → keyframes), and the pitfalls (animated controls are set through
  keyframes; check `issues` after `set_source`). Add a row to `skills/README.md`.
- **Tests:**
  - Map the new factory in `expectedBySkill()` and `FACTORIES` in `tests/agent-skills.test.ts`.
  - Add the provider to the conformance test in `tests/command-tools.test.ts`.
  - New `tests/effects-authoring-tools.test.ts` calls every tool through
    `ToolRegistry.callTool` with valid args, invalid args (unknown control, bad type, negative
    time, no session open) and a session without `setSource` (`set_source` is not listed).

**Checklist**

- [ ] All tests pass, including `agent-skills` and `command-tools`.
- [ ] Commit: `feat(core): agent tools and skill for effect authoring`.

---

## Phase 5: React editor component (react)

**Files:** in `packages/react/src/effects/`, add `useEffectAuthoring.ts`,
`EffectAuthoringEditor.tsx`, and smaller parts as needed (`EffectSourcePane.tsx`,
`EffectPreview.tsx`, `EffectTimeline.tsx`). Export them from `index.ts`.

- `useEffectAuthoring(session: EffectAuthoringSession | null): EffectAuthoringState | null`:
  `useSyncExternalStore` over `subscribe` and `getState`.
- `EffectAuthoringEditor` props:
  `{ session; showSource?: boolean = true; showTimeline?: boolean = true; previewSize?: { width; height } = 480×270; className? }`.
  Layout: a toolbar on top, then the preview and the source side by side (stacked when narrow),
  then the parameters, then the timeline.
  - **Toolbar:** play/pause, a time readout, undo and redo (disabled from `canUndo`/`canRedo`),
    and a "Save preset" button that asks for a name in an inline input. Don't use
    `window.prompt`.
  - **Preview:** a `<canvas>`. Make one renderer with `session.createPreview(previewSize)`. On
    every state change, render `{ time: state.time }` and draw it with `putImageData`
    (`new ImageData(pixels.data, w, h)`). Skip a frame if the previous render is still running.
    Dispose the renderer on unmount or when the session changes. Show issues under the canvas.
  - **Source pane:** only when `state.sourceLanguage` and `session.setSource` exist. Use a plain
    `<textarea>` with a line-number gutter. **Do not add a code editor dependency.** Apply
    changes 300 ms after typing stops. Mark the lines of `issues` that have a `line` in the gutter
    and list them below. Clicking an issue moves the caret to its line.
  - **Parameters:** reuse the existing `EffectParameters` with `description={state.description}`,
    `values={state.values}`, `onChange={(c, v, g) => session.setValue(c, v, { gesture: g })}`,
    `onReset`, `onPreset` (call `applyPreset` by name; you may need to pass the preset's name
    rather than its values. Extend `EffectParameters` with an optional `onPresetName` prop rather
    than changing what `onPreset` means) and `keyframed={new Set(Object.keys(state.tracks))}`.
  - **Keyframe toggle:** a small diamond button next to each control.
    - Not animated: clicking it calls `setKeyframe(name, state.time)`.
    - Animated with a keyframe at the playhead: clicking it calls `removeKeyframe`.
    - Animated without one: clicking it adds one.

    Find out first whether `EffectParameters` can show this through its props. If it can't, add an
    optional `renderControlAddon?(control) => ReactNode` prop and use it. Keep existing callers
    working unchanged.

  - **Timeline:** a scrubber (range input, `0..duration`, calls `seek`), with a row of keyframe
    dots for each animated control. Clicking a dot seeks to it. Duration and loop are editable
    fields that call `setTiming`.

- Use Tailwind classes and the theme tokens the other effects components use (`border-border`,
  `bg-muted`, `text-muted-foreground`, ...). Read their styling first.
- **Tests:** `packages/react/tests/effect-authoring.test.tsx`, with the fake provider and a
  manual `schedule`:
  - [ ] renders the parameters, and changing a field calls `setValue` (the state updates)
  - [ ] undo button enabled after a change, and undoes it
  - [ ] the source pane is hidden when `sourceLanguage` is null; with a stub session that has
        `setSource`, typing calls it after the debounce, and an issue on line 3 marks line 3
  - [ ] the keyframe diamond adds and removes a keyframe at the playhead
  - [ ] the scrubber seeks
  - [ ] unmounting disposes the preview renderer (spy)

  jsdom has no canvas: check how the existing `EffectThumbnail` tests get round this and do the
  same.

**Checklist**

- [ ] All tests pass. Commit: `feat(react): effect authoring editor`.

---

## Phase 6: Svelte parity (svelte)

Mirror phase 5 in `packages/svelte/src/effects/`. Follow how `effects.svelte.ts` and
`EffectParameters.svelte` mirror their React versions.

- `effectAuthoringOf(session)` in `effects.svelte.ts`: a rune-based reactive state, subscribed
  on creation and unsubscribed on destroy.
- `EffectAuthoringEditor.svelte` with the same props, layout and behaviour as React. Any props
  you added to the React `EffectParameters` (`onPresetName`, the per-control addon) get Svelte
  equivalents (a callback prop and a snippet).
- **Tests:** `packages/svelte/tests/effect-authoring.svelte.test.ts`, the same cases as phase 5.
- Update the **Effects providers** parity table in `README.md` (around line 523) with rows for
  the authoring session, its agent tools and the editor component (Core / React / Svelte).

**Checklist**

- [ ] All tests pass. Commit: `feat(svelte): effect authoring editor`.

---

## Phase 7a: demo, docs, changeset (this repo)

1. **Demo.**
   - Add an **Effect authoring** tab in `apps/demo/src/App.tsx`, next to the existing tabs.
   - Left side: an `EffectsBrowser` to pick an effect. Right side: `EffectAuthoringEditor` for
     the picked effect.
   - Get the provider from `demoEffects.ts`, as the other tabs do: the fake one by default,
     Flair when it is picked from the effects switch.
   - If the provider lacks `supportsAuthoring`, show a sentence saying so.
   - Register `createEffectAuthoringToolProvider` in the tab's agent-tools panel (see
     `agentTools.ts`).
   - Until phase 7b ships, Flair won't have `openAuthoring` yet, so the demo shows the sentence
     for it. That is expected.
2. **Docs.**
   - Add an **Authoring** section to `docs/effects.md`: the capability, `openAuthoring`, the
     session, the generic session, the tools, and the components with a short example each.
   - Add a row to the README's **What's inside** table, or extend the **Effects providers** row.
   - Link this plan from `docs/effects.md` until phase 7b is done, then remove the link.
3. **Changeset.** Run `pnpm changeset` and choose **minor** for `@pixerate/editor`,
   `@pixerate/editor-react` and `@pixerate/editor-svelte`. Summary: "Effect authoring: an
   optional `openAuthoring` in the effects contract, a generic authoring session, agent tools,
   and `EffectAuthoringEditor` for React and Svelte."
4. Add anything tricky you ran into to `GOTCHAS.md`.

**Checklist**

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm format:check` pass.
- [ ] `pnpm dev`, open the tab, and with the fake provider: change a value, keyframe it, scrub,
      undo, and save a preset.
- [ ] Commit: `feat(demo): effect authoring tab` and `docs(core): effect authoring`. Push and
      open a PR only if you were asked to.

---

## Phase 7b: Flair implements authoring (Flair repo, separate PR)

Start this phase only after the release with phase 1–7a is published to npm. Note its version:
call it `X`. Follow the Flair repo's own `AGENTS.md` (changesets, `pnpm typecheck && pnpm build
&& pnpm test`).

1. In `package.json`, raise the `@pixerate/editor` peer range used by `/integrations` to
   `>= X`, and the devDependency to `^X`. Update the entry points table in `README.md` and the
   rule in `AGENTS.md` section 4 that names the minimum versions.
2. In `src/integrations/effects.ts`, set `supportsAuthoring: true` and add `openAuthoring` in
   `flairEffects()`, wrapping `createEffectEditor` from `../editor/index.js`. **Import only
   types from `@pixerate/editor/effects`**, as the file already does.
   - **Shader effects** (`sourceLanguage: 'glsl'`): `setSource` → `editor.setSource`.
     - Compile errors come from a preview: `createPreview` makes a `ShaderFrames` (or a
       one-pass `ShaderPipeline`) at the requested size.
     - Before each render, if the source changed, recompile and pass the status to
       `editor.reportCompile`. Map `CompileReport.errors` to `issues` with `line`, and
       `compile.ok` to `compiled`.
     - If no preview exists when `setSource` is called, compile with a hidden `ShaderFrames` so
       the agent still gets its errors.
   - **Vector effects:** `sourceLanguage: null` for now (picture editing comes later). The
     preview rasterises `motionAt(document, time)` with the provider's existing SVG rasterizer.
   - **Motion primitives:** throw `EffectUnsupportedError`.
   - Map the rest:

     | Session                                              | `EffectEditor`                                    |
     | ---------------------------------------------------- | ------------------------------------------------- |
     | `setValue` / `setValues`                             | `setValue` / `setValues` (gesture → `mergeKey`)   |
     | `resetValues`                                        | `resetValues`                                     |
     | `applyPreset` / `savePreset`                         | `applyPreset` / `savePreset`                      |
     | `setKeyframe` / `removeKeyframe` / `clearTrack`      | same names                                        |
     | `setTiming`, `play`, `pause`, `seek`, `undo`, `redo` | same names                                        |
     | `exportDocument` / `{ document }`                    | the `EffectDocument` JSON / `parseEffectDocument` |

   - Convert values both ways with the existing `contractValue` helpers, so colours are
     `#rrggbb` in the session. Derive `description` from the editor's current controls in the
     same way `describeCatalog` does, so a source change that adds a `// @control` adds a field.
   - Keep `getState()` identity stable: rebuild the session state only when Flair's
     `getState()` object changes.

3. **Tests.** `src/integrations/effects.test.ts` already runs `checkEffectProvider`. It now also
   runs the authoring checks: make them pass with the fake WebGL context (`installFakeWebGl`).
   Add tests for:
   - [ ] a GLSL syntax error coming back as an issue with the right line
   - [ ] a new `// @control` appearing in `description`
   - [ ] a round trip through `exportDocument`
4. Changeset (minor), README section "4b" gains an authoring paragraph, and add a line to
   `CHANGELOG`-facing docs as the repo does.
5. Back in this repo, remove the link to this plan from `docs/effects.md` and check in the demo
   that Flair effects open in the **Effect authoring** tab, with GLSL errors marked on the right
   lines.

---

## Out of scope for this first version

Leave these out. Note them in `docs/effects.md` under "Later":

- A real code editor (syntax highlighting, completion). The textarea is deliberate.
- Editing vector pictures as source (`sourceLanguage: 'svg'`) and motion primitives.
- Multi-pass effect stacks and feedback.
- Opening an effect for editing from the video, image, canvas or animation editors ("Edit this
  effect"). The session API makes it possible, but each editor's integration is its own piece of
  work.
- Creating a blank new effect (`{ blank: kind }` as a source).
- Live fast previews that draw straight to the page without reading pixels back. For Flair this
  would be an optional `mountPreview(container)` on the session, if pixel readback turns out to
  be too slow.
