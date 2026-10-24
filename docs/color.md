# Colour and gradients

`@pixerate/editor/color` is a DOM-free colour toolkit: parsing and formatting, conversions, gamut mapping, WCAG contrast, colour-vision simulation, harmonies, mixing, dual light/dark colours and a headless picker model. `@pixerate/editor/gradient` is an opt-in gradient model, controller and editor helpers built on it. The colour entry never imports gradient code, so consumers who only need colours don't bundle gradients.

The React and Svelte packages expose the components from matching subpaths:

| Core | React | Svelte |
| --- | --- | --- |
| `@pixerate/editor/color` | `@pixerate/editor-react/color` | `@pixerate/editor-svelte/color` |
| `@pixerate/editor/gradient` | `@pixerate/editor-react/gradient` | `@pixerate/editor-svelte/gradient` |

Neither is re-exported from the packages' root entries; import the subpath you need.

---

## 1. Colours (`@pixerate/editor/color`)

Colours are handled as `Rgba` values: gamma-encoded sRGB channels from 0 to 1, plus alpha. Wide-gamut input (Display P3, high-chroma OKLCH) gives channels outside 0–1 until it is gamut-mapped.

### Parsing and formatting

`parseColor` reads hex, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color(srgb | srgb-linear | display-p3 …)`, CSS colour names, `{ r, g, b, a }` objects and W3C design-token colours. It never throws: unreadable input returns `null`.

```ts
import { parseColor, formatColor, formatHex, normalizeColor } from "@pixerate/editor/color";

const pink = parseColor("#ff007f");
formatColor(pink!, "oklch"); // "oklch(64.51% 0.2601 2.78)"

const p3 = parseColor("color(display-p3 1 0 0.5)");
formatColor(p3!, "rgb"); // "rgb(255 17 130)" (gamut-mapped into sRGB)

normalizeColor("RebeccaPurple"); // "#663399"
```

`formatColor` takes `'hex' | 'rgb' | 'hsl' | 'oklch' | 'oklab' | 'p3'`. Hex, rgb and hsl are gamut-mapped into sRGB first; oklch, oklab and p3 keep the full value. The conversions (`rgbToHsl`, `rgbToHsv`, `rgbToOklab`, `oklabToOklch`, `linearSrgbToDisplayP3`, …) are exported for direct use.

### Gamut mapping

```ts
import { parseColor, inSrgbGamut, toSrgbGamut, formatHex, deltaEOK } from "@pixerate/editor/color";

const vivid = parseColor("oklch(70% 0.35 140)")!;
inSrgbGamut(vivid); // false
formatHex(toSrgbGamut(vivid)); // "#15c000"
```

`toSrgbGamut` uses the CSS Color 4 algorithm: it reduces OKLCH chroma at the same lightness and hue until the clipped colour is within a just-noticeable difference (ΔEOK 0.02). `deltaEOK` is the Euclidean distance in OKLab.

### Contrast

```ts
import { parseColor, contrastRatio, contrastLevel, readableTextColor } from "@pixerate/editor/color";

const ratio = contrastRatio(parseColor("#ffffff")!, parseColor("#1e293b")!); // ≈ 14.63
contrastLevel(ratio); // "AAA"
contrastLevel(3.5, { large: true }); // "AA"

readableTextColor(parseColor("#1e293b")!); // white, the higher-contrast of black and white
```

Contrast is WCAG 2. A translucent foreground is composited over the background, and a translucent background over white, before the ratio is taken. APCA is not included.

### Colour vision, palettes, harmonies and mixing

```ts
import { parseColor, simulateColorVision, checkPaletteColors, colorHarmony, mixColors } from "@pixerate/editor/color";

// Machado et al. (2009) at full severity: 'protanopia' | 'deuteranopia' | 'tritanopia' ('normal' returns the input).
simulateColorVision(parseColor("#3b82f6")!, "protanopia");

// Pairwise distinctness under normal vision and each deficiency, plus contrast against the surface.
const check = checkPaletteColors(["#2563eb", "#16a34a", "#dc2626"], { surface: "#ffffff" });
check.ok; // false when two colours are too close or one disappears into the surface
check.issues; // sentences describing each problem

// Harmonies around a #rrggbb base, on the painter's RYB wheel (default) or the RGB wheel.
colorHarmony("#3b82f6", "triadic", { wheel: "rgb" });
// [{ color: "#3b82f6", angle: 217.2 }, { color: "#f63b82", angle: 337.2 }, { color: "#82f63b", angle: 97.2 }]

// Premultiplied mix in 'oklab' (default), 'oklch', 'srgb' or 'srgb-linear'; null if either colour is unreadable.
mixColors("#ff0000", "#0000ff", 0.5); // "#8c53a2"
```

Harmony kinds: `complementary`, `split-complementary`, `analogous`, `triadic`, `tetradic`, `square`, `monochromatic`. `colorHarmony` throws on anything other than `#rrggbb`.

### Dual light/dark colours

A dual colour holds one colour per colour scheme. A `ColorValue` is any of:

- a `DualColor` object: `{ light: "#ffffff", dark: "#0f172a" }`
- a CSS `light-dark(#ffffff, #0f172a)` string
- a plain colour, which is the same in both schemes

`parseColor` rejects `light-dark()`, because one `Rgba` can't hold two colours. Use the dual functions instead:

```ts
import {
  parseDualColor,
  normalizeDualColor,
  resolveColor,
  setDualColorSide,
  deriveDualColor,
  checkDualColorContrast,
  dualColorsToCss,
  DEFAULT_SCHEME_SURFACES
} from "@pixerate/editor/color";

normalizeDualColor("light-dark(white, #0f172a)"); // { light: "#ffffff", dark: "#0f172a" }
resolveColor("light-dark(#ffffff, #0f172a)", "dark"); // "#0f172a"
setDualColorSide("#1d4ed8", "dark", "#60a5fa"); // { light: "#1d4ed8", dark: "#60a5fa" }

// Build the other half, keeping the hue and matching the contrast it has on its own surface.
deriveDualColor("#1d4ed8", { surfaces: DEFAULT_SCHEME_SURFACES }); // { light: "#1d4ed8", dark: "#6094ff" }

// WCAG contrast in both schemes; each issue names its scheme.
checkDualColorContrast({ light: "#0f172a", dark: "#f8fafc" }, DEFAULT_SCHEME_SURFACES);

// CSS custom properties. Keys are variable names without the leading "--".
dualColorsToCss({ surface: { light: "#ffffff", dark: "#0f172a" }, text: "light-dark(#0f172a, #f8fafc)" });
// :root {
//   color-scheme: light dark;
//   --surface: light-dark(#ffffff, #0f172a);
//   --text: light-dark(#0f172a, #f8fafc);
// }
```

`dualColorsToCss` takes `strategy: 'light-dark' | 'media' | 'class'`, plus `selector` (default `:root`) and `darkSelector` (default `.dark`, for `'class'`). `deriveDualColor`, `checkDualColorContrast` and `dualColorsToCss` throw an error that names the bad value when a colour, variable name or selector can't be used. The parsers (`parseDualColor`, `normalizeDualColor`, `resolveColor`) return `null` instead.

**`light-dark()` needs `color-scheme`.** The browser picks the dark half only when the element or an ancestor sets `color-scheme: light dark` (or `dark`). Without it, the light half always shows. The `'light-dark'` strategy adds the declaration on `:root`. With any other selector, set it yourself. Canvas, WebGL, SVG presentation attributes and image exports can't read `light-dark()`: resolve colours in JavaScript with `resolveColor(value, scheme)`.

### Picker model

The components share a headless HSV picker model that keeps the hue and saturation when a colour turns grey or black:

- `pickerStateFromColor(value, previous?)` turns a colour into picker state. Pass the previous state to keep its hue for greys.
- `pickerStateFromArea`, `pickerStateFromHue` and `pickerStateFromAlpha` update the state from a 0–1 position.
- `pickerKeyStep` handles arrow, Page Up/Down, Home and End keys.
- `pickerStateToHex` gives the colour as hex.
- `pickerAreaBackground`, `PICKER_HUE_BACKGROUND` and `pickerAlphaBackground` are the CSS backgrounds for the three controls.
- `dualPickerView` gives the data a dual picker needs.
- `pushRecentColor(list, color, max = 12)` keeps a de-duplicated list of recent colours.

---

## 2. Gradients (`@pixerate/editor/gradient`)

A `Gradient` is CSS-shaped:

```ts
interface Gradient {
  type: "linear" | "radial" | "conic";
  stops: GradientStop[]; // at least 2: { id, offset 0–1, color, midpoint? 0.05–0.95 }
  angle?: number; // linear and conic, degrees (0 = to top, default 180)
  center?: { x: number; y: number }; // radial and conic, 0–1 of the box
  shape?: "circle" | "ellipse"; // radial
  interpolation?: "oklab" | "oklch" | "srgb" | "srgb-linear"; // default "oklab"
  repeating?: boolean;
}
```

A stop's colour may be a dual colour. CSS output keeps `light-dark()`, which works inside gradients. `resolveGradient(g, scheme)`, `sampleGradient(g, t, scheme)`, `gradientToCssFallback(g, steps, scheme)` and `gradientToSvgDef(g, id, scheme)` give one scheme's colours for targets that can't read it.

```ts
import { createGradient, gradientToCss, parseCssGradient, checkGradient, GRADIENT_PRESETS } from "@pixerate/editor/gradient";

const g = createGradient(["#3b82f6", "#ec4899"], { angle: 90 });
gradientToCss(g); // "linear-gradient(in oklab 90deg, #3b82f6 0%, #ec4899 100%)"
parseCssGradient("radial-gradient(circle, #fff 0%, #000 100%)"); // Gradient | null
checkGradient(g, { text: "#ffffff" }).issues; // crowded stops, banding, gamut, text contrast along the ramp
Object.keys(GRADIENT_PRESETS); // sunset, ocean, mono-fade, transparent-fade, aurora, neon, radial, conic
```

The stop functions (`insertGradientStop`, `updateGradientStop`, `removeGradientStop`, `reverseGradient`, `distributeGradientStops`) return new gradients. `normalizeGradient(input)` validates an object or CSS string and returns `{ gradient }` or `{ error }`.

### GradientController

The controller holds one gradient, the selected stop and an undo history (pass `history` to share one with the rest of the app):

```ts
import { GradientController, createGradient, gradientToCss } from "@pixerate/editor/gradient";

const controller = new GradientController({
  value: createGradient(["#3b82f6", "#ec4899"]),
  onChange: (gradient) => save(gradientToCss(gradient))
});

const unsubscribe = controller.subscribe((state) => render(state)); // called once now, then on every change

const added = controller.addStop(0.5, "#8b5cf6"); // { ok: true, stop } — the new stop is selected
controller.setAngle(135); // one undo step: "Change Gradient Angle"
controller.setGeometry({ type: "radial", shape: "circle" }); // several fields, one undo step
controller.setGeometry({ shape: "circle" }); // on a linear gradient: { ok: false, message: "The shape applies to radial gradients only; …" }

controller.load("linear-gradient(90deg, #000 0%, #fff 100%)"); // host sync: no undo step, selection kept
controller.undo();
```

- Every edit returns `{ ok: true }` or `{ ok: false, message }` and changes nothing when it fails, including when the controller is read-only (`readOnly: true | "reason" | () => …`).
- Geometry is checked before anything changes: the angle must be finite and the center within 0–1. The angle applies to linear and conic gradients, the center to radial and conic, and the shape to radial only.
- `beginGesture(label)` / `endGesture()` merge the edits of a drag into one undo step.
- `selectStop(id)` is view state: subscribers hear about it, `onChange` doesn't, and it adds no undo step.
- Use `load(value)` to follow a value the host owns (a controlled prop, a document being opened) and `setGradient(value)` for an edit the user should be able to undo.

`stopFromTrackPosition`, `trackPositionFromStop`, `gradientKeyStep`, `angleFromPointer` and `gradientTrackBackground` are the headless helpers the editor components use.

---

## 3. Components

### React

```tsx
import { useState } from "react";
import { ColorPicker, DualColorPicker, useColorScheme, useResolvedColor } from "@pixerate/editor-react/color";
import { GradientEditor, FillPicker, useGradientController } from "@pixerate/editor-react/gradient";
import type { DualColor } from "@pixerate/editor/color";

export function DesignPanel() {
  const [color, setColor] = useState("#3b82f6");
  const [brand, setBrand] = useState<DualColor>({ light: "#1d4ed8", dark: "#60a5fa" });
  const [fill, setFill] = useState("linear-gradient(90deg, #3b82f6 0%, #ec4899 100%)");
  const controller = useGradientController({ value: "linear-gradient(90deg, #f97316 0%, #ec4899 100%)" });

  const scheme = useColorScheme({ attribute: "data-theme" }); // or system preference, or { override }
  const brandNow = useResolvedColor(brand, scheme); // hex for canvas / SVG

  return (
    <>
      <ColorPicker value={color} onChange={setColor} alpha swatches={["#ef4444", "#3b82f6"]} contrastAgainst="#ffffff" />
      <DualColorPicker value={brand} onChange={setBrand} contrastAgainst={{ light: "#ffffff", dark: "#0b0b0f" }} />
      <GradientEditor controller={controller} showCss />
      <FillPicker value={fill} onChange={setFill} modes={["solid", "gradient"]} />
    </>
  );
}
```

**`ColorPicker`** has a saturation/brightness area, hue and alpha sliders, a text box that accepts any CSS colour, swatches, recent colours and an eyedropper where the browser has one. It emits hex.

| Prop | Notes |
| --- | --- |
| `value`, `onChange` | Required. |
| `onGestureStart` / `onGestureEnd` | Fire once per drag. If the picker unmounts mid-drag, the gesture is ended. |
| `alpha` | Shows the alpha slider and emits `#rrggbbaa`. |
| `swatches` | Preset colours to show. |
| `recent` / `onRecentChange` | Recent colours. Uncontrolled recents are kept in `localStorage`. |
| `contrastAgainst` | Shows WCAG badges against this colour. |
| `disabled`, `className`, `id`, `aria-label` | |

The transparency checkerboard can be themed with `--pixerate-checker-a` and `--pixerate-checker-b`.

**`DualColorPicker`** edits a `ColorValue` and emits a `DualColor`. Its props:
- `value`, `onChange`, and the two gesture callbacks.
- `scheme` / `onSchemeChange`: which half is being edited.
- `surfaces`: the two preview backgrounds.
- `contrastAgainst`: checked in both schemes.
- `alpha`, `swatches`, `disabled`, `className`.

It has a Light/Dark switch, a "Same in both" toggle and a Derive button. Derive calls `deriveDualColor` and counts as one gesture.

**`GradientEditor`** takes a `controller` and these optional props:
- `types`: the gradient types it offers.
- `showPresets` (default true) and `showCss` (default false).
- `dual`: edit stops as dual colours.
- `onGestureStart` / `onGestureEnd`: called for stop, angle and colour drags.
- `className`.

Each drag is one undo step in the controller.

**`FillPicker`** is a controlled solid-or-gradient picker. Its props:
- `value` (a CSS colour or gradient) and `onChange`.
- `modes`: the fill modes it offers.
- The two gesture callbacks.
- `alpha` and `swatches`, for the colour picker.
- `showPresets` and `showCss`, for the gradient editor.
- `disabled` and `className`.

Every gradient edit reaches `onChange`. A new `value` from the parent is loaded without an undo step, and the echo of the picker's own change is not loaded back, so the selected stop stays selected. Switching to solid emits the first stop's colour (the light half for a dual stop).

`useGradientController(options)` creates a controller for the component's lifetime, and `useGradientState(controller)` subscribes to it.

### Svelte 5

The Svelte components take the same props. Callbacks are lowercase (`onchange`, `ongesturestart`, `ongestureend`, `onschemechange`), and the camelCase names are also accepted. `class` replaces `className`.

```svelte
<script lang="ts">
  import { ColorPicker, DualColorPicker, createColorScheme, resolvedColor } from "@pixerate/editor-svelte/color";
  import { GradientEditor, FillPicker, createGradientController } from "@pixerate/editor-svelte/gradient";
  import type { DualColor } from "@pixerate/editor/color";

  let color = $state("#3b82f6");
  let brand = $state<DualColor>({ light: "#1d4ed8", dark: "#60a5fa" });
  let fill = $state("linear-gradient(90deg, #3b82f6 0%, #ec4899 100%)");
  const gradient = createGradientController({ value: "linear-gradient(90deg, #f97316 0%, #ec4899 100%)" });
  const scheme = createColorScheme({ attribute: "data-theme" });
  const brandNow = $derived(resolvedColor(brand, scheme.current));
</script>

<ColorPicker value={color} onchange={(c) => (color = c)} alpha />
<DualColorPicker value={brand} onchange={(d) => (brand = d)} />
<GradientEditor controller={gradient.controller} showCss />
<FillPicker value={fill} onchange={(f) => (fill = f)} />
```

`createColorScheme` defaults to watching `data-theme`. React's `useColorScheme` follows the system preference unless you pass `attribute`.

---

## 4. Agent tools

Both modules ship tool providers for a `ToolRegistry`; the `pixerate-color` skill (`packages/core/skills/pixerate-color/SKILL.md`) tells a model when to use each one.

```ts
import { ToolRegistry } from "@pixerate/editor/tools";
import { createColorToolProvider } from "@pixerate/editor/color";
import { GradientController, createGradientToolProvider } from "@pixerate/editor/gradient";

const registry = new ToolRegistry();
registry.register(createColorToolProvider()); // namespace "color"

const controller = new GradientController();
registry.register(createGradientToolProvider(controller, { readOnly: false })); // namespace "gradient"
```

In React or Svelte, register them with `useAgentToolProvider(registry, provider)` while the component is mounted. Give the gradient provider the same controller the `GradientEditor` uses, so the agent and the user edit the same gradient.

**Colour tools** (all read-only, no state):

| Tool | Does |
| --- | --- |
| `inspect_color` | Converts a colour to hex, rgb, hsl and oklch, with sRGB gamut and relative luminance. |
| `check_color_contrast` | WCAG ratio and AA/AAA level of a text/background pair, with an OKLCH lightness fix when it fails. |
| `check_color_palette` | Distinctness of a palette under normal vision and three deficiencies, plus surface contrast. |
| `suggest_color_harmony` | Harmony colours on the RGB or RYB wheel. |
| `blend_colors` | One mix (`t`) or an even ramp (`steps`) in OKLab, OKLCH, sRGB or linear sRGB. |
| `derive_dual_color` | The other scheme's half of a colour, matching contrast against the surfaces. |
| `check_dual_color_contrast` | Contrast of a dual pair in both schemes, with a fix per failing scheme. |
| `export_dual_colors_css` | CSS custom properties with the `light-dark`, `media` or `class` strategy. |

**Gradient tools** (write tools are hidden while the gradient is read-only):

| Tool | Does |
| --- | --- |
| `get_gradient` | The gradient, its CSS and SVG, whether it is dual, and the selected stop. |
| `check_gradient` | Crowded stops, banding risk, out-of-gamut colours and text contrast along the ramp. |
| `list_gradient_presets` | The built-in presets. |
| `set_gradient` | Replaces the gradient with an object or CSS string. |
| `set_gradient_geometry` | Type, angle, center, shape, interpolation and repeating, checked together and applied as one undo step. |
| `add_gradient_stop` | Inserts a stop and returns its id. |
| `update_gradient_stop` | Changes a stop's colour, offset or midpoint by id. |
| `remove_gradient_stop` | Removes a stop by id (never below two). |
| `reverse_gradient` | Mirrors the stops. |
| `distribute_gradient_stops` | Spaces the stops evenly. |
| `apply_gradient_preset` | Replaces the gradient with a preset by id. |
