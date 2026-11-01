# Effects providers

`@pixerate/editor/effects` is a contract for **catalogs of visual effects** (shaders, vector pictures, motion, camera moves) that the editors can use without depending on any one effects library. The package ships the contract, its checks, a fake provider and the shared agent tools. It imports nothing: no GPU code, no Flair. Without a provider, every editor behaves as it did before effects support existed.

The real provider is [Flair](https://github.com/Pixerate/flair): `flairEffects()` from `@pixerate/flair/integrations`. The adapter lives **in Flair**, not here, so this repo never depends on Flair. The demo is the only place that uses both: `@pixerate/flair` is a devDependency of `apps/demo`, and `apps/demo/src/demoEffects.ts` loads it on demand when the user picks it from the demo's effects switch (the default is the fake "test" provider).

## The contract

`packages/core/src/effects/types.ts`:

```ts
interface EffectProvider {
  readonly id: string;               // saved next to effect ids, e.g. "flair"
  readonly name: string;
  readonly version?: string;
  readonly capabilities: EffectProviderCapabilities;
  list(options?): MaybePromise<EffectSummary[]>;
  search(query, options?): MaybePromise<EffectSummary[]>;
  describe(id): MaybePromise<EffectDescription>;          // controls, defaults, presets
  createRenderer(id, options): MaybePromise<EffectRenderer>;
  applyVectorEffect?(id, target, values?): MaybePromise<EffectVectorMotion>;
  cameraView?(id, ctx, values?): CameraView;                // camera moves; sync and pure
  sampleCameraMove?(id, request): MaybePromise<CameraMoveSample>;
  listTemplates?(options?): MaybePromise<EffectTemplateSummary[]>;          // sequence templates
  describeTemplate?(id): MaybePromise<EffectTemplateDescription>;            // slots shaped for a form
  instantiateTemplate?(id, values?, options?): MaybePromise<EffectTemplateResult>;
}

interface EffectRenderer {
  readonly effectId: string;
  readonly width: number;
  readonly height: number;
  readonly depth: 8 | 16 | 32;
  render(request): Promise<EffectPixels>;
  dispose(): void;
}
```

- **Kinds** are `shader`, `vector`, `motion` and `camera`. **Uses** are `filter`, `transition`, `generator`, `overlay`, `title`, `motion`, `interactive` and `camera`; each editor offers the uses that make sense in it (`effectOffered(effect, uses)` decides, and offers motion and camera effects only where their use is named).
- **Capabilities:** `supportsWorker`, `supportsFloat`, `supportsMask`, `supportsHostImages`, `supportsVector`, an optional `maxSize`, and the optional `supportsAuthoring`, `supportsCamera` and `supportsTemplates`. Editors check them before asking for something (16/32-bit pixels, masks, vector output).
- **Errors** (`errors.ts`) are typed with codes: `unknown_effect`, `invalid_values`, `unsupported`, `disposed`, `no_provider` and `unknown_template` (`UnknownEffectError`, `EffectControlError`, `EffectUnsupportedError`, `EffectDisposedError`, `NoEffectsProviderError`, `UnknownTemplateError`; `isEffectError`). Agent tools turn them into `isError` results.
- **One render at a time per renderer.** `EffectRendererPool` (`pool.ts`) keeps a few renderers alive per effect, size and depth (default 4) and disposes the least recently used. GPU providers hold one WebGL context per renderer, and browsers drop the oldest after about sixteen (#281).
- **Saved documents** keep the provider id, effect id and values. They load and save unchanged without a provider; filters pass pixels through and generated layers keep their last pixels.

### Checking a provider

- `await checkEffectProvider(provider)` (`conformance.ts`) runs the contract checks and returns a list of issues (empty when it conforms). Flair's adapter is checked with it.
- `createFakeEffectProvider()` (`fake.ts`) is a small, deterministic reference implementation used by the tests and the demo.

## Registering a provider

Every controller with effects support has `setEffectsProvider(provider | null)` and `useEffects(provider)`, which registers the provider and returns a function that removes it: the image, paint, video, animation and vector editor controllers, and the canvas through `createCanvasEffectsController` (`canvas/effects.ts`). The image, video, animation and canvas ones also take `effects` in their options.

```ts
import { flairEffects } from '@pixerate/flair/integrations';

const effects = flairEffects();
const editor = new ImageEditorController({ effects });
// or later:
const release = editor.useEffects(effects);
```

- **React:** `useEffects(host, provider)` and `useEffectDescription(provider, id)` from `@pixerate/editor-react/effects`, with `EffectsBrowser`, `EffectParameters` and `EffectThumbnail`.
- **Svelte:** `useEffects(host, provider)` and `effectDescriptionOf(...)` from `@pixerate/editor-svelte/effects`, with the same three components.
- Each editor also has its own panel (for example `ImageProviderEffectsPanel`, `VideoEffectsPanel`, `AnimationEffectsPanel`, `VectorProviderEffectsPanel`) and an `effects` prop on its editor component.

## What each editor does with effects

| Editor | Effects become | PR |
|---|---|---|
| Video | Clip effect stacks, effect transitions and effect clips. `VideoEffectsEngine` caches per frame; ffmpeg export needs pre-rendered `frames` for enabled effects | #276 |
| Image | Filter effects are `effect` smart filters; generator, overlay and title effects are effect layers (`PixelLayer.generator`) at the document's bit depth | #279 |
| Animation | Motion effects become ordinary, tagged animation commands in a new shot; vector effects add an artwork group | #282 |
| Vector | A vector effect's picture at rest, as an editable group tagged `providerEffect` | #282 |
| Canvas | One effect per shape node (`data.shape.effect`), and scene transitions | #283 |
| Paint | Effect paper under every layer, effect layers, effect fills, and filter effects baked into dried paint as light (wet paint is refused) | #284 |

## Agent tools

`createEffectToolProvider(host)` (`effects/tools.ts`) gives every editor the same six tools: `search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect` and `remove_effect`. `search_effects` filters by words, kind, category, use and `tags`, returns each effect's tags, and lists the tags of everything it matched with their counts, so an agent can browse tags and then narrow by them; a tag the catalog lacks comes back with the nearest ones. Without a provider the read tools say so and the write tools refuse. Each editor adds its own:

| Provider factory | Extra tools |
|---|---|
| `createVideoEffectsToolProvider` | `add_video_effect_clip`, `set_video_effect_transition`, `set_video_effect_keyframes` |
| `createImageEffectsToolProvider` | `add_effect_layer` |
| `createAnimationEffectsToolProvider` | `add_vector_effect` |
| `createVectorEffectsToolProvider` | none |
| `createCanvasEffectsToolProvider` | `set_canvas_effect_mode`, `list_scene_transitions`, `set_scene_transition` |
| `createPaintEffectsToolProvider` | `set_paper_effect`, `add_effect_layer`, `fill_layer_with_effect` |

The tools are described in each domain's skill (and, for the image editor, `skills/pixerate-image-editor/references/provider-effects.md`).

## Camera moves

A `camera` effect moves a scene's camera rather than drawing pixels: Flair's `camera-glide`, `camera-whip-pan`, `camera-punch-zoom` and `camera-cut` get the camera from one framing to the next, and `camera-ken-burns` and `camera-crash-zoom` move it while a shot holds. A provider offers them by setting `capabilities.supportsCamera` and implementing `cameraView`; a provider without them is unchanged and conforms as before.

- **Summary.** A camera effect has `kind: 'camera'`, exactly the use `camera` (so pixel editors never offer it) and `camera: { role, durationMs, cut? }`. `role` is `transition` (from one framing to the next) or `hold` (within one framing while the shot holds); `durationMs` is the move's default length (0 for a cut); `cut` (0–1) is where the view jumps, 0.5 for a whip pan or punch zoom. `duration`, when given, equals `durationMs`.
- **`cameraView(id, { from, to, u, ms, stage }, values?)`** returns a `CameraView` (`{ zoom, scrollX, scrollY, tilt?, turn?, roll?, perspective?, blur?, blurAngle? }`, the shape of Flair's `View`): where the camera looks `u` (0–1) of the way through a move of `ms` from `from` to `to` (the same framing for a hold) on a `stage` of `{ width, height }` pixels. It is synchronous and pure, so editors can call it per frame or cache it. Errors are typed: unknown ids, invalid values, and a non-camera effect or a `u` outside 0–1 (`unsupported`).
- **`sampleCameraMove(id, { from, to, ms, stage, fps, values? })`** is optional and returns `{ keys: [{ t, view }], cut? }`: one key per frame from 0 to `ms`, and at a cut two keys at the same `t` (just before, then after), so tweening between keys never crosses the jump. `sampleEffectCameraMove(provider, id, request)` uses it, or falls back to `cameraView` per frame through `sampleCameraViews`.
- **No pixels.** `createRenderer` for a camera effect may refuse with `EffectUnsupportedError` and a sentence saying why; thumbnails show "Camera".
- **Checks.** `checkEffectProvider` checks the summary fields, that camera moves are listed only with `supportsCamera`, and calls `cameraView` along a probe move (a view at each step, the same view twice, refusing unknown ids, other kinds and unknown controls), and compares `sampleCameraMove` with it at both ends. `createFakeEffectProvider({ camera: true })` adds three camera moves: `fake.glide`, `fake.whip` (cuts at 0.5) and `fake.drift` (a hold).
- **Agents.** `search_effects` filters by `kind: 'camera'` and returns each move's `camera` fields; `describe_effect` reports them with `appliesHere: false` in the editors that cannot use them yet. The animation and video editors adopt camera moves (shot cameras, baked holds, whip and punch transitions) in follow-ups, with their own tools.

## Sequence templates

A template is a sequence of shots with typed slots that a person (through a form) or an agent fills: Flair's `product-reveal`, `before-after`, `stat-countdown` and others. A provider offers them by setting `capabilities.supportsTemplates` and implementing all three methods; a provider without them is unchanged and conforms as before.

- **`listTemplates({ query?, tags?, limit? })`** returns summaries: `{ id, name, description, tags?, shots, durationMs? }`. `searchTemplateSummaries` applies the options.
- **`describeTemplate(id)`** adds `slots`, in the order a form shows them. Each has a `name`, `label`, optional `description` and a `type`: `image`, `video` or `svg` (subject slots, with `hasDefault` instead of their default, which can be large), `text` (`default`, `maxLength?`), `color` (`default` as `#RRGGBB`) or `number` (`default`, `min?`, `max?`, `integer?`). This is the shape of Flair's `describeTemplateSlots`.
- **`instantiateTemplate(id, values?, { name? })`** fills the slots and returns `{ ok: true, sequence, openSlots, notes }`, or `{ ok: false, errors }` with a sentence for every value that does not fit, all at once. Slots left out take their defaults. A subject slot takes a URL, markup, a subject object, or `{ slot: name }` to leave it for the host; `openSlots` lists those left open. `notes` says what the provider left out because a sequence cannot hold it.
- **`EffectSequence`** is what a template fills to: `{ name, title?, stage: { width, height }, shots }`. Each shot has `hold` (ms after its lead-in), `title?`, `caption?`, `camera?: { framing?, in?, during? }` (camera moves as `CameraMoveSpec`), `layers` (bottom to top) and `transition?`.
  - A **layer** (`EffectLayer`, the shape of Flair's `SceneLayer`) is an effect (`effect`, `preset`, `values`) that may take a `subject` (`{ image }`, `{ video }`, `{ svg }`, `{ text }` or `{ slot }`). A layer can also be a bare subject. Its other fields are `role` (`background`, `subject` or `overlay`), `rect` (stage units; absent fills the screen), `from` / `until` (ms, or `{ shots: n }`), `opacity` and `fade`. The subject feeds the effect's `source` input, else its first image input (`effectLayerInput`). A layer's effect is a generator, filter, overlay or title (`effectLayerOffered`).
  - A **transition** (`EffectShotTransition`, Flair's `ShotTransition`) names an effect with the use `transition`, plus `ms` (default 800), `preset` and `values`. It blends the outgoing shot's last frame (`from`) into the incoming shot (`to`) as `progress` runs from 0 to 1. The first shot has none.
- **Helpers.**
  - `templateValuesSchema(slots)` is a strict JSON Schema for the values, for tools and forms.
  - `checkTemplateValues(slots, values)` gives the same sentences before asking the provider.
  - `templateDefaultValues(slots)` gives an example to change.
  - `checkEffectSequence(sequence, catalog?)` checks a sequence before an editor loads it.
- **Checks.** `checkEffectProvider` checks the following:
  - the flag agrees with the methods;
  - template ids are unique;
  - each slot is sound, and its default fits;
  - unknown ids reject with `unknown_template`;
  - each template fills with its defaults to a sound sequence whose effects are in `list()`;
  - `openSlots` covers the `{ slot }` subjects;
  - an unknown slot together with a value of the wrong type gives `ok: false` with an error for each.
- **Fake templates.** `createFakeEffectProvider({ templates: true })` adds two templates:
  - `fake.title-sequence` (text, colour and number slots; a gradient, a lower-third bar and a crossfade);
  - `fake.picture-reveal` (an image slot with a default, and one without, which is left for the host).

## Effect authoring

Providers that let effects be edited, not only used, set `capabilities.supportsAuthoring: true` and implement `openAuthoring(source)`, which returns an `EffectAuthoringSession` (`packages/core/src/effects/authoring.ts`). Both are optional: a provider without them is unchanged and conforms as before.

```ts
const session = await provider.openAuthoring!({ effectId: 'fake.tint', preset: 'Sepia' });
// or reopen a saved document: provider.openAuthoring!({ document: saved })

session.setValue('amount', 0.8);                          // one undo step; slider drags merge by `gesture`
session.setKeyframe('amount', 1000, 0.2, 'ease-in-out');   // animated controls take keyframes
session.seek(500);
session.getState().values.amount;                          // the value at the playhead
const saved = session.exportDocument();                    // plain JSON
```

### The session

- **State.** `getState()` returns the same object until something changes (so `useSyncExternalStore` and Svelte runes can use it directly) and `subscribe(listener)` reports every change. It holds the description (controls, defaults, presets), `values` at the playhead, `tracks` (keyframes per control), `source` and `sourceLanguage` (`'glsl' | 'svg' | null`), `issues` (with 1-based `line` when known), `compiled`, `time`, `duration`, `loop`, `playing`, `canUndo` and `canRedo`.
- **Edits return results, never throw.** `setValue`, `setValues` (all or nothing), `resetValues`, `applyPreset`, `savePreset`, `setKeyframe`, `removeKeyframe`, `clearTrack` and `setTiming` return `{ ok: true }` or `{ ok: false, message }`; a refusal changes nothing and its message names the control and the valid choices. Setting an animated control keys it at the playhead.
- **Source.** `setSource(source)` is optional and only present when `sourceLanguage` is not null. It returns the compile `issues`.
- **Playback and history.** `play`, `pause`, `seek`, `undo` and `redo`. Playback and seeking are not undo steps.
- **Preview.** `createPreview({ width, height })` returns an `EffectRenderer` that draws the session's current effect; `render({ time })` uses the keyframed values for that time unless `values` is given. Filters and transitions need input pictures: `effectSampleInputs(description, size)` gives sample ones.
- **Documents.** `exportDocument()` gives `{ version: 1, providerId, effectId, name, values, tracks, presets, duration, loop }`. Reopening checks it against the effect and throws `EffectControlError` naming each problem.

`createEffectAuthoringSession(source, { provider, history?, schedule?, mergeWindowMs? })` (`authoring-session.ts`) is a generic session over any provider's `describe` and `createRenderer`: values, presets, keyframes, timing, playback and undo, with no source editing. The fake provider's `openAuthoring` uses it. Motion effects can't be authored (`EffectUnsupportedError`). `checkEffectProvider` opens a session when `supportsAuthoring` is set and checks state identity, refusals, undo and the document round trip (`authoring: false` skips it).

### Agent tools

`createEffectAuthoringToolProvider({ session: () => session, capture? })` (`authoring-tools.ts`) serves the open session, documented in the [`pixerate-effect-authoring`](../packages/core/skills/pixerate-effect-authoring/SKILL.md) skill:

| Tools | |
| :--- | :--- |
| `effect_authoring_describe` | Controls, values, presets, animated tracks, timing and issues |
| `effect_authoring_get_source`, `effect_authoring_set_source` | Read the source; replace it and get compile issues (only listed when the session has `setSource`) |
| `effect_authoring_set_values`, `effect_authoring_reset_values` | Set controls (all or nothing) or reset them |
| `effect_authoring_apply_preset`, `effect_authoring_save_preset` | Presets |
| `effect_authoring_set_keyframe`, `effect_authoring_remove_keyframe`, `effect_authoring_clear_track` | Keyframes, with any easing (presets, cubic-bezier, spring, elastic) |
| `effect_authoring_set_timing`, `effect_authoring_seek` | Duration, loop and the playhead |
| `effect_authoring_undo`, `effect_authoring_redo` | History |
| `effect_authoring_view` | A picture of the preview (only listed when the host gives `capture`) |

With no session open, every tool refuses and says how to open one.

### Components

- **React:** `useEffectAuthoring(session)` and `<EffectAuthoringEditor session={session} />` from `@pixerate/editor-react/effects`.
- **Svelte:** `effectAuthoringOf(() => session)` and `<EffectAuthoringEditor {session} />` from `@pixerate/editor-svelte/effects`.

The editor has a toolbar (play, undo, redo, save preset), a preview canvas, a source pane (a plain textarea with line numbers and issue markers, shown only when the session has source), the parameter panel with a keyframe diamond per control, and a timeline (scrubber, duration, loop, keyframe rows per animated control). `EffectParameters` gained `onPresetName` and a per-control addon (`renderControlAddon` in React, the `addon` snippet in Svelte) for this.

## Writing a provider

1. Implement `EffectProvider`. Return summaries (with `tags`) from `list` / `search` (`searchEffectSummaries` applies every `EffectSearchOptions` filter, `tags` included), and a full `EffectDescription` (controls with ranges and units, defaults, presets) from `describe`.
2. Throw the typed errors: an unknown id, invalid values, or something the provider can't do (a vector effect in a Worker, float output without float support).
3. Make `render` deterministic for the same request, and free GPU or Worker resources in `dispose`.
4. For camera moves, set `supportsCamera`, give each `camera: { role, durationMs, cut? }` and the use `camera`, and implement `cameraView` as a pure function (see [Camera moves](#camera-moves)).
5. For sequence templates, set `supportsTemplates` and implement `listTemplates`, `describeTemplate` and `instantiateTemplate`. Fill to an `EffectSequence` that names only effects you list, and return value problems as `{ ok: false, errors }` rather than throwing (see [Sequence templates](#sequence-templates)).
6. Run `checkEffectProvider` in your tests.

See [outstanding.md](./outstanding.md) for what is not done here.
