---
"@pixerate/editor": minor
---

House style reaches every editor domain (#772):

- **`brand.json`**: a style skill can carry a shared brand (colour roles, an ordered palette, fonts, a logo). Every domain gets it as `ResolvedStyle.brand` and in `get_style`, and `get_style` with domain `"brand"` reads it alone. Roles are looked up through fallback names, so Office theme slots (`accent1`, `dk1`, `lt1`, ...) work too: `brandColor`, `brandColors`, `brandPalette`, `brandFonts`, `BRAND_COLOR_ROLES`.
- **Derived styles**: `StyleDomain.themeFromBrand(brand)` gives a domain its starting profile from the brand; the domain's own profile refines it field by field, and `sources` marks derived fields `<layer> (brand)`. Charts derive their palette and theme (`chartStyleFromBrand`).
- **Shared checks**: `StyleDomain.surface(state)` lists the colours and fonts a domain draws with, and `SHARED_STYLE_CHECKS` (`palette-only`, `min-contrast`, `distinguishable`, `fonts-allowed`) then run there. A domain's own check with the same id wins. A brand's `checks` run in every `check_<domain>_style`. Charts and design tokens have surfaces (`tokensStyleSurface`).
- `StyleCheck.run` takes a fourth `context` argument with the brand; `styleChecksOf(domain)` lists the checks a profile can turn on.
