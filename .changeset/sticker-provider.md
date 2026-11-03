---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Sticker libraries: a sticker provider contract, the editor's stamps as the built-in set, and any sticker as a paint brush stamp.

- New dependency-free subpath `@pixerate/editor/stickers`:
  - `StickerProvider` (paged list and search, categories, describe, load as SVG or PNG, licences, tintable art);
  - `editorStickers()` (the editor's own stamps, with SVG outlines contoured from their shapes and PNGs);
  - `createFakeStickerProvider`, `combineStickerProviders` (refs `provider:id`), `checkStickerProvider`, `StickersSlot`, `StickerBrowser`;
  - the `find_stickers` / `describe_sticker` agent tools (`createStickerToolProvider`).
- Paint editor: `setStickersProvider` (default `editorStickers()`), `prepareStickers`, `stickerArtStatus` and the `rasterizeSticker` option. Sticker brushes (`sticker.stamps`) and stickers (`ref`) take refs to any sticker; provider art is loaded once, cached and tinted when tintable. Bare stamps in saved brushes and documents read as `editor:` refs and paint the same pixels. `Sticker.stamp` is now optional (editor stamps only) and `toggleStickerRef` replaces `toggleStamp`.
- Agent tools: `set_brush`, `paint_stroke`, `add_stickers` and `update_sticker` take refs, load their art first and refuse unknown ones with the closest refs; the paint provider adds `find_stickers` and `describe_sticker`.
- React and Svelte: a searchable, paged `StickerPicker` in `BrushPanel` (the sticker brush's stickers) and `StickerPanel` (changing a placed sticker).
