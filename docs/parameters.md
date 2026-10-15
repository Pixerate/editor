# Parameters editor

`@pixerate/editor/parameters` is a headless, schema-driven control panel: the sliders, toggles, colour pickers and presets that every effect, shader, generator or component-props UI needs. One schema drives the panel, validation, undo, presets, keyframe diamonds and the agent tools. React (`@pixerate/editor-react/parameters`) and Svelte (`@pixerate/editor-svelte/parameters`) add the same hooks / runes and components.

## Schema

```ts
import type { ParameterSchema } from "@pixerate/editor/parameters";

const schema: ParameterSchema = {
  title: "Glow",
  fields: [
    { id: "speed", type: "number", min: 0, max: 4, step: 0.05, unit: "x", default: 1, description: "Spin speed." },
    { id: "steps", type: "int", min: 1, max: 64, default: 16 },
    { id: "grain", type: "boolean", label: "Film grain", default: false },
    { id: "shape", type: "choice", control: "segmented", options: ["orb", "rings", { value: "bars", label: "Bars" }], default: "orb" },
    { id: "tint", type: "color", default: "#f43f5e" },                 // "#rrggbb"
    { id: "fog", type: "color", alpha: true, default: "#00000080" },   // "#rrggbbaa"
    { id: "center", type: "vector", size: 2, min: -1, max: 1, default: [0, 0] },
    {
      type: "group",
      id: "pattern",
      collapsed: true,
      showIf: { shape: { ne: "orb" } },          // hidden for orbs
      fields: [{ id: "count", type: "int", min: 2, max: 24, default: 8 }],
    },
    { id: "photo", type: "image", default: "", options: [{ url: "/a.jpg", label: "A" }] },
    { id: "caption", type: "text", default: "", maxLength: 40 },
  ],
  presets: [{ name: "Neon", values: { shape: "rings", tint: "#38bdf8" } }],
};
```

- Every field has `id`, `default`, and optional `label` (defaults to the id made readable: `flowSpeed` → "Flow speed"), `description`, `showIf`, `readOnly` and `randomize: false`.
- `number` / `int` show a slider plus number box when both `min` and `max` are set (`control: "input"` for a number box only). The step defaults to 1 for `int` and 1/100 of the range otherwise.
- `showIf` maps other ids to tests, all of which must hold: a literal (equals), an array (one of), or `{ eq, ne, in, notIn, gt, gte, lt, lte, truthy }`. A function `(values) => boolean` also works. Hidden fields keep their values; a hidden group hides its fields.

## Controller

```ts
import { ParametersController, createParameterKeyframeStore } from "@pixerate/editor/parameters";

const params = new ParametersController({ schema, history /* optional shared HistoryManager */ });

params.setValue("speed", 2);           // { ok: true, value: 2 }
params.setValue("speed", 9);           // { ok: false, message: "Speed must be at most 4." } — nothing changes
params.setValues({ speed: 1, steps: 4 }); // one undo step, all-or-nothing

params.beginGesture("speed");          // a slider drag…
params.setValue("speed", 1.5);
params.setValue("speed", 1.8);
params.endGesture();                   // …is one undo step

params.reset(["speed"]);
params.randomize({ seed: 42 });        // within ranges, snapped to steps; skips hidden, image and text fields
params.applyPreset("Neon");            // fields the preset leaves out go back to their defaults
params.savePreset("Mine");
params.undo();

const unsubscribe = params.subscribe((state) => render(state.values));
params.getState();                     // the same object until something changes
```

- `getState()` holds `values`, `defaults`, `visible`, `collapsed`, `errors` (the last refused value per field), `presets`, `activePreset`, `modified`, `canUndo` / `canRedo`, `time` and `keys`.
- Values are validated, never guessed: `int`s round and colours normalise to lower-case hex, anything else invalid is refused with a sentence (`{ path: "/speed", id, message }`, the same shape as `validateJsonSchema`).
- `setSchema(next)` (for example after a shader recompiles) keeps the values that still fit. `toJSON()` / `load()` save and restore values and user presets.

## Keyframes

Pass a `keyframes` adapter to get keyframe diamonds. Tracks have the `AnimationTrack` shape from `@pixerate/editor/animation`: `{ keyframes: [{ time /* ms */, value, easing? }] }`, and those tracks are accepted as they are. `createParameterKeyframeStore()` keeps them in memory; an effect document can implement `getTrack` / `setTrack` / `subscribe` over its own storage.

```ts
const keyframes = createParameterKeyframeStore();
const params = new ParametersController({ schema, keyframes });
params.setTime(1000, evaluatedValues);  // move the playhead and show interpolated values (no undo step)
params.keyState("speed");               // "none" | "animated" | "keyed"
params.toggleKeyframe("speed");         // add or remove a key at the playhead (one undo step)
params.setValue("speed", 3);            // on a key, the key follows the value
```

Interpolation stays with the timeline that owns playback (Flair's effect editor, the canvas animation player). For number and colour tracks, `evaluateTrack(track, time)` from `@pixerate/editor/animation` gives the eased value to pass to `setTime`; the demo's Parameters tab does exactly that.

## Agents

```ts
import { CommandRegistry, createCommandToolProvider } from "@pixerate/editor/commands";
import { createParameterCommands } from "@pixerate/editor/parameters";

const registry = new CommandRegistry();
registry.register(createParameterCommands(params)); // parameters.list, .set, .reset, .randomize, .applyPreset, .savePreset, .deletePreset, .toggleKeyframe
toolRegistry.register(createCommandToolProvider(registry, { id: "commands" }));
```

`parameters.set` takes `{ values: { id: value } }`; its params schema is generated from the current parameter schema (`parameterSchemaToJsonSchema`), so agents see types, ranges and choices.

## Shader controls

`parameterSchemaFromShaderControls` maps Flair-style `@control` definitions (`float`, `int`, `bool`, `vec2`–`vec4`, `sampler2D`, with a `color` flag) to a schema. Colour vectors become hex colour fields; `shaderControlValue` turns them back into 0–1 RGB(A) arrays for the uniform.

```ts
import { parseControls } from "@pixerate/flair";
const controls = parseControls(shaderSource);
const params = new ParametersController({ schema: parameterSchemaFromShaderControls(controls) });
params.subscribe(({ values }) => {
  for (const c of controls) effect.setUniform(c.name, shaderControlValue(c, values[c.name]));
});
```

## UI

```tsx
// React
import { ParametersPanel, useParametersController, useParameterCommands } from "@pixerate/editor-react/parameters";

function EffectControls() {
  const params = useParametersController({ schema });
  useParameterCommands(registry, params);
  return <ParametersPanel controller={params} resolveFile={(file) => URL.createObjectURL(file)} />;
}
```

```svelte
<!-- Svelte -->
<script lang="ts">
  import { ParametersController } from "@pixerate/editor/parameters";
  import { ParametersPanel, useParameterCommands } from "@pixerate/editor-svelte/parameters";
  const params = new ParametersController({ schema });
  useParameterCommands(registry, params);
</script>

<ParametersPanel controller={params} />
```

The field controls (`ParameterSlider`, `ParameterToggle`, `ParameterSelect`, `ParameterColor`, `ParameterVector`, `ParameterImage`, `ParameterText`, `KeyframeDiamond`, `ParameterFieldControl`) take `{ field, value, onChange, onGestureStart, onGestureEnd }` (Svelte: `onchange`, `ongesturestart`, `ongestureend`), so they also work without a controller. They use the shadcn-style Tailwind tokens (`background`, `foreground`, `muted`, `input`, `border`, `primary`, `destructive`).
