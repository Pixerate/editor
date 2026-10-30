---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Type masks. `selectTextShape` (the Horizontal and Vertical Type Mask) selects the shape of text laid out as `addTextLayer` would place it (font, size, weight, tracking, box, rotation), combined by mode, with feather and anti-aliasing, without adding a layer, as one undo step. It works with any text shaper, because it uses the drawn glyphs' coverage rather than their outlines. Vertical type masks stack the characters in one column centred on the click; real vertical text layout is a follow-up in the shared text module. New agent tool `select_text_shape`. The selection tools gain `type` and `type-vertical` (a click places the text), with `typeText`, `typeSize` and `typeFamily` options, and the React and Svelte `SelectionOptionsBar` show Type Mask and Vertical Type Mask with text, size and font fields.
