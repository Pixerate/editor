---
name: pixerate-color
description: How to inspect colours, check and optimize WCAG contrast and accessibility, check palette distinctness across colour-vision deficiencies, generate harmonic color palettes, and blend colours across OKLab, OKLCH, and sRGB color spaces. Use when asked to evaluate contrast, choose accessible colours, create colour palettes, simulate colour blindness, or blend colours.
---

# Colour tools

The colour module provides DOM-free colour tools for inspection, WCAG accessibility validation, colour-vision deficiency simulation, palette audits, colour harmony suggestions, and perceptual blending.

## Working method

1. **Inspect and convert.** Run `inspect_color` to parse any hex, `rgb()`, `hsl()`, `oklch()`, or CSS named colour into standard formats (hex, rgb, hsl, oklch) and relative luminance, and to check if it fits within the sRGB gamut.
2. **Validate contrast.** Use `check_color_contrast` to compare text foreground against a background surface. It checks against WCAG 2 AA (4.5:1 regular, 3:1 large) and AAA (7:1 regular, 4.5:1 large). If AA contrast fails, it automatically calculates and suggests an adjusted lightness in OKLCH that preserves the hue and chroma while meeting accessibility standards.
3. **Audit palettes.** For multi-colour sets (such as chart series, UI accents, or status tags), run `check_color_palette` with the array of colours. This checks mutual perceptual distinctness under normal vision as well as protanopia, deuteranopia, and tritanopia, and verifies adequate contrast against the background surface.
4. **Harmonies and palettes.** Run `suggest_color_harmony` with a base colour and harmony kind (`complementary`, `split-complementary`, `analogous`, `triadic`, `tetradic`, `square`, or `monochromatic`) using either standard RGB or artistic RYB colour wheels.
5. **Perceptual blending.** Run `blend_colors` to interpolate between two colours in OKLab, OKLCH, sRGB, or sRGB-linear. Pass a factor `t` (0..1) for a single midpoint, or `steps` (2..32) for an even ramp.

## Best practices

- **Accessibility first.** Always check text and icon contrast against the actual background surface. Use the suggested foreground colour when `passesAA` is false.
- **Perceptual spaces.** Use OKLab / OKLCH for interpolation and distance metrics to avoid muddy midpoints and hue shifts common in linear RGB or HSL blending.
- **Palette distinctness.** In data visualizations and charts, ensure colours can be distinguished not only under normal vision but also under deuteranopia and protanopia.
- **Alpha handling.** Colours with partial alpha are supported; contrast calculations evaluate relative luminance.

## Tool reference

| Tool | When to use | Returns |
| --- | --- | --- |
| `inspect_color` | Inspects a colour string and converts between hex, rgb, hsl, and oklch, checking sRGB gamut and relative luminance | `{ hex, rgb, hsl, oklch, css, inSrgbGamut, relativeLuminance }` |
| `check_color_contrast` | Evaluates WCAG 2 contrast ratio between foreground and background, returning AA/AAA pass status and an OKLCH lightness suggestion if failing | `{ ratio, level, passesAA, passesAAA, suggestion? }` |
| `check_color_palette` | Audits an array of colours for pairwise distinctness across normal vision and CVD (protanopia, deuteranopia, tritanopia), and surface contrast | `{ ok, closest, contrast, issues, skipped }` |
| `suggest_color_harmony` | Generates harmonic colour combinations on RGB or RYB colour wheels | `{ colors: [{ hex, angle }] }` |
| `blend_colors` | Interpolates between two colours in OKLab, OKLCH, sRGB, or sRGB-linear at factor `t` or as an even `steps` ramp | `{ color }` or `{ colors }` |

## Pitfalls

- **Gamut clipping.** Colours specified in wide-gamut spaces (e.g. high-chroma OKLCH) will be mapped into sRGB for hex representations. Check `inSrgbGamut` if exact fidelity is required.
- **Large text thresholds.** WCAG allows 3:1 for large text (18pt / 24px or 14pt / 18.5px bold); pass `large: true` to avoid overly aggressive contrast suggestions.
- **Ramp steps bounds.** `blend_colors` requires `steps` to be between 2 and 32 when generating a ramp.
