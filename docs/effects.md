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

`createEffectToolProvider(host)` (`effects/tools.ts`) gives every editor the same six tools: `search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect` and `remove_effect`. Without a provider the read tools say so and the write tools refuse. Each editor adds its own:

| Provider factory | Extra tools |
|---|---|
| `createVideoEffectsToolProvider` | `add_video_effect_clip`, `set_video_effect_transition`, `set_video_effect_keyframes` |
| `createImageEffectsToolProvider` | `add_effect_layer` |
| `createAnimationEffectsToolProvider` | `add_vector_effect` |
| `createVectorEffectsToolProvider` | none |
| `createCanvasEffectsToolProvider` | `set_canvas_effect_mode`, `list_scene_transitions`, `set_scene_transition` |
| `createPaintEffectsToolProvider` | `set_paper_effect`, `add_effect_layer`, `fill_layer_with_effect` |

The tools are described in each domain's skill (and, for the image editor, `skills/pixerate-image-editor/references/provider-effects.md`). There is no separate effects skill.

## Writing a provider

1. Implement `EffectProvider`. Return summaries from `list` / `search`, and a full `EffectDescription` (controls with ranges and units, defaults, presets) from `describe`.
2. Throw the typed errors: an unknown id, invalid values, or something the provider can't do (a vector effect in a Worker, float output without float support).
3. Make `render` deterministic for the same request, and free GPU or Worker resources in `dispose`.
4. Run `checkEffectProvider` in your tests.

See [outstanding.md](./outstanding.md) for what is not done here.
