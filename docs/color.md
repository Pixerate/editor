# Colour and Gradients

`@pixerate/editor/color` and `@pixerate/editor/gradient` provide a modern, UI-agnostic colour and gradient toolkit for creative applications, design tokens, and AI agents.

The core packages contain zero DOM and zero UI-framework dependencies. React (`@pixerate/editor-react/color`, `@pixerate/editor-react/gradient`) and Svelte (`@pixerate/editor-svelte/color`, `@pixerate/editor-svelte/gradient`) export equivalent hooks/runes and accessible components.

---

## 1. Colour Engine (`@pixerate/editor/color`)

### Parsing and Formatting

Parse any valid CSS Color 3 or Color 4 string into an exact `Color` structure:

```ts
import { parseColor, formatColor, convertColor } from "@pixerate/editor/color";

// Parse CSS color strings (hex, rgb, hsl, oklab, oklch, color(srgb/display-p3))
const c1 = parseColor("#ff007f");
const c2 = parseColor("oklch(0.65 0.25 350 / 0.8)");
const c3 = parseColor("color(display-p3 1 0 0.5)");

// Format to any standard notation
formatColor(c1, "hex");     // "#ff007f"
formatColor(c2, "oklch");   // "oklch(0.65 0.25 350 / 0.8)"
formatColor(c3, "rgb");     // "rgb(255 0 128 / 1)"

// Lossless conversion between spaces
const oklch = convertColor(c1, "oklch");
```

### Gamut Mapping

Clamp out-of-gamut colours into standard sRGB or Display P3 using OKLCH binary chroma reduction that preserves perceptual hue and lightness:

```ts
import { inGamut, clampToGamut } from "@pixerate/editor/color";

const vibrant = parseColor("oklch(0.7 0.35 140)");
inGamut(vibrant, "srgb"); // false

const safeSrgb = clampToGamut(vibrant, "srgb");
inGamut(safeSrgb, "srgb"); // true
```

### Contrast and Accessibility

Calculate WCAG 2.1 relative luminance ratios and APCA perceptual contrast:

```ts
import { contrastRatio, apcaContrast, meetsWcag } from "@pixerate/editor/color";

const text = parseColor("#ffffff");
const bg = parseColor("#1e293b");

const ratio = contrastRatio(text, bg); // ~13.5
meetsWcag(text, bg, "AA");             // true (requires >= 4.5:1 for normal text)
meetsWcag(text, bg, "AAA");            // true (requires >= 7:1)

const apcaLc = apcaContrast(text, bg); // Perceptual light-on-dark contrast value
```

### Colour Harmonies and Colour Vision Deficiency

Generate colour harmonies or simulate how a colour appears to users with colour vision deficiency (using the Machado 2009 model):

```ts
import { colorHarmony, simulateColorVision } from "@pixerate/editor/color";

// Harmonies: analogous, complementary, triadic, tetradic, split-complementary, monochromatic
const base = parseColor("#3b82f6");
const triad = colorHarmony(base, "triadic", "oklch"); // 3 harmonious colors

// CVD simulation: protanopia, deuteranopia, tritanopia, achromatopsia
const protan = simulateColorVision(base, "protanopia", 1.0); // severe protanopia
```

### Dual Light/Dark Tokens

Define pairs of colours for light and dark themes and serialize them into standard CSS Color 4 tokens:

```ts
import { createDualColor, dualColorsToCss } from "@pixerate/editor/color";

const surface = createDualColor("#ffffff", "#0f172a");
const text = createDualColor("#0f172a", "#f8fafc");

// Generate CSS variables with light-dark(), @media (prefers-color-scheme), or .dark class strategy:
const css = dualColorsToCss(
  { surface, text },
  { prefix: "app", strategy: "light-dark" }
);
```

---

## 2. Gradient Engine (`@pixerate/editor/gradient`)

### Gradient Data Model and Controller

Represent linear, radial, and conic gradients with arbitrary stops, midpoints, and interpolation color spaces (sRGB, linear-RGB, or OKLab):

```ts
import {
  GradientController,
  createDefaultGradient,
  gradientToCss,
} from "@pixerate/editor/gradient";

const gradient = createDefaultGradient("linear");
const controller = new GradientController(gradient);

controller.subscribe((state) => {
  console.log("Updated gradient:", state);
});

// Manipulate stops with undoable actions
controller.addStop(0.5, "#ec4899");
controller.setAngle(135);
controller.setInterpolation("oklab");

// Export to CSS
const cssBg = gradientToCss(controller.state);
// "linear-gradient(135deg in oklab, ...)"
```

---

## 3. UI Components

### React (`@pixerate/editor-react`)

```tsx
import { useState } from "react";
import { ColorPicker, DualColorPicker } from "@pixerate/editor-react/color";
import { GradientEditor, FillPicker } from "@pixerate/editor-react/gradient";
import type { Gradient } from "@pixerate/editor/gradient";

export function DesignTool() {
  const [color, setColor] = useState("#3b82f6");
  const [fill, setFill] = useState<string | Gradient>("#3b82f6");

  return (
    <div className="space-y-6 p-4">
      {/* Interactive Color Picker */}
      <ColorPicker
        value={color}
        onChange={setColor}
        alpha={true}
        swatches={["#ef4444", "#3b82f6", "#10b981", "#f59e0b"]}
      />

      {/* Dual Light/Dark Color Picker */}
      <DualColorPicker
        light="#ffffff"
        dark="#1e293b"
        onChange={({ light, dark }) => console.log(light, dark)}
      />

      {/* Solid or Gradient Fill Picker */}
      <FillPicker
        value={fill}
        onChange={setFill}
        allowGradient={true}
      />
    </div>
  );
}
```

### Svelte 5 (`@pixerate/editor-svelte`)

```svelte
<script lang="ts">
  import { ColorPicker, DualColorPicker } from "@pixerate/editor-svelte/color";
  import { GradientEditor, FillPicker } from "@pixerate/editor-svelte/gradient";
  import type { Gradient } from "@pixerate/editor/gradient";

  let color = $state("#3b82f6");
  let fill = $state<string | Gradient>("#3b82f6");
</script>

<div class="space-y-6 p-4">
  <ColorPicker
    value={color}
    onchange={(c) => (color = c)}
    alpha={true}
    swatches={["#ef4444", "#3b82f6", "#10b981", "#f59e0b"]}
  />

  <DualColorPicker
    light="#ffffff"
    dark="#1e293b"
    onchange={({ light, dark }) => console.log(light, dark)}
  />

  <FillPicker
    value={fill}
    onchange={(f) => (fill = f)}
    allowGradient={true}
  />
</div>
```

---

## 4. Agent Tools and MCP Integration

Every colour and gradient operation is exposed to autonomous AI agents via tool providers in `@pixerate/editor/color` and `@pixerate/editor/gradient`:

```ts
import { ToolRegistry } from "@pixerate/editor/agent";
import { createColorToolProvider } from "@pixerate/editor/color";
import { createGradientToolProvider } from "@pixerate/editor/gradient";

const registry = new ToolRegistry();

// Register color inspection & conversion tools:
registry.registerProvider(createColorToolProvider({
  getColor: () => activeColor,
  setColor: (c) => setActiveColor(c),
}));

// Register gradient manipulation tools:
registry.registerProvider(createGradientToolProvider({
  getGradient: () => gradientController.state,
  setGradient: (g) => gradientController.setGradient(g),
}));
```

Tools registered include:
- `color_get`: Retrieve current active color in multiple representations.
- `color_set`: Set color from any valid format.
- `color_convert`: Convert color strings between hex, rgb, hsl, oklab, and oklch spaces.
- `color_contrast`: Measure WCAG and APCA contrast between two colours.
- `color_harmonies`: Retrieve matching harmonic palettes.
- `color_simulate_vision`: Test colour appearance under protanopia, deuteranopia, tritanopia, or achromatopsia.
- `gradient_get`: Inspect gradient stops, midpoints, angle, and type.
- `gradient_set`: Configure gradient geometry and interpolation.
- `gradient_add_stop`: Insert stops with normalized offsets.
- `gradient_remove_stop`: Delete stops by index.
- `gradient_set_stop`: Update stop colour, offset, and midpoint.
