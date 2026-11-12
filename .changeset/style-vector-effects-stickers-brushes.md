---
"@pixerate/editor": minor
---

House style for vector drawings, effect authoring, stickers and brushes, completing house style for every editor (#779).

- `vectorStyleDomain` (`vector.json`): stroke widths and corner radii allowed, and the brand's palette-only, min-contrast and fonts-allowed on solid fills, strokes, text and the artboard. Agent tools `check_vector_style` and `fix_vector_style` (snaps widths and radii to the nearest house value as one undo step; hidden when read-only), `createVectorStyleToolProvider`.
- `effectAuthoringStyleDomain` (`effect-authoring.json`): the source languages allowed, a timing limit and looping, the presets every effect ships, and the brand's palette-only on colour controls. Agent tools `check_effect_authoring_style` and `fix_effect_authoring_style` (sets the house timing as one undo step), `createEffectAuthoringStyleToolProvider({ session })`.
- `stickerStyleDomain` (`stickers.json`): sticker libraries and collections allowed, commercial licences only, no AI-generated art, banned tags, and the brand's palette-only on tints. Read-only agent tool `check_sticker_style` checks stickers by ref before placing them and returns the `find_stickers` filters that keep a search in the house style.
- `brushStyleDomain` (`brushes.json`): brushes and media allowed, licences recorded on image sources, and the brand's palette-only on brush colours. Read-only agent tool `check_brush_style` checks the user's saved brushes, or any brushes by id; `brushStyleState(library)` builds the state for hooks.
- The `pixerate-style` command now knows every editor domain the package ships, not only chart and tokens.
- `check_generation_style`'s annotation title now matches its tool title.
