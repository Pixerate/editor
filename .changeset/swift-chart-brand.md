---
"@pixerate/editor": patch
"@pixerate/swift": minor
---

Swift charts read the house style's `brand.json` (part of #791).

- `ChartStyleResolver(skill:layer:chartJson:brandJson:)` validates `brand.json` as `createStyleResolver` does (its schema, and its `checks` list against the shared checks), derives the chart profile from it (`chartStyleFromBrand`: palette, theme colours and a font stack), merges the skill's own `chart.json` over that, and runs the brand's checks after the profile's own. A brand that fails validation is left out with the same issue message as in the TS core.
- `fonts-allowed` is a chart check in Swift too: the chart surface has no fonts, so it runs with no findings once a font is named and is skipped with the reason otherwise.
- `PixerateCore` gains the brand helpers (`BRAND_COLOR_ROLES`, `brandColor`, `brandColors`, `brandPalette`, `brandFonts`, `BRAND_PROFILE_SCHEMA`, `SHARED_STYLE_CHECK_OPTIONS`) for the other domains to share.
- The chart conformance host takes `setup.brand`, with two new scenarios: `style-brand` and `style-brand-invalid`.
