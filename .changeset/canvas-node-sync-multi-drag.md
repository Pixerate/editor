---
"@pixerate/editor-svelte": minor
---

Add canvas node synchronization, multi-drag coordination, selection helpers, and floating horizontal scrollbar

- `createCanvasNodeSync`: Headless rune for synchronizing reactive item collections into SvelteFlow nodes/edges with untracked node reads to prevent effect cycle crashes, handle normalization (`normalizeNodeHandles`), and dimension preservation (`preserveNodeMeasurements`).
- `createCanvasMultiDrag`: Multi-node drag coordination rune with leader-follower relative offset tracking, dynamic z-indexing, fan-out rotations (`fanning`), and coordinate restoration on canceled drops.
- `createCanvasSelection` & `getMarqueeSelectionPreset`: Canvas marquee drag-to-select configuration presets and Escape-key deselect helpers.
- `FloatingHorizontalScrollbar`: Docked overlay horizontal scrollbar for wide canvas viewports with bidirectional sync and custom viewport bounds.
