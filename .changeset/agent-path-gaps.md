---
"@pixerate/editor": minor
---

Close agent-path gaps found while writing the agent skills:

- Spreadsheet: `merge_cells`, `unmerge_cells` and `transpose_range` tools take an A1 range instead of depending on the user's selection, check merges and read-only cells first, and return what changed. `get_range` now lists the merged ranges it touches. The `spreadsheet.mergeCells` / `unmergeCells` / `transposeRange` commands fail with a reason instead of returning `false` when nothing changes.
- Image editor: `get_image_info`, `get_histogram` (clipping, mean and percentiles), `update_adjustment_layer` (enabled, blend, opacity, name), `move_adjustment_layer`, `remove_adjustment_layer`, `set_crop`, `reset_crop`, `set_rotation`, `flip_image`, `undo_image` and `redo_image` (`createImageEditTools`, included in `createImageEditorToolProvider`).
- Generation: `createGenerationHistoryToolProvider` exposes a `GenerationRecordStore` to agents with `list_generations`, `get_generation`, `recreate_generation` and `vary_generation`; the last two return a request and drift report for `generate` instead of spending.
