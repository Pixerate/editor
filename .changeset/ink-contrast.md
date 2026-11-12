---
"@pixerate/editor": minor
---

One "text colour on this fill" helper (#797).

- `contrast(a, b, { scheme })` gives the WCAG 2 ratio for any colour the colour module reads (CSS text, `Rgba`, or a light / dark pair), or `null`.
- `ink(fill, { dark, light, threshold, luminance, scheme })` picks the ink that reads on a fill: whichever contrasts more (dark on a tie), or with `threshold`, dark when the fill is brighter than that (`luminance: 'wcag'` or `'bt601'`). `inkSide` says which side won.
- `chartTextOn` and `conditionalFormatContrastColor` now use it, with the same results as before (checked over every 17th step of each channel and other colour syntaxes).
- The house-style `min-contrast` check suggests the ink that passes (the brand's text or background colour, else near-black or white): findings carry `suggestion: { color, ratio }` and say it in the message.
- New colour agent tool `pick_text_color`: `{ fill, dark?, light?, large? }` → `{ color, side, ratio, passesAA }`.
