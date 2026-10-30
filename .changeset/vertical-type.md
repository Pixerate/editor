---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vertical writing in the shared text layout. Type layers and vector text nodes take `orientation: 'vertical'`: lines become columns running top to bottom, stacked right to left; CJK stands upright, Latin and other horizontal scripts turn 90° clockwise unless styled `upright`. Layout uses the font's `vhea` / `vmtx` (and `VORG`) metrics and `vert` alternates when the outline shaper has them (the OpenType reader now parses them), falling back to the ascent and descent, turned brackets and corner punctuation nudged to the upper right. Caret, hit testing, selection and arrow keys run down the columns (`caretAt(...).from` / `to`, `textSelectionQuads`, `textArrowStep`, `textLineMove`). PSD type imports and exports `Ornt` `Vrtc` (and upright Latin through `BaselineDirection`) so vertical type round-trips, as do JSON and SVG. New agent tools `set_text_orientation` and `vector.setTextOrientation`, an `orientation` option on `add_text_layer`, `textOrientation` on `vector.addText`, and an `upright` style field. React and Svelte `TypeOptionsBar` and `VectorTextPanel` gain Horizontal / Vertical and Upright Latin controls.

The Vertical Type Mask (`selectTextShape` with `orientation: 'vertical'`, `select_text_shape`) now uses this layout instead of stacking characters into one centred column: (x, y) is the top of the first column, line breaks start new columns, a box is allowed, and Latin turns sideways as it does in Photoshop.
