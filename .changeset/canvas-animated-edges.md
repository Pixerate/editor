---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Animated canvas edges: travelling dots, marching dashes, beams and pulses. An edge's animation lives in `edge.data.animation` (kind, speed in canvas units per second or a duration, direction, colour, size, count, length, gap, glow, track opacity, paused), so it saves, copies and undoes with the edge. Core adds `getCanvasEdgePath` (the same paths xyflow draws), `measureSvgPath`, `getCanvasEdgeAnimationRender` (framework-neutral SVG + SMIL), `sampleCanvasEdgeAnimation` (a frame at any time, without a browser) and the agent tools `list_edge_animations`, `set_edge_animation` and `clear_edge_animation` (`createCanvasEdgeAnimationToolProvider`, one undo step per call). React and Svelte add `<AnimatedEdge>` (register it as a React Flow / Svelte Flow edge type; `data.pathType` picks the path) and `<EdgeAnimation>` for your own edges. Both hold the first frame when the user prefers reduced motion.
