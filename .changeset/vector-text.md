---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector text: point, area and path text nodes in `@pixerate/editor/vector`, with styled runs, paragraph styles, the Type and Type on a Path tools, on-canvas editing, Create Outlines, SVG text export / import and `vector.*Text` agent commands. Text lays out with the engine of the image editor's type layers, now shared in `src/text` (the image editor re-exports it unchanged), and a built-in OpenType reader (`parseOpenTypeFont`, `loadOpenTypeFont`) gives the outline shaper glyphs from TrueType, CFF and WOFF files. React and Svelte add `VectorTextPanel` and `VectorTextElement`, and the canvases take typing through a hidden textarea.
