# Effects providers

`@pixerate/editor/effects` is a contract for **catalogs of visual effects** (shaders, vector pictures, motion) that the editors can use without depending on any one effects library. The package ships the contract, its checks, a fake provider and the shared agent tools. It imports nothing: no GPU code, no Flair. Without a provider, every editor behaves as it did before effects support existed.

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

- **Kinds** are `shader`, `vector` and `motion`. **Uses** are `filter`, `transition`, `generator`, `overlay`, `title`, `motion` and `interactive`; each editor offers the uses that make sense in it.
- **Capabilities:** `supportsWorker`, `supportsFloat`, `supportsMask`, `supportsHostImages`, `supportsVector` and an optional `maxSize`. Editors check them before asking for something (16/32-bit pixels, masks, vector output).
- **Errors** (`errors.ts`) are typed with codes: `unknown_effect`, `invalid_values`, `unsupported`, `disposed` and `no_provider` (`UnknownEffectError`, `EffectControlError`, `EffectUnsupportedError`, `EffectDisposedError`, `NoEffectsProviderError`; `isEffectError`). Agent tools turn them into `isError` results.
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
4. Run `checkEffectProvider` in your tests.

See [outstanding.md](./outstanding.md) for what is not done here.
