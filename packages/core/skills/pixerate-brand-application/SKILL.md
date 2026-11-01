---
name: pixerate-brand-application
description: The brand application workflow across Pixerate editors - applying a brand palette, type and tokens to a design, chart or document, mapping each element to its brand role (background, primary, accent, text), snapping near-miss colours to the palette, keeping text readable on brand colours, deriving tints and dark-mode variants without leaving the brand, and running the house-style checks. Use when asked to brand, rebrand, apply a brand, style guide, palette, theme or design tokens, make something on-brand, snap colours to a palette, or check brand consistency, or when check_color_contrast, check_color_palette, blend_colors or a check_*_style tool is available. Load with pixerate-color, which lists the colour tools, and the skill for the editor that holds the design.
metadata:
  kind: workflow
  reference: pixerate-color
---

# Applying a brand

A brand is a small set of decisions: a palette with roles (background, primary, accent, text),
type, and rules for using them. Applying it means mapping every element of a design to a role
and giving it that role's value exactly, not something close. Colours outside the palette are
either snapped to the nearest brand colour or derived from one deliberately (a tint, a dark-mode
variant), and every text pairing still meets contrast.

This skill is the method. `pixerate-color` has the colour tools; the design's editor applies the
values (`vector.setStyle`, `update_chart_series`), design tokens live in `pixerate-tokens`, type
in `pixerate-typography`, and a host's house style in `check_*_style` tools.

## Goal and quality bar

- Every colour in the design is a brand colour, or a documented derivative of one (a tint, a
  shade, a dark-mode pair).
- Each element has the colour of its role: backgrounds, primary surfaces, accents, text.
- Text on every brand surface meets WCAG AA (see `pixerate-accessibility-audit`).
- Values are exact (`#1d3557`, not `#1f3759`), referenced from tokens where the editor supports
  them.
- Layout, geometry and content are unchanged by the rebrand.
- House-style checks pass where the host provides them.

## Inputs to confirm

- **The palette with roles**, or a tokens set (`pixerate-tokens`), and the type.
- **Which elements take which role** when it is not obvious.
- **What to do when a pairing cannot meet contrast** (another palette colour, larger text, or an
  approved derivative).

## Working method

1. **Read the design** with its editor: every element's fills, strokes and text colours.
   **Check:** each element has a role.
2. **Map roles to brand values.** Write the mapping (background → `#f1faee`, panel → primary,
   badge → accent) before changing anything.
3. **Apply exactly**, in one batch where the editor allows it (`run_commands` of
   `vector.setStyle`, one `update_chart` call).
   **Check:** reading the design again shows only brand values, and geometry unchanged.
4. **Snap near-misses.** For colours close to the palette, pick the nearest brand colour by
   perceptual distance (OKLab): `inspect_color` gives each colour's OKLCH for comparison.
5. **Readable text.** `check_color_contrast` for each text-on-surface pair; when white fails on a
   light brand colour, use the darkest brand colour for the text.
   **Check:** every text pair passes AA.
6. **Derivatives.** Tints and shades with `blend_colors` in OKLab from a brand colour; dark-mode
   pairs with `derive_dual_color`. Name and report them.
7. **House style.** Run the host's `check_*_style` tools (for example `check_chart_style`) and fix
   what they report.

## Decision table

| Situation | Approach |
| --- | --- |
| A colour close to a brand colour | Snap to the nearest by OKLab distance |
| A needed colour not in the palette | Tint or shade a brand colour (`blend_colors`), and say so |
| White text fails on a light brand colour | The darkest brand colour for text |
| No palette colour passes on a surface | Report it; propose larger text or another surface colour |
| A dark mode is needed | `derive_dual_color` from each brand colour |
| Charts | Series colours from the palette in its order, checked with `check_chart_colors` |
| Tokens available | Apply token references, not raw values |

## Recipes

**Apply a palette.** Read element ids → one `run_commands` with a `vector.setStyle` per element
and its brand `fill` → read again to confirm values and bounds.

**Snap to the palette.** `inspect_color` each off-brand colour and each brand colour; pick the
smallest OKLab distance; apply.

**Readable badge text.** `check_color_contrast` white and the darkest brand colour on the badge;
apply the one that passes.

## Pitfalls

- **Close is not on-brand.** `#1f3759` beside `#1d3557` looks the same and fails every audit.
- **Inventing colours** to fix contrast leaves the brand; use a palette colour or an approved
  derivative.
- **Some pairings can never pass**: no text colour reaches 4.5:1 on a mid-tone red or blue.
  Report it instead of breaking the brand silently.
- **Rebranding moves things**: change only colours and type, not geometry or content.
- **Accent overuse**: accents mark what matters; most of a design is background and primary.
- **Hue-only palettes** for charts fail colour-blind readers; check them.

## Tools used

- `inspect_color`: parse colours and compare them in OKLCH
- `check_color_contrast`: text on brand surfaces
- `check_color_palette`: brand colours used for meaning, under colour-vision deficiencies
- `blend_colors`: tints and shades of brand colours
- `derive_dual_color`, `check_dual_color_contrast`: dark-mode variants
- `suggest_color_harmony`: supporting colours when the palette has gaps
