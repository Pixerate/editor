---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Brush previews read on what they are drawn on.

- `brushPreviewColours(brush, { paper, profile })` gives a preview's background and a stroke colour with at least 3:1 contrast against it: the brush's default for that background (a light / dark pair takes its side), else a colour for the medium. `brushPreviewsOnDark`: light paint previews on dark paper, but a multiply highlighter previews on its paper.
- `BrushPreviewRenderer` can say what it draws on (`paper`; `paintBrushPreviewRenderer` does). Canvas brush swatches take a `background` and colour each brush for it.
- `BrushLibraryEditor` takes `previewPaper` (the box behind transparent previews) and chooses its preview colour with `brushPreviewColours`; `previewColor` is now only an override. `BrushEditor` takes `previewBackground`. Paint `BrushPanel` thumbnails colour each brush for the paper.
- The ballpoint, gel pen and fineliner defaults are light / dark pairs, so they stay visible in dark-scheme editors.
