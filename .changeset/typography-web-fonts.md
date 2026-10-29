---
'@pixerate/editor': minor
---

Web font services for typography. `createStylesheetFontProvider` loads fonts from any service that serves CSS: `loadFont` adds the face's stylesheet once (asking for the nearest weight and a style the family has, since services reject the others) and resolves when `document.fonts` has the face. `createGoogleFontsProvider({ catalog })` does this for Google Fonts or a css2-compatible mirror; the host supplies the metadata (fonts.google.com allows no cross-origin reads), and `googleFontsCatalog` and `googleFontsStylesheetUrl` are exported for hosts that fetch or build it themselves. The catalog lists the most popular families first and files a family classified as display, handwriting or monospace under that category (Anton is a sans serif classified as display).

`FontSummary.tags` carries a provider's classes (`display`, `slab-serif`, `variable-wdth`…), `filterFonts` takes `tags`, and `list_fonts` takes `tags` and returns the tags of every font it matched with their counts, so an agent can narrow a large web catalog to faces with the character it wants.
