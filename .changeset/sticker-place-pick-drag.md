---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor stickers can be placed, picked and dragged. Core adds `addStickers`, `stickerAt`, `selectSticker` (with `selectedSticker` in the editor state), `previewSticker` / `cancelStickerPreview` for live drags that drop as one undo step, and the `add_stickers` and `sticker_at` agent tools. Sticker edits now redraw only the tiles they touch. A new Stickers tool (S) places the active brush's first stamp with a click, and picks and drags stickers on the canvas. The picked sticker is outlined, and `StickerPanel` follows the canvas pick and has X/Y fields, in React and Svelte.
