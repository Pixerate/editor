---
name: pixerate-color
description: How to inspect colours, check and optimize WCAG contrast and accessibility, check palette distinctness across colour-vision deficiencies, generate harmonic color palettes, and blend colours across OKLab, OKLCH, and sRGB color spaces. Use when asked to evaluate contrast, choose accessible colours, create colour palettes, simulate colour blindness, or blend colours.
---

# Colour tools

The colour module provides DOM-free colour tools for inspection, WCAG accessibility validation, colour-vision deficiency simulation, palette audits, colour harmony suggestions, and perceptual blending.

## Workflow skills

For these jobs, load the workflow skill too: it has the method, the checks between steps and
the pitfalls, and uses the tools below.

- `pixerate-accessibility-audit`: contrast, colour-blind-safe meaning, both modes, fixes and a report.
- `pixerate-brand-application`: brand roles, exact palette values, readable text, derivatives.

## Working method

1. **Inspect and convert.** Run `inspect_color` to parse any hex, `rgb()`, `hsl()`, `oklch()`, or CSS named colour into standard formats (hex, rgb, hsl, oklch) and relative luminance, and to check if it fits within the sRGB gamut.
2. **Validate contrast.** Use `check_color_contrast` to compare text foreground against a background surface. It checks against WCAG 2 AA (4.5:1 regular, 3:1 large) and AAA (7:1 regular, 4.5:1 large). If AA contrast fails, it automatically calculates and suggests an adjusted lightness in OKLCH that preserves the hue and chroma while meeting accessibility standards.
3. **Audit palettes.** For multi-colour sets (such as chart series, UI accents, or status tags), run `check_color_palette` with the array of colours. This checks mutual perceptual distinctness under normal vision as well as protanopia, deuteranopia, and tritanopia, and verifies adequate contrast against the background surface.
4. **Harmonies and palettes.** Run `suggest_color_harmony` with a base colour and harmony kind (`complementary`, `split-complementary`, `analogous`, `triadic`, `tetradic`, `square`, or `monochromatic`) using either standard RGB or artistic RYB colour wheels.
5. **Perceptual blending.** Run `blend_colors` to interpolate between two colours in OKLab, OKLCH, sRGB, or sRGB-linear. Pass a factor `t` (0..1) for a single midpoint, or `steps` (2..32) for an even ramp.
6. **Design dual colours (light and dark mode).**
   - Design the light mode colour.
   - Run `derive_dual_color` with the app's real surfaces to automatically generate an accessible dark mode counterpart that matches contrast.
   - Run `check_dual_color_contrast` for each text and background pair across both modes.
   - Fix whichever mode fails using the suggested lightness.
   - Run `export_dual_colors_css` to output clean CSS custom properties using `light-dark()`, `@media (prefers-color-scheme: dark)`, or `.dark` class rules.
7. **Inspect and edit gradients.**
   - Run `get_gradient` to inspect the active gradient model, CSS output, SVG def markup, and dual-colour status.
   - Run `check_gradient` to audit for crowded stops, banding risk, out-of-gamut colours, and text contrast along the ramp.
   - Run `list_gradient_presets` and `apply_gradient_preset` to quickly set tested gradient compositions.
   - Modify gradient structure using `set_gradient`, `set_gradient_geometry`, `add_gradient_stop`, `update_gradient_stop`, `remove_gradient_stop`, `reverse_gradient`, or `distribute_gradient_stops`.

## Best practices

- **Accessibility first.** Always check text and icon contrast against the actual background surface. Use the suggested foreground colour when `passesAA` is false.
- **Check both modes every time.** When authoring themes, verify contrast in both light and dark modes. Never assume dark mode passes just because light mode does.
- **Don't simply invert lightness for brand colours.** When creating dark-mode variants, keep the hue and lower the chroma slightly rather than just inverting RGB channels.
- **Perceptual spaces.** Use OKLab / OKLCH for interpolation and distance metrics to avoid muddy midpoints and hue shifts common in linear RGB or HSL blending.
- **Palette distinctness.** In data visualizations and charts, ensure colours can be distinguished not only under normal vision but also under deuteranopia and protanopia.
- **Alpha in contrast checks.** A translucent foreground is composited over the background, and a translucent background over white, before the ratio is taken. If the real backdrop behind a translucent background isn't white, pass the opaque colour the user actually sees.

## Tool reference

| Tool | When to use | Returns |
| --- | --- | --- |
| `inspect_color` | Inspects a colour string and converts between hex, rgb, hsl, and oklch, checking sRGB gamut and relative luminance | `{ hex, rgb, hsl, oklch, css, inSrgbGamut, relativeLuminance }` |
| `check_color_contrast` | Evaluates WCAG 2 contrast ratio between foreground and background, returning AA/AAA pass status and an OKLCH lightness suggestion if failing | `{ ratio, level, passesAA, passesAAA, suggestion? }` |
| `check_color_palette` | Audits an array of colours for pairwise distinctness across normal vision and CVD (protanopia, deuteranopia, tritanopia), and surface contrast | `{ ok, closest, contrast, issues, skipped }` |
| `suggest_color_harmony` | Generates harmonic colour combinations on RGB or RYB colour wheels | `{ colors: [{ hex, angle }] }` |
| `blend_colors` | Interpolates between two colours in OKLab, OKLCH, sRGB, or sRGB-linear at factor `t` or as an even `steps` ramp | `{ color }` or `{ colors }` |
| `derive_dual_color` | Automatically derives the opposing scheme colour (light or dark) from a base colour, optionally preserving contrast against background surfaces | `{ light, dark, css, contrast: { light, dark } }` |
| `check_dual_color_contrast` | Evaluates WCAG contrast compliance for a foreground and background dual colour across both light and dark modes, with suggestions | `{ light: { ratio, level }, dark: { ratio, level }, issues, suggestion? }` |
| `export_dual_colors_css` | Generates CSS custom properties for dual colours using light-dark(), media queries, or darkSelector class | `{ css }` |
| `get_gradient` | Returns the current gradient model, CSS string, SVG def, and dual status | `{ gradient, css, svgDef, isDual, selectedStopId, readOnly }` |
| `check_gradient` | Audits gradient for crowded stops, banding risk, out-of-gamut colours, and text contrast | `{ pass, issueCount, issues }` |
| `list_gradient_presets` | Returns the collection of built-in gradient presets | `{ presets: [{ id, name, category, css, gradient }] }` |
| `set_gradient` | Replaces the entire gradient with a new gradient object or CSS string | `{ gradient, css }` |
| `set_gradient_geometry` | Changes any of type, angle, center, shape, interpolation, repeating in one undo step; pass only the fields to change. Angle applies to linear and conic, center to radial and conic, shape to radial only; a field that doesn't fit the (new) type fails the whole call and changes nothing | `{ gradient, css }` |
| `add_gradient_stop` | Adds a new color stop to the gradient ramp | `{ stop, gradient, css }` |
| `update_gradient_stop` | Updates an existing stop's color, offset, or midpoint | `{ stop, gradient, css }` |
| `remove_gradient_stop` | Removes a color stop by ID | `{ gradient, css }` |
| `reverse_gradient` | Reverses the order and offsets of all stops | `{ gradient, css }` |
| `distribute_gradient_stops` | Evenly distributes all color stops between 0 and 1 | `{ gradient, css }` |
| `apply_gradient_preset` | Applies a built-in gradient preset by ID | `{ preset, gradient, css }` |

## Pitfalls

- **`light-dark()` requires `color-scheme`.** CSS `light-dark()` only resolves the dark colour when `color-scheme: light dark;` is set on the element or an ancestor (such as `:root`). Without `color-scheme`, browsers always render the light colour.
- **JavaScript resolution required for non-CSS targets.** Canvas 2D, WebGL, SVG presentation attributes, and raster image exporters cannot read `light-dark()` strings; resolve them in JavaScript with `resolveColor(value, scheme)`.
- **Gamut clipping.** Colours specified in wide-gamut spaces (e.g. high-chroma OKLCH) will be mapped into sRGB for hex representations. Check `inSrgbGamut` if exact fidelity is required.
- **Large text thresholds.** WCAG allows 3:1 for large text (18pt / 24px or 14pt / 18.5px bold); pass `large: true` to avoid overly aggressive contrast suggestions.
- **Geometry fields depend on the type.** To make a radial circle, send `type: "radial"` and `shape: "circle"` in the same `set_gradient_geometry` call; sending `shape` to a linear gradient is an error.
- **Ramp steps bounds.** `blend_colors` requires `steps` to be between 2 and 32 when generating a ramp.
