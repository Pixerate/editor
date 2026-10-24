# Shared colour module and colour picker: implementation plan

Status: **not started.** This plan covers the first implementation only:

1. A DOM-free colour module in core: `@pixerate/editor/color`.
2. Agent tools and an agent skill for it.
3. A `ColorPicker` component in React and Svelte, built on a headless picker model in core.
4. **Dual colours:** one value that holds a light-mode colour and a dark-mode colour, so a UI that supports both modes uses the right one. This includes core helpers (CSS `light-dark()`, resolving per mode, generating the other half, contrast in both modes), agent tools, a scheme hook and a `DualColorPicker` in React and Svelte.
5. Using the picker in one place, the parameters panel's colour field.
6. **Gradients, as an opt-in layer:**
   - a gradient model and a headless `GradientController` in core: `@pixerate/editor/gradient`
   - agent tools for the controller
   - a `GradientEditor` in React and Svelte, plus a `FillPicker` that switches between a solid colour and a gradient
7. Moving a few duplicated helpers in other domains onto the new module, without changing what they return.

**What "optional" means for gradients.** Gradients live in their own subpath in every package (`@pixerate/editor/gradient`, `@pixerate/editor-react/gradient`, `@pixerate/editor-svelte/gradient`). `ColorPicker` and `@pixerate/editor/color` never import gradient code, so a consumer who only wants solid colours doesn't bundle it. Gradient code may import `color`; `color` must never import gradient code. Entry-isolation tests enforce this (Phases 7.5 and 8.4).

A palette or theme editor (ramps, roles, ASE / GPL export) is **out of scope**. It comes later, on top of this module.

Read the whole plan before you start. Do the phases in order and finish each one, with its checks passing, before you start the next. Every phase ends in a state that can be committed on its own.

---

## Why

Colour code is spread across the repo:

- **Parsing and conversion is written about 15 times.** There are hex / CSS parsers and RGB ↔ HSL / HSV / hex converters in `tokens/color.ts`, `chart/color.ts`, `paint-editor/color.ts`, `parameters/schema.ts`, `vector/gradient.ts`, `raster/effects/model.ts`, `image-editor/layers/css-color.ts`, `export/units.ts`, `paint/gradient-paint.ts` and more.
- **The Oklab maths is written four times:** `animation/color.ts`, `chart/color.ts`, `paint/gradient-paint.ts` and `raster/blend.ts`.
- **Useful checks are hidden inside single domains.** Contrast and colour-blind simulation live in `chart/color.ts`. Harmonies live in `paint-editor/color.ts`.
- **The pickers are thin.** There are about 29 native `<input type="color">` fields in the React package, mirrored in Svelte. They have no alpha, no OKLCH, no swatches and no contrast feedback.

---

## Ground rules (read first)

Everything in [`AGENTS.md`](../AGENTS.md) applies. These points matter most for this work:

- **Don't break public APIs.** Every function that is exported today keeps its name, signature and output. When you move logic into `src/color`, the old function stays where it is as a thin wrapper that calls the new one. If a wrapper can't give byte-identical results, leave the old code alone and write a note in the PR description. Don't "fix" it.
- **No dependencies.** `src/color` must not import TipTap, ProseMirror, dagre, any framework, or any npm package. It may import from `../cms/math` and nothing else outside `src/color`.
- **Match the style of each file.** Core `src/tokens`, `src/chart` and `src/animation` use tabs and single quotes. `src/paint-editor` and `src/cms` use 2 spaces. New files in `src/color` use **tabs and single quotes**, like `src/tokens/color.ts`. React and Svelte files use 2 spaces and double quotes, like their neighbours. Comments are short JSDoc on exports, as in `src/tokens/color.ts`.
- **Spelling.** Code identifiers use `color`. Prose (descriptions, docs, skill text) uses British "colour", like the rest of the repo.
- **Keep third-party attribution.** `chart/color.ts` contains ported code (the Machado colour-vision matrices). If you move that code, copy its header comment to the new file. Then update the line that names the file in **both** `THIRD_PARTY_NOTICES.md` (repo root) and `packages/core/THIRD_PARTY_NOTICES.md`.
- **No APCA.** Use WCAG 2 contrast only. APCA's licence is not MIT-compatible.
- **Commit messages** follow Conventional Commits (`feat(core): …`, `feat(react): …`, …). Add a changeset (`pnpm changeset`) to every commit that touches `packages/core`, `packages/react` or `packages/svelte`: `minor` for new APIs, `patch` for internal refactors.
- **Commands** (run from the repo root):
  ```bash
  pnpm --filter @pixerate/editor build
  ```
  ```bash
  pnpm test
  ```
  To run one core test file quickly while you work: `pnpm --filter @pixerate/editor exec vitest run tests/color.test.ts`.
  Some tests (`entry-isolation`, `check:packages`) read `dist/`, so build first.

**When to stop and ask the user:** stop when an existing test fails after a refactor and the only fix is to change the test's expected value; when a step seems to need a new npm dependency; or when something below doesn't match the code you find.

---

## Phase 1: core colour module (`packages/core/src/color`)

### 1.1 Files and API

Create these files. Every exported function gets a one-line JSDoc that gives units and ranges.

**`types.ts`**

```ts
/** sRGB, gamma-encoded. Channels are nominally 0–1 but may fall outside for wide-gamut input; alpha 0–1. */
export interface Rgba { r: number; g: number; b: number; a: number }
/** OKLab: l 0–1; a and b roughly −0.4–0.4; alpha 0–1. Same shape as `OklabColor` in `animation/color.ts`. */
export interface Oklab { l: number; a: number; b: number; alpha: number }
/** OKLCH: l 0–1, c ≥ 0 (≈0.4 max in practice), h in degrees 0–360 (NaN-free: use 0 when c is 0); alpha 0–1. */
export interface Oklch { l: number; c: number; h: number; alpha: number }
/** h in degrees 0–360; s, l / v 0–1; alpha 0–1. */
export interface Hsla { h: number; s: number; l: number; alpha: number }
export interface Hsva { h: number; s: number; v: number; alpha: number }
export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'oklab' | 'p3';
export type ColorVision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';
```

**`convert.ts`** (pure maths, no parsing)

- `srgbToLinear(v)` / `linearToSrgb(v)`. These must keep the sign for negative input: `sign(v) * f(|v|)`.
- `rgbToHsl` / `hslToRgb` and `rgbToHsv` / `hsvToRgb`, all on `Rgba` with 0–1 channels.
- `rgbToOklab(rgba): Oklab` / `oklabToRgb(lab): Rgba`. **Don't clamp** in `oklabToRgb`. Copy the constants from `animation/color.ts`.
- `oklabToOklch` / `oklchToOklab`. Hue is in degrees, normalised to 0–360. When `c < 1e-6`, set `h = 0`.
- `linearSrgbToDisplayP3(rgb)` / `displayP3ToLinearSrgb(rgb)` (linear in, linear out). Build the matrices once, at module load, with `rgbToXyzMatrix` and `invert` from `../cms/math`:
  - sRGB primaries: `[0.64, 0.33]`, `[0.30, 0.60]`, `[0.15, 0.06]`
  - P3 primaries: `[0.680, 0.320]`, `[0.265, 0.690]`, `[0.150, 0.060]`
  - White point: D65 `[0.3127, 0.329]`

  Read `cms/math.ts` first to see the exact argument shapes.

**`named.ts`**

- `NAMED_COLORS: Readonly<Record<string, string>>`: the 148 CSS named colours (lowercase name → `#rrggbb`), plus `transparent: '#00000000'`.

**`parse.ts`**

- `parseColor(input: unknown): Rgba | null`. It accepts:
  - everything `normalizeTokenColor` in `tokens/color.ts` accepts today, including the `{ r, g, b, a? }` object and the W3C `{ colorSpace, components, alpha?, hex? }` object. Read that function and keep its rules, including the 200-character limit and linear-time regexes.
  - CSS named colours, case-insensitive
  - `hsl()` / `hsla()`, with comma or space syntax and `/ alpha`. The hue may carry `deg` or no unit.
  - `oklab(L a b / A)` and `oklch(L C H / A)`. L may be a number (0–1) or a percentage.
  - `color(srgb r g b / A)`, `color(srgb-linear …)` and `color(display-p3 …)`

  It returns `null` for anything else, including `var(--x)`, `currentColor` and empty strings. It never throws. Wide-gamut input comes back **unclamped**.
- `isColor(input: unknown): boolean`

**`format.ts`**

- `formatHex(c: Rgba): string`. Gamut-maps first (see `gamut.ts`), then writes lowercase `#rrggbb`, or `#rrggbbaa` when alpha < 1. The output must be identical to `rgbaToHex` in `tokens/color.ts` for in-gamut colours.
- `formatColor(c: Rgba, format: ColorFormat): string`. Output formats:
  - `hex`
  - `rgb(r g b)` or `rgb(r g b / a)`, with integers 0–255
  - `hsl(h s% l%)`
  - `oklch(L C H)`, with L as a percentage to 2 decimals, C to 4 decimals, H to 2 decimals
  - `oklab(…)`
  - `color(display-p3 r g b)`, to 4 decimals
- `normalizeColor(input: unknown): string | null`, which is `parseColor` followed by `formatHex`.

**`gamut.ts`**

- `inSrgbGamut(c: Rgba, epsilon = 1e-5): boolean`
- `toSrgbGamut(c: Rgba): Rgba`. This is the CSS Color 4 gamut-mapping algorithm ("binary search on OKLCH chroma"):
  1. Convert to OKLCH.
  2. If L ≥ 1, return white. If L ≤ 0, return black (both keep alpha).
  3. If the colour is in gamut, return it.
  4. Otherwise binary-search chroma between 0 and the current C. At each step, clip the candidate to 0–1. Stop when the ΔE<sub>OK</sub> between the clipped and unclipped candidate is under 0.02 and above 0.02 − 0.0001, or after 30 iterations.
  5. Return the clipped candidate.
- `deltaEOK(a: Rgba, b: Rgba): number` (Euclidean distance in OKLab)

**`contrast.ts`**

- `relativeLuminance(c: Rgba): number`. This is the WCAG 2 formula: linearise, then `0.2126 R + 0.7152 G + 0.0722 B`.
- `contrastRatio(foreground: Rgba, background: Rgba): number`, from 1 to 21. If the foreground is translucent, composite it over the background first. If the background is translucent, composite it over white first.
- `contrastLevel(ratio: number, options?: { large?: boolean }): 'AAA' | 'AA' | 'fail'`. Normal text needs AA ≥ 4.5 and AAA ≥ 7. Large text needs AA ≥ 3 and AAA ≥ 4.5.
- `readableTextColor(background: Rgba, candidates: readonly Rgba[] = [black, white]): Rgba`. Returns the candidate with the highest ratio.

**`vision.ts`**

- `simulateColorVision(c: Rgba, vision: ColorVision): Rgba`. Move the matrices and logic out of `simulateChartVision` in `chart/color.ts`, together with the attribution header.
- `checkPaletteColors(colors: readonly string[], options?)`. Move the body of `checkChartColors` here. Rename the types: `ChartColorCheck` becomes `PaletteColorCheck`, and the same pattern applies to the pair and options types. The options stay `surface`, `minDistance` (default 0.08), `minContrast` (default 1.5) and `visions`. Keep the issue sentences **exactly** as they are; chart tests assert them.

**`harmony.ts`**

- Move `ColorWheel`, `wheelToHue`, `hueToWheel`, `HarmonyKind`, `HARMONY_KINDS`, `HarmonyColor` and `colorHarmony` here from `paint-editor/color.ts`. Keep their signatures and outputs, which are hex strings in and out. `colorHarmony` currently throws on bad input through `parseHexColor`. Keep the same error message.
- If moving them would pull `paint/gradient-paint` into `src/color`, move only the harmony functions and leave the swatch code in `paint-editor`.

**`mix.ts`**

- `mixColors(from: unknown, to: unknown, t: number, options?: { space?: 'oklab' | 'oklch' | 'srgb' | 'srgb-linear' }): string | null`. The default space is `'oklab'`. Alpha is premultiplied, as in `mixColorsOklab` in `animation/color.ts`, and hue takes the shorter way round for OKLCH. With `space: 'oklab'` the output must equal `mixColorsOklab(from, to, t)` for every input.

**`recent.ts`**

- `pushRecentColor(list: readonly string[], color: string, max = 12): string[]`. Normalises the colour, moves it to the front, removes duplicates and trims the list to `max`. Returns the list unchanged when the colour can't be read.

**`index.ts`**

- `export *` from every file above, except `tools.ts`, `picker.ts` and `dual.ts`, which you add to this file in Phases 2, 3 and 5.

### 1.2 Register the entry point

Add `color` everywhere `tokens` is registered. Copy the `tokens` lines exactly and rename them:

- `packages/core/tsup.config.ts`: add `"color/index": "src/color/index.ts",`
- `packages/core/package.json` `exports`: add a `"./color"` block shaped like `"./tokens"`.
- `packages/core/tests/entry-isolation.test.ts`: add `"color/index.js"` to the "pulls in no third-party packages" list.
- `packages/core/README.md`: add `@pixerate/editor/color` to the list of entry points.

### 1.3 Tests: `packages/core/tests/color.test.ts`

At minimum:

- **Parsing**
  - every form listed in 1.1
  - `#ABC` → `#aabbcc`
  - `#aabbccff` → `#aabbcc`
  - `rgb(255 0 0 / 50%)` → `#ff000080`
  - `hsl(120 100% 25%)` → `#008000`
  - `rebeccapurple` → `#663399`
  - `oklch(62.8% 0.2577 29.23)` → about `#ff0000`, each channel within 1/255
  - `null` for `var(--x)`, `''`, `'#ggg'`, a 201-character string, `{}` and `42`
- **Parity with tokens:** for a list of about 20 inputs taken from `tests/canvas-tokens.test.ts` and the tokens tests, `normalizeColor(x) === normalizeTokenColor(x)`.
- **Round trips:** hex → OKLab → hex and hex → HSL → hex give the input back for 50 seeded random colours. Use a small inline LCG; don't use `Math.random`.
- **P3:** `parseColor('color(display-p3 1 0 0)')` is out of sRGB gamut. Its linear sRGB is about `(1.2249, -0.0421, -0.0196)` (tolerance 1e-3). `formatHex` of it is in gamut and still clearly red (r > 0.9).
- **Gamut:** `toSrgbGamut` of an in-gamut colour returns the same colour. Out-of-gamut results satisfy `inSrgbGamut`, and their lightness is within 0.02 of the input's.
- **Contrast:**
  - `contrastRatio(black, white)` = 21 (to 2 decimals)
  - `#777777` on white ≈ 4.48 → `fail`, or `AA` with `large: true`
  - translucent foreground compositing
- **Vision / harmony / mix:** for a few inputs, `checkPaletteColors` deep-equals `checkChartColors`, `colorHarmony` from color equals the paint one, and `mixColors(…, { space: 'oklab' })` equals `mixColorsOklab`.

### 1.4 Checks for Phase 1

```bash
pnpm --filter @pixerate/editor build
```
```bash
pnpm test
```

Both must pass. Commit as `feat(core): add shared colour module (@pixerate/editor/color)` with a `minor` changeset for `@pixerate/editor`.

---

## Phase 2: agent tools and skill

### 2.1 Provider: `packages/core/src/color/tools.ts`

Export `createColorToolProvider(options: { id?: string; namespace?: string } = {}): AgentToolProvider`:

- `id` defaults to `'color'` and `namespace` to `'color'`
- `title: 'Colour'`
- `description`: one or two sentences
- `skill: 'pixerate-color'`

Model it on `checkColors` in `src/chart/tools.ts`:

- Copy its `READ` annotations constant and its `fail` helper.
- Import `AgentTool` / `AgentToolProvider` **as types** from `'../tools'`.
- Every tool is read-only: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- Every schema has `additionalProperties: false`, `required` where needed, and a `description` on every property that gives units and defaults.
- Every colour argument says: "Any CSS colour: hex, rgb(), hsl(), oklch(), oklab(), color(display-p3 …) or a name."

The tools use names that don't clash with the paint editor's `color_harmony` and `mix_colors` or the image editor's `convert_colors`:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `inspect_color` | `color` (required) | `hex`, `alpha`, `rgb` (0–255 ints), `hsl`, `oklch`, `css` (an object with every `ColorFormat`), `inSrgbGamut`, `gamutMappedHex` (only when out of gamut), `relativeLuminance` |
| `check_color_contrast` | `foreground`, `background` (required), `large` (boolean, default false) | `ratio` (2 decimals), `level`, `passesAA`, `passesAAA`, and `suggestion`: when the pair fails AA, the nearest foreground in OKLCH lightness that passes (search L in steps of 0.01 towards black or white, whichever gets there first), as hex |
| `check_color_palette` | `colors` (array, minItems 2, required), `surface`, `minDistance`, `minContrast`, `visions` (enum array) | the `checkPaletteColors` result |
| `suggest_color_harmony` | `base` (required), `kind` (enum `HARMONY_KINDS`, required), `wheel` (`'rgb'` \| `'ryb'`, default `'rgb'`), `spread` (degrees, default whatever `colorHarmony` uses) | `colors: { hex, angle }[]` |
| `blend_colors` | `from`, `to` (required), `t` (0–1, required), `space` (enum, default `'oklab'`), `steps` (integer 2–32, optional: when given, ignore `t` and return evenly spaced stops) | `color` or `colors` |

**Errors:** when a colour can't be read, throw with an actionable message, for example `"teal-ish" is not a colour I can read; use hex (#2a4b8d), rgb(), hsl(), oklch() or a CSS colour name.`. When an argument is out of range, say what the range is.

Add `export * from './tools';` to `src/color/index.ts`.

### 2.2 Tests

- **`packages/core/tests/color-tools.test.ts`:** register the provider in a `ToolRegistry`. Call each tool through `registry.callTool` with valid arguments and check the result shape. Call each tool with invalid arguments (an unreadable colour, `t: 2`, a missing required argument, an extra property) and check `isError` and the message. Read `tests/chart-tools.test.ts` first to see how results and errors are unwrapped.
- **`packages/core/tests/command-tools.test.ts`:** in "built-in tool providers have complete MCP annotations", add `registry.register(createColorToolProvider());` next to the other `registry.register(...)` lines, and import it from `'../src/color'`.
- **`packages/core/tests/agent-skills.test.ts`:**
  - add `'pixerate-color': toolNames(createColorToolProvider()),` to `expectedBySkill()`
  - add `createColorToolProvider: 'pixerate-color',` to `FACTORIES`
  - import the factory

### 2.3 Skill: `packages/core/skills/pixerate-color/SKILL.md`

Use `skills/pixerate-parameters/SKILL.md` as the template for the structure.

- **Frontmatter:** `name: pixerate-color`, plus a `description` of 80–1024 characters with no `<` or `>`. Say when to use the skill: checking contrast or accessibility, choosing or checking palette colours, converting colour formats, harmonies, blends and gradients.
- **Mental model:**
  - colours are CSS strings
  - hex is the canonical output
  - OKLCH is the space for reasoning about lightness and chroma
  - wide-gamut colours are gamut-mapped when written as hex
- **Working method:**
  1. inspect
  2. check contrast or palette
  3. adjust in OKLCH lightness
  4. re-check
- **Best practices:**
  - WCAG thresholds (4.5 / 3 / 7)
  - check every text / background pair, not just the brand colour
  - `minContrast: 3` for chart marks and UI graphics
  - blend in OKLab, not sRGB
  - the RYB wheel is for painterly harmonies
- **Tool table:** one row per tool. The first cell is the backticked bare name.
- **Pitfalls:**
  - CSS variables can't be read; resolve them first
  - translucent colours are composited before contrast is measured
  - `#rrggbbaa` byte order
  - this module does not do ICC colour management: use the image editor's `cms` tools for that

Add a row to `packages/core/skills/README.md`'s table.

### 2.4 Demo

1. Create `apps/demo/src/components/ColorTab.tsx`. It registers the provider:
   ```ts
   const provider = useMemo(() => createColorToolProvider(), []);
   useAgentToolProvider(demoToolRegistry, provider);
   ```
   For now it can show a sentence and a contrast checker made of two `<input>`s; Phase 4 adds the picker.
2. In `apps/demo/src/App.tsx`:
   - add `"color"` to the `TabId` union
   - add a lazy import like the others
   - add `{ id: "color", label: "Colour", icon: Palette, hint: "Picker, contrast, harmonies" }` to the "Reference" group, importing `Palette` from `lucide-react`
   - add `{activeTab === "color" && <ColorTab />}` inside the `Suspense` block

### 2.5 Checks for Phase 2

Build, then `pnpm test`. Also run `pnpm --filter demo build`. Commit as `feat(core): add colour agent tools and pixerate-color skill` (`minor`), and `feat(demo): add colour tab` in the same PR.

---

## Phase 3: headless picker model (`packages/core/src/color/picker.ts`)

The picker's logic lives in core so that React and Svelte share it (see AGENTS.md §3). The functions are pure, with no DOM.

```ts
export interface ColorPickerState { h: number; s: number; v: number; alpha: number } // HSV, as the 2D area uses
export function pickerStateFromColor(input: unknown, previous?: ColorPickerState): ColorPickerState | null;
export function pickerStateToHex(state: ColorPickerState): string;                // formatHex
export function pickerStateFromArea(state: ColorPickerState, x: number, y: number): ColorPickerState; // x = s, y = 1 − v, both clamped 0–1
export function pickerStateFromHue(state: ColorPickerState, t: number): ColorPickerState;   // t 0–1 → h 0–360
export function pickerStateFromAlpha(state: ColorPickerState, t: number): ColorPickerState;
export function pickerKeyStep(state: ColorPickerState, target: 'area' | 'hue' | 'alpha', key: string, shift: boolean): ColorPickerState | null;
export function pickerAreaBackground(state: ColorPickerState): string;   // CSS: two linear-gradients over the pure hue
export function pickerAlphaBackground(state: ColorPickerState): string;  // CSS gradient from transparent to the opaque colour
export const PICKER_HUE_BACKGROUND: string;                              // CSS gradient through the hues
```

- **Hue and saturation memory.** `pickerStateFromColor(input, previous)` keeps `previous.h` when the new colour has no hue (s = 0 or v = 0), and keeps `previous.s` when v = 0. This stops the hue jumping to red when the user drags to black or grey.
- **Keyboard.** `pickerKeyStep`:
  - arrow keys move by 1%, or by 10% with Shift
  - Home / End go to 0 / 1
  - on the area, Left / Right change s and Up / Down change v
  - on the hue strip, a step is 1° (10° with Shift)
  - returns `null` for other keys
- **Scope.** The area is HSV only in this phase. An OKLCH area needs canvas rendering and is a follow-up. The text field still accepts OKLCH and P3 input through `parseColor`.

Export it from `src/color/index.ts`. Tests go in `packages/core/tests/color-picker.test.ts`. Cover:

- each function
- that the hue is kept for greys
- the keyboard steps and clamping
- that `pickerStateToHex(pickerStateFromColor(x)!)` round-trips 50 seeded hex colours

Commit with a `minor` changeset.

---

## Phase 4: `ColorPicker` in React and Svelte

### 4.1 Props: the same in both packages

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | `string` | any CSS colour; shown normalised |
| `onChange` | `(hex: string) => void` | fired continuously while dragging |
| `onGestureStart` / `onGestureEnd` | `() => void` | fired on pointer down and up on the area or a strip, and around keyboard steps. Hosts use them to make one drag one undo step, exactly as `ParameterColor`'s props do today (`packages/react/src/parameters/fields.tsx` around line 232) |
| `alpha` | `boolean`, default `false` | shows the alpha strip; output is then `#rrggbbaa` |
| `swatches` | `readonly string[]` | optional row of clickable swatches |
| `recent` / `onRecentChange` | `readonly string[]` / `(next: string[]) => void` | optional; update with `pushRecentColor` on gesture end |
| `contrastAgainst` | `string` | optional; shows `contrastRatio` and its level next to the preview |
| `disabled` | `boolean` | |
| `className` | `string` | |
| `id`, `aria-label` | `string` | labels the group |

### 4.2 What it renders

- A square area (`role="slider"`, `aria-label="Saturation and brightness"`, `aria-valuetext` such as `"Saturation 40%, brightness 70%"`, `tabIndex=0`) with `pickerAreaBackground` and a thumb.
- A hue strip (`role="slider"`, `aria-valuemin=0`, `aria-valuemax=360`).
- The alpha strip when `alpha` is set. Put it over the checkerboard class string that `ParameterColor` already uses.
- A text field that commits on Enter or blur through `parseColor`. If the text can't be read, show the input in an error state and keep the last good value. If the colour is outside sRGB, show a small "Outside sRGB: shown as #xxxxxx" line.
- The swatches and recent colours, as buttons with `aria-label` set to the hex value.
- An eyedropper button, only when `"EyeDropper" in window`. It calls `new EyeDropper().open()` and wraps the call in try/catch, because the user can cancel.
- Pointer handling: call `setPointerCapture` on pointer down, map coordinates relative to `getBoundingClientRect()`, and clamp to 0–1. Keyboard handling uses `pickerKeyStep`.
- Styling: Tailwind classes and shadcn tokens (`border-input`, `bg-background`, `text-muted-foreground`, …), matching `packages/react/src/parameters/fields.tsx`. No new CSS files.

**React**

- `packages/react/src/color/ColorPicker.tsx` and `packages/react/src/color/index.ts` (`export * from './ColorPicker';`).
- Keep the internal `ColorPickerState` in `useState`. When the `value` prop changes, re-sync with `pickerStateFromColor(value, previous)`, but only if the new value doesn't already equal `pickerStateToHex(state)`. Otherwise drags jitter.

**Svelte**

- `packages/svelte/src/color/ColorPicker.svelte` and `packages/svelte/src/color/index.ts`, shaped like `packages/svelte/src/tokens/index.ts`:
  ```ts
  export { default as ColorPicker } from "./ColorPicker.svelte";
  export type ColorPickerProps = ComponentProps<typeof ColorPickerComponent>;
  ```
- Use Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`). Callback props have the same names as in React.

### 4.3 Register the subpaths

- `packages/react/tsup.config.ts`: add `"color/index": "src/color/index.ts"`.
- `packages/react/package.json` and `packages/svelte/package.json` `exports`: add `"./color"`, copying the `"./tokens"` block in each.
- `packages/react/tests/entry-isolation.test.ts` and `packages/svelte/tests/entry-isolation.test.ts`: add `["color/index.js", "color"]` to the list.

### 4.4 Tests

`packages/react/tests/color-picker.test.tsx` and `packages/svelte/tests/color-picker.svelte.test.ts`. Copy the setup from `parameters.test.tsx` and `parameters.svelte.test.ts`. Test that:

- it renders with a value, and the text field shows the normalised hex
- typing `oklch(70% 0.1 200)` and pressing Enter calls `onChange` with a hex value
- typing garbage doesn't call `onChange`
- ArrowRight on the area calls `onGestureStart`, then `onChange`, then `onGestureEnd`
- with `alpha`, the alpha strip appears and the output has 9 characters
- clicking a swatch calls `onChange` with that swatch
- `contrastAgainst="#ffffff"` with `value="#777777"` shows `4.48`

### 4.5 Demo

In `ColorTab.tsx`, render `<ColorPicker alpha swatches={…} recent={…} onRecentChange={…} contrastAgainst="#ffffff" />`. Next to it, show live `inspect_color` output by calling `registry.callTool` or the core functions directly.

### 4.6 Checks for Phase 4

Build, then `pnpm test`, then `pnpm --filter demo build`. Then start the demo (`pnpm dev`) and check the Colour tab by hand:

- drag
- use the keyboard
- type `color(display-p3 1 0 0)` and see the out-of-gamut line
- the eyedropper works in Chromium

Commits:

- `feat(core): add headless colour picker model` (if you didn't commit it in Phase 3)
- `feat(react): add ColorPicker`
- `feat(svelte): add ColorPicker`

Each gets a `minor` changeset.

---

## Phase 5: dual colours (one value for light mode and dark mode)

A **dual colour** is a pair of colours, one for light mode and one for dark mode, kept together as a single value. A UI that supports both modes stores the pair and uses the right half for the current mode. A plain colour still works anywhere a dual colour is accepted; it means "the same colour in both modes".

There are two ways a UI can use a dual colour, and the module supports both:

1. **Let the browser choose.** Write the pair as CSS `light-dark(#light, #dark)`. The browser picks the right half, but only where `color-scheme` is set on that element or one of its parents (for example `:root { color-scheme: light dark; }`). Without `color-scheme`, `light-dark()` always gives the light colour. This works for HTML/CSS.
2. **Resolve it in JavaScript.** Call `resolveColor(value, scheme)` with `'light'` or `'dark'`. Canvas 2D, WebGL, SVG presentation attributes, the raster engines and exports need this, because they can't read `light-dark()`.

Dual colours are small and every picker needs them, so they live in `@pixerate/editor/color` (not in a separate subpath like gradients).

### 5.1 Core: `src/color/dual.ts`

```ts
export type ColorScheme = 'light' | 'dark';
/** A colour for each scheme. Both are any CSS colour; `normalizeDualColor` stores them as hex. */
export interface DualColor { light: string; dark: string }
/** Either a plain colour (the same in both schemes) or a dual colour. */
export type ColorValue = string | DualColor;
```

Functions:

- `isDualColor(value: unknown): value is DualColor`: an object with string `light` and `dark` properties.
- `parseDualColor(input: unknown): DualColor | null`. It accepts:
  - a `DualColor` object
  - a CSS `light-dark(<colour>, <colour>)` string, with spaces allowed and any colour `parseColor` reads on either side. Find the top-level comma by counting brackets, because `rgb(1, 2, 3)` contains commas.
  - a plain colour, which becomes `{ light: c, dark: c }`

  It returns `null` when either half can't be read, and never throws. Nested `light-dark()` returns `null`.
- `normalizeDualColor(input: unknown): DualColor | null`: `parseDualColor`, with both halves run through `normalizeColor`.
- `resolveColor(value: unknown, scheme: ColorScheme): string | null`: the hex for that scheme. It also takes plain colours and `light-dark()` strings.
- `formatDualColor(value: DualColor): string`: `light-dark(#a, #b)`, or just `#a` when both halves are equal.
- `isSameInBothSchemes(value: DualColor): boolean`
- `setDualColorSide(value: ColorValue, scheme: ColorScheme, color: string): DualColor`. Changes one half. A plain colour first becomes a pair of that colour, then one half changes.
- `deriveDualColor(color: string, options?: { from?: ColorScheme; surfaces?: DualColor }): DualColor`. Makes the other half automatically. `from` defaults to `'light'`, meaning `color` is the light half and the dark half is generated.
  - **With no `surfaces`:** convert to OKLCH and keep the hue. The new lightness is `clamp(1.05 - L, 0.12, 0.95)` and the new chroma is `C × 0.9`. Gamut-map the result with `toSrgbGamut`.
  - **With `surfaces`** (the light and dark background colours): keep the contrast the colour has against its own background. Measure the ratio of `color` against `surfaces[from]`. Then search the other half's OKLCH lightness, in steps of 0.005 from the starting guess above, for the value whose ratio against the other surface is closest to that ratio, preferring lightness values on the far side from the background. Keep hue and chroma.
  - The default surfaces, used by the tools and the picker, are `DEFAULT_SCHEME_SURFACES = { light: '#ffffff', dark: '#0b0b0f' }`.
- `checkDualColorContrast(foreground: ColorValue, background: ColorValue, options?: { large?: boolean }): { light: { ratio: number; level: ContrastLevel }; dark: { ratio: number; level: ContrastLevel }; issues: string[] }`. Each issue is a sentence that names the scheme, e.g. `In dark mode, #444444 on #0b0b0f has a contrast of 1.9 (needs 4.5 for AA).`
- `dualColorsToCss(colors: Record<string, ColorValue>, options?: { selector?: string; strategy?: 'light-dark' | 'media' | 'class'; darkSelector?: string }): string`. Writes CSS custom properties for a set of named dual colours. The name is the property without `--`. The strategies:
  - `'light-dark'` (default): one rule of `--name: light-dark(#a, #b);`. Add `color-scheme: light dark;` to the rule when `selector` is `:root`.
  - `'media'`: light values in `selector`, and dark values in `@media (prefers-color-scheme: dark) { selector { … } }`
  - `'class'`: light values in `selector`, and dark values in `darkSelector`, which defaults to `.dark`

  `selector` defaults to `:root`. The output is stable: properties are sorted by name.

**`parseColor` doesn't change:** it still returns `null` for `light-dark(…)`, because a single `Rgba` can't hold two colours. Callers that accept both use `parseDualColor` or `resolveColor`. Say this in the JSDoc of both.

Add `export * from './dual';` to `src/color/index.ts`.

### 5.2 Headless picker helper

In `src/color/picker.ts`, add `dualPickerView(value: ColorValue, scheme: ColorScheme): { color: string; linked: boolean; other: string }`. It returns what the picker shows for the chosen half: whether the two halves are the same (`linked`) and the other half's colour.

### 5.3 Core tests: `packages/core/tests/color-dual.test.ts`

Cover at least:

- `parseDualColor('light-dark(rgb(0, 0, 0), #fff)')` → `{ light: '#000000', dark: '#ffffff' }` after normalising
- a plain colour → both halves the same
- `null` for `light-dark(#fff)`, `light-dark(#fff, nope)` and nested `light-dark()`
- `resolveColor` for both schemes and for plain input
- `formatDualColor` collapses equal halves
- `deriveDualColor('#1d4ed8')` gives a dark half that is lighter than the light half, with the same hue (within 1°)
- with `surfaces`, the derived dark half's contrast against `#0b0b0f` is within 0.3 of the light half's contrast against `#ffffff`
- `checkDualColorContrast` reports a problem only in the failing scheme
- `dualColorsToCss` output for all three strategies, compared as exact strings

### 5.4 Agent tools (in `createColorToolProvider`)

Add these as read-only tools. Each colour argument in their schemas accepts a plain colour, a `light-dark()` string or a `{ light, dark }` object (`oneOf` string / object with `required: ['light', 'dark']` and `additionalProperties: false`). Each one says so in its description.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `derive_dual_color` | `color` (required), `from` (`'light'` \| `'dark'`, default `'light'`), `surfaces` (dual colour, default `DEFAULT_SCHEME_SURFACES`), `keepContrast` (boolean, default true: use the surfaces) | `light`, `dark`, `css` (`light-dark()`), and the contrast of each half against its surface |
| `check_dual_color_contrast` | `foreground`, `background` (required), `large` (default false) | the `checkDualColorContrast` result, plus a `suggestion` when a scheme fails: a fixed half for that scheme (reuse the lightness search from `check_color_contrast`) |
| `export_dual_colors_css` | `colors` (object of name → colour value, minProperties 1, required), `selector`, `strategy`, `darkSelector` | `css` |

Change `inspect_color` and `check_color_contrast` so that a `light-dark()` value doesn't get the general "can't read" error. Instead, give a specific one: `This is a dual colour (light-dark); use check_dual_color_contrast, or pass one half.`

Tests go in `tests/color-tools.test.ts`, with valid and invalid calls for each new tool, including that the `light-dark()` error message is the specific one. The skill test in `tests/agent-skills.test.ts` picks up the new tools on its own once they're in the provider. Add their rows to the skill (5.7).

### 5.5 Adopting the scheme in React and Svelte

The frameworks need to know the current scheme to resolve dual colours in JavaScript.

- **React** (`packages/react/src/color/useColorScheme.ts`): `useColorScheme(options?: { override?: ColorScheme | null; attribute?: string }): ColorScheme`.
  - If `override` is set, return it.
  - If `attribute` is set (for example `"data-theme"` or `"class"`), read it from `document.documentElement` and watch it with a `MutationObserver`. `class` means "contains `dark`".
  - Otherwise, follow `matchMedia('(prefers-color-scheme: dark)')` and its `change` event.
  - Use `useSyncExternalStore`. On the server, return `'light'`.
- **Svelte** (`packages/svelte/src/color/colorScheme.svelte.ts`): `createColorScheme(options)` returns an object with a reactive `current` property. It has the same rules, and cleans up with `$effect`.
- Both packages also export `useResolvedColor(value, scheme)` (React) / `resolvedColor(value, scheme)` (Svelte, a `$derived`-friendly function). They are thin wrappers over `resolveColor`.

### 5.6 `DualColorPicker` in React and Svelte (in `/color`)

It goes in `/color`, next to `ColorPicker`, which it reuses. Props are the same in both packages:

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | `ColorValue` | plain colour, `light-dark()` string or `{ light, dark }` |
| `onChange` | `(value: DualColor) => void` | always a `DualColor` with hex halves. Hosts that want CSS call `formatDualColor`. |
| `onGestureStart` / `onGestureEnd` | | passed through from the inner `ColorPicker` |
| `scheme` / `onSchemeChange` | `ColorScheme` | which half is being edited. It's uncontrolled if left out, defaulting to `'light'`. |
| `surfaces` | `DualColor` | the backgrounds behind the previews (default `DEFAULT_SCHEME_SURFACES`) |
| `contrastAgainst` | `ColorValue` | shows the contrast ratio and its level for **both** schemes |
| `alpha`, `swatches`, `disabled`, `className` | | as on `ColorPicker` |

What it renders:

- **A Light / Dark segmented control** (`role="tablist"`) that chooses which half the inner `ColorPicker` edits.
- **Two previews side by side**, each showing that half on its surface, with "Light" and "Dark" labels. Clicking a preview selects that half.
- **A "Same in both" toggle.** Turning it on copies the current half to the other one. While it's on, editing one half changes both.
- **A "Derive" button** that fills the other half with `deriveDualColor(current, { from: scheme, surfaces })`. It's one gesture: call `onGestureStart`, then `onChange`, then `onGestureEnd`.

Tests (React and Svelte, next to the `ColorPicker` tests):

- a `light-dark()` value shows both previews
- switching to Dark and editing changes only `dark`
- "Same in both" keeps the halves equal
- Derive gives a dark half that differs from the light half
- `contrastAgainst` shows two ratios
- `useColorScheme` / `createColorScheme` follow a mocked `matchMedia` and an `attribute` override

### 5.7 Skill, demo and commits

- **`skills/pixerate-color/SKILL.md`:** add a **Dual colours** section.
  - **Mental model:** a value with a colour for light mode and a colour for dark mode. A plain colour means the same colour in both.
  - **Working method:**
    1. design the light half
    2. `derive_dual_color` with the app's real surfaces
    3. `check_dual_color_contrast` for each text / background pair
    4. fix whichever mode fails
  - **Best practices:**
    - check both modes, every time
    - don't simply invert lightness for brand colours; keep the hue and lower the chroma a little in dark mode
  - **Pitfalls:**
    - `light-dark()` needs `color-scheme` to be set, or it always shows the light colour
    - canvas, SVG attributes and exports must resolve the colour in JavaScript
  - **Rows:** one row per new tool.
- **Demo** (`ColorTab.tsx`):
  - a Light / Dark / System switch that sets `data-theme` on a preview container, with `useColorScheme({ attribute: … })` reading it
  - a `DualColorPicker`
  - a small sample card styled with the CSS from `dualColorsToCss`, so the switch visibly changes it
- **`GOTCHAS.md`:** add the `color-scheme` requirement for `light-dark()`.

Commits:

- `feat(core): add dual colours for light and dark mode`
- `feat(react): add DualColorPicker and useColorScheme`
- `feat(svelte): add DualColorPicker and createColorScheme`

Each gets a `minor` changeset.

---

## Phase 6: use the picker in the parameters colour field

This is the only place the picker is adopted in this plan. The others come after review.

1. **React** `ParameterColor` (`packages/react/src/parameters/fields.tsx`) and **Svelte** `ParameterColor.svelte`. Keep the small swatch button as it is. Clicking it opens a popover that holds `<ColorPicker>`, wired as follows:
   - `value`
   - `alpha={!!field.alpha}`
   - `swatches={field.swatches}`: check the actual property name on `ColorParameterField` in `packages/core/src/parameters/types.ts`
   - `onChange`
   - `onGestureStart` / `onGestureEnd`, passed straight through, so a drag stays one undo step

   The popover is a positioned `div`. It closes on Escape, on a click outside and on blur out of the popover, and returns focus to the swatch button. If the repo already has a popover helper, use it: search `packages/react/src` and `packages/svelte/src` for "Popover" first. Keep `<input type="color">` out of this component.
2. Entry isolation: `parameters` in React and Svelte will now import `@pixerate/editor/color`. In both `entry-isolation.test.ts` files, change `parameters: ["tools"]` to `parameters: ["tools", "color"]`. Do the same for every other entry the build output shows importing `color`: run the test and read the failure.
3. Update the existing `ParameterColor` tests in `parameters.test.tsx` / `parameters.svelte.test.ts`. They change a native input today, so they need to open the popover and type into the picker's text field instead. Keep what each test asserts; change only how it drives the control.
4. The parameter commands (`parameters.set`) are already the agent path for this field. Add nothing there. In `skills/pixerate-parameters/SKILL.md`, add one sentence: colour values may be given as any CSS colour and are stored as hex. Make that sentence true first: check that `normalizeHexColor` in `parameters/schema.ts` accepts them. If it doesn't, make it delegate to `normalizeColor` from `../color` (and add a test), or drop the sentence.

Commit as `feat(react): use ColorPicker for parameter colour fields` and `feat(svelte): …` (`minor`).

---

## Phase 7: gradient model, controller and agent tools (`packages/core/src/gradient`)

The repo already has three gradient models. Read their types before you start:

- `VectorGradient` in `vector/types.ts`: five types, midpoints, interpolation, smoothness and spread. This is the richest.
- `CanvasGradientDef` in `canvas/gradient.ts`: linear and radial, plus CSS parsing.
- `PaintGradientSource` in `paint/gradient-paint.ts`: pigment mixing, and stops named `paint` / `secondary`.

**Don't change any of them in this phase.** The new model is a neutral, CSS-shaped one. Domains adapt to it later (see the follow-ups at the end of this plan).

### 7.1 Model: `src/gradient/types.ts` and `src/gradient/model.ts`

```ts
export type GradientType = 'linear' | 'radial' | 'conic';
export type GradientInterpolation = 'srgb' | 'srgb-linear' | 'oklab' | 'oklch';
export interface GradientStop {
	/** Stable id, unique within the gradient (e.g. "s1"). Assigned by the model when missing. */
	id: string;
	/** 0–1 along the gradient. */
	offset: number;
	/**
	 * Any CSS colour, or a dual colour as `light-dark(a, b)` (Phase 5). Stored normalised by
	 * `normalizeGradient`: hex, or `light-dark(#a, #b)` when the halves differ.
	 */
	color: string;
	/** 0.05–0.95: where between this stop and the next the colours are half mixed (default 0.5, CSS colour hint). */
	midpoint?: number;
}
export interface Gradient {
	type: GradientType;
	stops: GradientStop[];              // at least 2
	/** Linear and conic: degrees, CSS convention (0 = to top, 90 = to right, default 180 = to bottom). */
	angle?: number;
	/** Radial and conic: centre, 0–1 of the box (default 0.5, 0.5). */
	center?: { x: number; y: number };
	/** Radial: 'circle' or 'ellipse' (default 'ellipse', CSS farthest-corner). */
	shape?: 'circle' | 'ellipse';
	/** Default 'oklab'. */
	interpolation?: GradientInterpolation;
	/** Repeat the stop pattern (CSS repeating-*-gradient). Default false. */
	repeating?: boolean;
}
```

`model.ts` contains pure functions, all of which return new objects:

- `normalizeGradient(input: unknown): { gradient: Gradient } | { error: string }`
  - fills in defaults and normalises colours: `normalizeDualColor` from `../color`, then `formatDualColor`, so a plain colour stays plain hex. A `{ light, dark }` object is accepted as a stop colour too, and is stored as `light-dark()`.
  - clamps offsets to 0–1 and sorts stops by offset (stable sort)
  - assigns missing ids (`s1`, `s2`, … skipping ids already used)
  - errors are sentences, e.g. `A gradient needs at least 2 stops; it has 1.`
- `createGradient(colors: readonly string[], options?: Partial<Omit<Gradient, 'stops'>>): Gradient`, with evenly spaced stops
- `insertGradientStop(g, offset, color?)`: when no colour is given, it uses `sampleGradient(g, offset)`. Returns `{ gradient, stop }`.
- `updateGradientStop(g, id, patch: { offset?, color?, midpoint? })`, `removeGradientStop(g, id)` (refuses to go below 2 stops), `reverseGradient(g)` (offsets become `1 − offset`, midpoints become `1 − midpoint`) and `distributeGradientStops(g)`. Each one **throws a sentence error** for an unknown id; the message lists the valid ids.
- `resolveGradient(g, scheme: ColorScheme): Gradient`: a copy with every dual stop colour replaced by its half for that scheme. `isDualGradient(g)` is true when any stop is dual.
- `sampleGradient(g, t, scheme: ColorScheme = 'light'): string`, returning hex at `t` 0–1:
  - resolve dual stops for `scheme` first
  - apply the midpoint remap. Reuse the formula of `gradientMidpointRemap` in `vector/gradient.ts`: copy it, don't import from vector.
  - then mix with `mixColors(…, { space: g.interpolation })` from `../color`
- `gradientToCss(g): string`
  - writes `linear-gradient(in oklab 180deg, #a 0%, 50%, #b 100%)`, with each midpoint written as a CSS colour-hint percentage between its stops
  - when `interpolation === 'srgb'`, it leaves out `in srgb`
  - `repeating` uses `repeating-…-gradient`
  - dual stops are written as `light-dark()`, which is valid inside CSS gradients, so the browser switches the gradient with `color-scheme`
- `gradientToCssFallback(g, steps = 16, scheme: ColorScheme = 'light'): string`. Same as `gradientToCss` but expanded into plain sRGB stops by sampling, with no `in …`, no hints and no `light-dark()`, for renderers that support none of them.
- `parseCssGradient(css: string): Gradient | null`
  - reads the CSS `linear-gradient` / `radial-gradient` / `conic-gradient` functions and their `repeating-` forms, including `in <space>`, angles in `deg` / `turn` and `to <side>` keywords, colour hints and stops without positions (spread them evenly, as CSS does)
  - returns `null` for anything else
  - before writing it, read `parseCssGradient` in `canvas/gradient.ts` for the tokenising approach. **Don't import it**: the new one lives in `src/gradient`.
- `gradientToSvgDef(g, id, scheme: ColorScheme = 'light'): string`
  - SVG attributes can't read `light-dark()`, so dual stops are resolved for `scheme`
  - returns an SVG `<linearGradient>` or `<radialGradient>` element string, with stops expanded by sampling so that oklab interpolation looks right
  - a conic gradient comes back as a linear fallback, with a comment noting that SVG has no conic gradient
- `checkGradient(g, options?: { surface?: ColorValue; text?: ColorValue })`
  - returns `{ issues: string[], lowestTextContrast?: number }`, or for a dual gradient (or dual `text` / `surface`) `{ issues, lowestTextContrast?: { light: number; dark: number } }`
  - dual gradients are checked in both schemes, and each issue names its scheme
  - issues include stops that are too close (offset gap < 0.005), colours outside sRGB, and banding risk (two neighbouring stops with ΔE<sub>OK</sub> > 0.5 across a gap < 0.05)
  - when `text` is given, it samples 32 points and reports the lowest `contrastRatio` of that text colour against the gradient

`GRADIENT_PRESETS: Readonly<Record<string, Gradient>>`: about 8 neutral presets (`sunset`, `ocean`, `mono-fade`, `transparent-fade`, …).

### 7.2 Controller: `src/gradient/controller.ts`

`GradientController` is modelled on `ChartController` (`src/chart/controller.ts`). Read that file first, and copy its history, gesture and subscribe pattern:

- `constructor(options?: { value?: unknown; history?: HistoryManager; readOnly?: boolean | string | (() => boolean | string) })`. An invalid `value` throws the error from `normalizeGradient`.
- `getGradient(): Readonly<Gradient>`, `subscribe(listener): () => void`, `getSelectedStopId()` / `selectStop(id)`.
- Every write is one undo step through `HistoryManager`, as in `ChartController`:
  - `setGradient(value)` (replace everything; validates first)
  - `setType`, `setAngle`, `setCenter`, `setInterpolation`, `setRepeating`
  - `addStop(offset, color?)` → the new stop
  - `updateStop(id, patch)`, `removeStop(id)`, `reverse()`, `distribute()`
- `beginGesture()` / `endGesture()`: everything between the two calls merges into one undo step, which a stop drag needs. Copy `gestureStart` from `ChartController`.
- `undo()`, `redo()`, `dispose()`.
- When `readOnly` is set, every write throws its reason.

### 7.3 Agent tools: `src/gradient/tools.ts`

Export `createGradientToolProvider(controller: GradientController, options?: { id?: string; namespace?: string; readOnly?: … }): AgentToolProvider`:

- `id` and `namespace` default to `'gradient'`
- `skill: 'pixerate-color'`

Use the same `READ` / `WRITE` annotation constants as `chart/tools.ts`. While the gradient is read-only, the write tools are **hidden**, as in the chart provider. Every write returns the full gradient and its CSS, plus the stop it created or changed.

| Tool | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `get_gradient` | read | none | `gradient` (with stop ids), `css`, `selectedStopId` |
| `check_gradient` | read | `surface?`, `text?` (each a colour, a `light-dark()` string or `{ light, dark }`) | `checkGradient` result; per scheme when anything is dual |
| `list_gradient_presets` | read | none | `presets: { name, css }[]` |
| `set_gradient` | write | `gradient` (object) **or** `css` (string), exactly one, enforced with `oneOf` | `gradient`, `css` |
| `set_gradient_geometry` | write | any of `type`, `angle` (deg), `center` ({x,y} 0–1), `shape`, `interpolation`, `repeating`; at least one (`minProperties: 1`) | `gradient`, `css` |
| `add_gradient_stop` | write | `offset` (0–1, required), `color?` (default: the colour already at that offset) | `stop`, `gradient`, `css` |
| `update_gradient_stop` | write | `id` (required), `offset?`, `color?`, `midpoint?` (0.05–0.95), at least one change | `stop`, `gradient`, `css` |
| `remove_gradient_stop` | write, `destructiveHint: true` | `id` (required) | `removedId`, `gradient`, `css` |
| `reverse_gradient` | write | none | `gradient`, `css` |
| `distribute_gradient_stops` | write | none | `gradient`, `css` |
| `apply_gradient_preset` | write | `name` (enum of preset names, required) | `gradient`, `css` |

The ids come from `get_gradient`, which closes the loop. Validate everything before you change anything. For example, `remove_gradient_stop` on a 2-stop gradient fails with `A gradient needs at least 2 stops; add one with add_gradient_stop before removing this one.`

### 7.4 Entry point and index

- `src/gradient/index.ts`: `export *` from `types`, `model`, `controller` and `tools`.
- Register `gradient` exactly as Phase 1.2 registered `color`: tsup entry, `package.json` export, `entry-isolation.test.ts`, core README entry-point list.

### 7.5 Tests

- **`tests/gradient-model.test.ts`:**
  - normalising (ids, sorting, clamping, errors)
  - each edit function, including the error for an unknown id
  - `sampleGradient` at 0, 1 and the midpoint
  - a midpoint of 0.25 moves the half-mix point
  - `gradientToCss` output strings
  - `parseCssGradient` round-trips the output of `gradientToCss` for every preset
  - parsing `linear-gradient(to right, red, blue)`, `radial-gradient(circle at 25% 75%, #fff, #000)`, `conic-gradient(from 90deg, red, yellow, red)` and `repeating-linear-gradient(45deg, #000 0 10%, #fff 10% 20%)`
  - `null` for `url(x.png)`
  - `checkGradient` issues
  - **dual stops:**
    - a `{ light, dark }` stop is stored as `light-dark(#a, #b)`
    - `gradientToCss` keeps `light-dark()` and `parseCssGradient` reads it back
    - `sampleGradient(g, 0, 'dark')` returns the dark half
    - `gradientToSvgDef(g, id, 'dark')` contains no `light-dark`
    - `checkGradient` reports problems per scheme
- **`tests/gradient-controller.test.ts`:**
  - each write is one undo step
  - `beginGesture` → 10 `updateStop` calls → `endGesture` gives one undo step
  - `subscribe` fires
  - read-only refuses writes with the reason
- **`tests/gradient-tools.test.ts`:**
  - every tool through `ToolRegistry.callTool`, with valid and invalid arguments
  - the write tools are hidden when read-only
  - `set_gradient` with both `gradient` and `css` fails
- **Conformance:**
  - `tests/command-tools.test.ts`: register `createGradientToolProvider(new GradientController())`
  - `tests/agent-skills.test.ts`: add `...toolNames(createGradientToolProvider(new GradientController()))` to the `'pixerate-color'` entry, and `createGradientToolProvider: 'pixerate-color'` to `FACTORIES`
- **Optionality guard:** in core `tests/entry-isolation.test.ts`, add a test that `color/index.js` reaches no file containing `function gradientToCss`, following static imports. Copy the `visit` pattern of the "canvas/index.js loads the paint engine only lazily" test.

### 7.6 Skill

Add a **Gradients** section to `skills/pixerate-color/SKILL.md`:

- **Mental model:** stops with ids, offsets 0–1, midpoints as CSS colour hints, oklab as the default interpolation.
- **Working method:**
  1. `get_gradient`
  2. edit by stop id
  3. `check_gradient`, with `text` when text sits on top
- **Best practices:**
  - oklab or oklch avoids muddy greys in the middle
  - use few stops
  - fade to a transparent version of the same colour, not to `transparent` black. The model premultiplies anyway, but other tools may not.
  - check text contrast at the gradient's lowest point
- **Rows:** one row per gradient tool.

Commit as `feat(core): add gradient model, controller and agent tools (@pixerate/editor/gradient)` (`minor`).

---

## Phase 8: `GradientEditor` and `FillPicker` in React and Svelte

Both components live in a new `/gradient` subpath in each package. **Nothing in `/color` imports them.**

### 8.1 Headless helpers (core, `src/gradient/editor.ts`)

These are pure functions shared by both frameworks:

- `stopFromTrackPosition(g, x)` / `trackPositionFromStop(stop)` (x 0–1)
- `gradientKeyStep(g, id, key, shift)`: ArrowLeft / ArrowRight move a stop by 1%, or 10% with Shift; Delete / Backspace removes it (returns `{ remove: true }`); returns `null` otherwise
- `angleFromPointer(center, point)`: degrees, CSS convention, snapping to 15° when asked
- `gradientTrackBackground(g)`: the CSS for the stop track, always linear 90deg, whatever the gradient's type

Test them in `tests/gradient-editor.test.ts`.

### 8.2 `GradientEditor`

Props are the same in both frameworks:

| Prop | Type | Notes |
| --- | --- | --- |
| `controller` | `GradientController` | required; the component subscribes to it (React: `useSyncExternalStore`; Svelte: a `createGradient` rune helper modelled on `createTokens.svelte.ts`) |
| `types` | `readonly GradientType[]` | which types to offer (default all three) |
| `showPresets` | `boolean` (default true) | |
| `showCss` | `boolean` (default false) | read-only CSS output with a copy button |
| `dual` | `boolean` (default false) | let stops hold a light and a dark colour. It's on automatically when the controller's gradient already has dual stops. |
| `className` | `string` | |

Also export `useGradientController(options)` (React) and `createGradientController(options)` (Svelte). Each creates a controller once and disposes it on unmount. Model them on `useParametersController` and `createParameters`.

What it renders:

- **A preview box** with `gradientToCss` over a checkerboard.
- **A stop track.**
  - Clicking empty track calls `addStop`.
  - Stops are draggable handles (`role="slider"`, `aria-label="Stop 2, #ff8800 at 40%"`) that call `beginGesture` on pointer down, `updateStop` on move and `endGesture` on up.
  - Dragging a stop more than 32 px down off the track removes it, if more than 2 stops are left.
  - Midpoint diamonds sit between stops.
  - Keyboard input goes through `gradientKeyStep`.
- **A `<ColorPicker>` for the selected stop**, imported from the package's own `/color`. Its `onGestureStart` / `onGestureEnd` go to `beginGesture` / `endGesture`.
  - With the `dual` prop (below), it's a `<DualColorPicker>` instead, whose `onChange` writes `formatDualColor(value)` to the stop.
  - The preview box and the track then show the gradient for the scheme being edited in the picker, using `gradientToCssFallback(g, 16, scheme)` so the preview doesn't depend on the page's `color-scheme`.
- **Controls:**
  - type buttons
  - an angle dial and number input (linear and conic)
  - centre x / y inputs (radial and conic)
  - an interpolation select
  - a repeating toggle
  - reverse and distribute buttons
  - a presets row

### 8.3 `FillPicker`

`FillPicker` is the opt-in "solid or gradient" control for hosts that want both.

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | `string` | a CSS colour **or** a CSS gradient string |
| `onChange` | `(value: string) => void` | a hex for solid, `gradientToCss` for gradient |
| `onGestureStart` / `onGestureEnd` | | passed through |
| `modes` | `readonly ('solid' \| 'gradient')[]` | default both. With `['solid']` it renders only `ColorPicker`. |
| `alpha`, `swatches` | | passed to `ColorPicker` |

Implementation notes:

- It keeps an internal `GradientController`, kept in sync with `value` through `parseCssGradient`. Use the same guard against re-syncing during a drag as the `ColorPicker` uses.
- Switching from solid to gradient creates a gradient from the current colour to a lighter version of it (OKLCH L + 0.2). Switching back to solid uses the first stop's colour.

### 8.4 Wiring, tests and demo

- **Subpaths:** register `gradient` in React's `tsup.config.ts`, and in React's and Svelte's `package.json` exports and `entry-isolation.test.ts`. The `EXTRA` for `gradient` is `["color", "tools", "history"]`; adjust it to whatever the build actually imports, using the test's failure message.
- **Optionality guard:** in both framework `entry-isolation.test.ts` files, assert that `color/index.js` does **not** reach `@pixerate/editor/gradient`.
- **Component tests** in `packages/react/tests/gradient-editor.test.tsx` and `packages/svelte/tests/gradient-editor.svelte.test.ts`:
  - renders the stops of a controller
  - clicking the track adds a stop (one undo step)
  - ArrowRight on a stop moves it 1%
  - Delete removes it, but not when only 2 are left
  - editing the colour of the selected stop updates the controller
  - a `FillPicker` with `modes={['solid']}` has no gradient UI
  - `FillPicker` round-trips a CSS gradient value through `onChange`
- **Demo** (`ColorTab.tsx`):
  - add a `GradientEditor` with `showCss`
  - register `createGradientToolProvider(controller)` with `useAgentToolProvider`, as in 2.4, so its tools appear in the agent-tools panel
  - add a `FillPicker` example

Commits:

- `feat(core): add headless gradient editor helpers`
- `feat(react): add GradientEditor and FillPicker`
- `feat(svelte): add GradientEditor and FillPicker`

Each gets a `minor` changeset.

---

## Phase 9: move duplicate helpers onto the module (core only, no behaviour change)

Do these **one at a time**. Run the domain's own tests after each, plus `pnpm test` at the end. Each old export stays as a wrapper. Delete only the private helpers that the wrapper no longer uses.

| Old | Becomes | Guard |
| --- | --- | --- |
| `rgbToOklab`, `oklabToRgb`, `mixColorsOklab` in `animation/color.ts` | call `src/color`; `oklabToRgb` keeps clamping in the wrapper | `tests/animation-*.test.ts`, `tests/canvas-animation.test.ts` |
| `chartRgbToOklab`, `chartColorDistance`, `simulateChartVision`, `checkChartColors` in `chart/color.ts` | adapters over `src/color` (`ChartRgb` tuple ↔ `Rgba`) | `tests/chart*.test.ts` |
| `colorHarmony`, wheel helpers in `paint-editor/color.ts` | re-export from `src/color/harmony.ts` | `tests/paint-editor*.test.ts` |
| `normalizeTokenColor`, `hexToRgba`, `rgbaToHex` in `tokens/color.ts` | **do not change in this plan.** `normalizeColor` accepts more syntax (hsl, oklch, names), and widening what tokens accept is a product decision. Put it in the follow-ups list | n/a |

If a guard test fails and the difference is only floating-point noise in the last digit, try computing in the same order as the old code first. If it still differs, revert that row and note it.

Commit as `refactor(core): share colour maths through @pixerate/editor/color` (`patch`).

---

## Phase 10: documentation and parity

- `README.md` (repo root):
  - add a **Colour** row to "What's inside" (DOM-free parsing for CSS Color 4 syntax, OKLab / OKLCH / Display P3, gamut mapping, WCAG contrast, colour-vision simulation, harmonies, blends, and `ColorPicker` in React and Svelte; import `@pixerate/editor/color`)
  - say in the Colour row that it includes dual colours: light and dark pairs, `light-dark()` CSS, generating the other half, contrast in both modes, `DualColorPicker` and scheme hooks
  - add a **Gradients** row (an optional subpath: a CSS-shaped gradient model with CSS / SVG import and export, `GradientController` with undo, agent tools, and `GradientEditor` / `FillPicker`; import `@pixerate/editor/gradient`)
  - add a `<details>` **Colour** section to "Feature parity", with rows for the colour module, the colour tools, the picker model and `ColorPicker`, then dual colours (core helpers, tools, `DualColorPicker`, `useColorScheme` / `createColorScheme`), then the gradient model (with dual stops), `GradientController`, the gradient tools, `GradientEditor` and `FillPicker`, filling the Core / React / Svelte columns
  - add the Colour tab to the demo tab list sentence
- `apps/demo/src/components/ParityMatrixTab.tsx`: add the matching `row(...)` entries.
- `packages/react/README.md` and `packages/svelte/README.md`: add `ColorPicker`, `GradientEditor` and `FillPicker` with short examples. Say that gradients are a separate import.
- `docs/color.md`: a short consumer guide covering the API overview, the picker props, dual colours (both ways of applying them, and the `color-scheme` requirement), gradients (and how to leave them out) and the agent tools. Link it from the README's docs list.
- `GOTCHAS.md`: add an entry for each pitfall you actually hit. Likely ones:
  - hue jumping to red on greys (fixed by keeping the previous hue)
  - drags jittering from the controlled value re-syncing
  - EyeDropper only exists in Chromium
- Change this file's status line to say what was built and what differs from the plan.

Commit as `docs(monorepo): document colour module and picker`.

---

## Final checklist (AGENTS.md §6)

```bash
pnpm build
```
```bash
pnpm test
```
```bash
pnpm --filter demo build
```
```bash
pnpm check:packages
```

Confirm each of these before you call the work done:

- [ ] `@pixerate/editor/color` imports nothing outside `src/color` except `src/cms/math` and type-only `src/tools`
- [ ] `/color` reaches no gradient code in core, React or Svelte (the optionality guards pass)
- [ ] every new tool (colour and gradient) has tests, is in the conformance test and is in `pixerate-color/SKILL.md`
- [ ] dual colours work both ways: `light-dark()` CSS in the browser, and `resolveColor` / `resolveGradient` for canvas, SVG and exports
- [ ] React and Svelte both export `ColorPicker`, `DualColorPicker` and the scheme hook from `/color`, and `GradientEditor`, `FillPicker` and the controller helper from `/gradient`, and all have tests
- [ ] the Colour demo tab registers the colour and gradient tool providers
- [ ] every library commit has a changeset
- [ ] no existing test's expected values were changed (only how the parameters tests drive the colour control)
- [ ] both `THIRD_PARTY_NOTICES.md` files point at the new file for any ported code you moved

## Follow-ups (not in this plan)

- Use `ColorPicker` in the vector, image, chart, spreadsheet, tokens and animation panels, one PR per editor.
- Adapters between `Gradient` and the domain models:
  - `VectorGradient` ↔ `Gradient`, in `vector`; the vector model is a superset, so the conversion loses reflected, diamond, smoothness and focal points
  - `CanvasGradientDef` ↔ `Gradient`, in `canvas`
  - `PaintGradientSource` ↔ `Gradient`, in `paint`; pigment space and `paint` / `secondary` stops don't map
  
  After that, decide whether `VectorGradientEditor` and `PaintGradientEditor` should be built on `GradientEditor`.
- Use `FillPicker` for canvas shape fills and the chart series colour.
- Dual colours elsewhere:
  - a `dual: true` option on parameter colour fields (values stored as `light-dark()`)
  - `FillPicker` passing `dual` through
  - converting between `DualColor` and design-token modes (a light and a dark mode in a token collection)
  - chart themes with dual series colours
- Decide whether tokens accept the wider syntax (`hsl()`, `oklch()`, names) through `normalizeColor`.
- An OKLCH picker area drawn on a canvas, and a P3 preview on wide-gamut displays.
- A palette / theme editor: tonal ramps in OKLCH, semantic roles, light and dark modes, a contrast matrix, and ASE / ACO / GPL / CSS / Tailwind / design-token import and export, with its own tools and skill.
