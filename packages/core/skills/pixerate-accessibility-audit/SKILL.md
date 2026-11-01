---
name: pixerate-accessibility-audit
description: The accessibility audit workflow across Pixerate editors - checking text contrast (WCAG AA 4.5:1, large text 3:1), non-text contrast for icons, borders and controls (3:1), colour-only meaning and palettes under colour-vision deficiencies, light and dark modes, type readability, and fixing what fails with the smallest change, then reporting what was checked and changed. Use when asked to audit, check or fix accessibility, contrast, legibility, readability or colour-blind safety of a design, chart, icon, document, UI or brand palette, or to meet WCAG, or when check_color_contrast, check_color_palette or check_dual_color_contrast are available. Load with pixerate-color, which lists the colour tools, and the skill for the editor that holds the design.
metadata:
  kind: workflow
  reference: pixerate-color
---

# Auditing accessibility

An accessibility audit finds what some readers cannot see or tell apart, fixes it with the
smallest change that keeps the design's intent, and reports both. Measure, never eyeball:
every text and background pair gets a contrast ratio, every set of colours that carries meaning
gets a colour-vision check, and every fix is measured again.

This skill is the method. `pixerate-color` has the colour tools; read colours from the design
with its editor's tools (`vector.list` in the vector editor, `get_chart` and
`check_chart_colors` for charts, `measure_region` for an image).

## Goal and quality bar

- Normal text at least 4.5:1 against its background, large text (24 px, or 18.5 px bold) at
  least 3:1 (`check_color_contrast`, with `large: true` for large text).
- Icons, borders, focus rings, chart lines and control outlines at least 3:1 against what they
  sit on.
- Colours that carry meaning (status, series, categories) distinct under protanopia,
  deuteranopia and tritanopia (`check_color_palette` `ok: true`), and not the only cue (add a
  label, shape or pattern where meaning matters).
- Both light and dark modes pass when the design has them (`check_dual_color_contrast`).
- Fixes change as little as possible: the text colour rather than the brand background, a
  darker shade of the same hue rather than a new hue.
- A report lists each pair checked, its ratio before and after, and what changed.

## Inputs to confirm

- **The standard:** WCAG 2 AA (the default) or AAA.
- **What may change:** usually text and icon colours; brand backgrounds and logos only with
  approval.
- **Modes:** light, dark or both.

## Working method

1. **Inventory.** Read every foreground and background pair from the design's editor: text on
   surfaces, icons on cards, lines on plots, status colours.
   **Check:** each pair has a role (normal text, large text, graphic, decorative).
2. **Measure.** `check_color_contrast` for each pair (`large: true` for large text);
   `check_color_palette` for sets of meaningful colours; `check_dual_color_contrast` for dual
   colours.
   **Check:** a list of failures with their ratios.
3. **Fix the smallest thing.** Use the `suggestion` the contrast check returns (a lightness that
   passes), or a darker or lighter shade of the same hue; for palettes, replace the clashing
   colours with ones that differ in lightness as well as hue (blue and orange rather than red and
   green). Apply with the editor's own tools (`vector.setStyle`, `update_chart_series`).
   **Check:** measure the pair again; it passes.
4. **Meaning without colour.** Where a palette carries meaning, make sure a label, icon or shape
   carries it too.
5. **Report** pairs, ratios before and after, and anything left that needs a decision (a brand
   colour that cannot pass with any text colour).

## Decision table

| Element | Requirement | Tool |
| --- | --- | --- |
| Body text, labels | 4.5:1 | `check_color_contrast` |
| Large or bold headings | 3:1 | `check_color_contrast` with `large: true` |
| Icons, borders, focus rings, chart lines | 3:1 | `check_color_contrast` |
| Status or series colours | Distinct under CVD | `check_color_palette` |
| Light and dark themes | Both pass | `check_dual_color_contrast` |
| Decorative graphics, disabled controls, logos | No requirement | Note them as exempt |

## Recipes

**Fix a button label.** `check_color_contrast` `{ foreground: label, background: button }` →
use its suggested lightness or a dark shade of the button's hue → apply → check again.

**Colour-blind-safe status colours.** `check_color_palette` with the three colours → replace with
a set that varies in lightness (`#0072b2`, `#e69f00`, `#000000`) → check again; keep the labels.

**A faint icon.** `check_color_contrast` icon stroke against the card; darken the stroke until it
reaches 3:1.

## Pitfalls

- **Eyeballing contrast.** Screens and eyes vary; measure every pair.
- **Changing the brand colour** to fix text; change the text first.
- **Large-text allowance on small text.** 3:1 applies only to large or bold-large text.
- **Translucent colours** are measured composited over their real backdrop; pass the opaque
  backdrop.
- **Red and green only** for meaning fails the most common colour-vision deficiency.
- **Fixing one mode** and breaking the other in a dual theme.

## Tools used

- `check_color_contrast`: text and graphic contrast, with a suggested passing lightness
- `check_color_palette`: distinctness under colour-vision deficiencies
- `check_dual_color_contrast`, `derive_dual_color`: light and dark modes
- `inspect_color`: parse and convert a colour
- `blend_colors`: shades and tints of a hue
