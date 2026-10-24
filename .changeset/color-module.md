---
"@pixerate/editor": minor
---

feat(core): add shared colour module (@pixerate/editor/color)

- Zero-dependency colour parsing for CSS Color 4 syntax (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color(srgb)`, `color(srgb-linear)`, `color(display-p3)` and 148 standard CSS names)
- Conversions between sRGB, linear sRGB, HSL, HSV, OKLab, OKLCH, and Display P3
- CSS Color 4 OKLCH chroma binary-search gamut mapping (`toSrgbGamut`, `inSrgbGamut`)
- WCAG 2 contrast ratios, APCA contrast, and readable text colour determination
- Machado-Oliveira-Fernandes (2009) colour-vision deficiency simulation and palette harmony checks
- Colour harmonies on RGB and artistic RYB wheels (`colorHarmony`)
- Perceptual colour mixing in OKLab, OKLCH, sRGB, and sRGB-linear spaces
