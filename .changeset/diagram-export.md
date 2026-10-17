---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Mermaid diagrams can now be exported and previewed (ported from Ursula's thumbnails and PNG export). `mermaidToSvg` draws a standalone SVG that matches the canvas layout, with Mermaid styles, arrow heads and labels. `mermaidThumbnailSvg` fits it to a box. `rasterizeSvg` and `downloadDiagramPng` make PNGs in the browser. `createDiagramToolProvider({ renderSvg, rasterize })` adds a `render_diagram` agent tool. React and Svelte add `<MermaidThumbnail>`.
