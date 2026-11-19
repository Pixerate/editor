---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Canvas capture surfaces take `layers`: elements drawn outside the flow's viewport (ink, paint), each with its bounds in flow coordinates. `content` frames them with the nodes, and every re-framed region (content, selection, nodes, rect) draws them in this frame, under or over the nodes as on screen. `useCanvasCapture` reads the latest `layers`; `createCanvasCapture` passes them through.
