# Third-Party Notices

Portions of this repository are ported from third-party source code. Each ported file carries a
header comment naming its source. The ported algorithms were re-expressed in TypeScript; test cases
were re-expressed as vitest cases rather than copied.

All sources below are from the ArtCraft "craft" apps, each licensed **MIT OR Apache-2.0**,
© 2026 ArtCraft Team and the respective app's contributors. They are used here under the MIT licence
reproduced at the end of this file. Paths are relative to each source repository.

## craft-libs

© 2026 ArtCraft Team and the craft-libs contributors.

- `crates/settings/src/migrate.rs` (`upgrade`: step-wise migration to a target version, missing version taken as current, newer version left alone) → `migrateDocument` in `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/document.rs` (`deserialize_sections`: per-section fallback to defaults) → `loadSections` in `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/error.rs` (`LoadReport`, `has_problems`, `SectionError`, read-only reasons) → `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/store.rs` (debounced save, `retry_delay` exponential backoff with cap) → `packages/core/src/persistence/autosave.ts`, `exponentialBackoff` in `packages/core/src/persistence/recoveryPolicy.ts`
- Test cases from `crates/settings/tests/migrate.rs`, `tests/recovery.rs` and `tests/store.rs`, re-expressed → `packages/core/tests/persistence-migrate.test.ts`, `packages/core/tests/persistence-policy.test.ts`

## figcraft

© 2026 ArtCraft Team and the FigCraft contributors.

- `crates/engine/src/distance.rs` (`between`, `inside`, `to_guide`, `label`) → `packages/core/src/canvas/measure.ts`
- `crates/engine/src/measure_tests.rs` (test cases re-expressed) → `packages/core/tests/canvas-measure.test.ts`
- `crates/layout/src/lib.rs` (`layout_frame`, `distribute`, `main_offsets`, `fit_hug_text`, `enforce_limits`, `item_baseline`, `resize_child`, `grid_place`, `resolve_tracks`, `track_content`, `grid_geometry`, `layout_grid`, `apply_constraints`, `layout_page`, `layout_up`, `coherent_sizing`, `clamp_size`) → `packages/core/src/canvas/autoLayout.ts`
- `crates/layout/src/{tests.rs,behaviour_tests.rs,nested_tests.rs,content_align_tests.rs}` (test cases re-expressed) → `packages/core/tests/canvas-auto-layout.test.ts`

## filmcraft

© 2026 ArtCraft Team and the FilmCraft contributors.

- `crates/engine/src/lib.rs` (`Session::edit_merged`, `undo_mark`, `revert_to`) → `packages/core/src/history/HistoryManager.ts`
- `crates/engine/src/commands.rs` (command specs, lookup by id, enablement with reasons) → `packages/core/src/commands/registry.ts`
- `crates/engine/src/lib.rs` (`Session::execute`, `enabled_for`: re-checking enablement against targets named in params, catching command failures) → `packages/core/src/commands/registry.ts`
- `crates/engine/src/shortcuts.rs` and `crates/engine/src/shortcuts_tests.rs` (platform-neutral chords, `Mod` resolution per platform, scoped bindings, conflict detection, per-platform conflict test) → `packages/core/src/commands/chords.ts`, `packages/core/src/commands/shortcuts.ts`, `packages/core/tests/commands.test.ts`
- `crates/automation/src/server.rs` (`command_list` / `command_run` / `command_batch` tools, complete MCP annotations, unknown-argument errors naming the accepted keys) → `packages/core/src/commands/agentTools.ts`, `packages/core/src/commands/registry.ts`
- `apps/filmcraft-web/src/recovery_policy.rs` (`Policy`, `Action`, `tick` / `written` / `cleaned`: snapshot at most once per interval and revision, retry failed writes, retire only this session's snapshot) → `packages/core/src/persistence/recoveryPolicy.ts`
- `apps/filmcraft-web/src/recovery.rs` (snapshot-then-dirty-meta writes, recovery check of a dirty meta) → `packages/core/src/persistence/autosave.ts`
- `apps/filmcraft-web/tests/recovery_policy.rs` (test cases re-expressed) → `packages/core/tests/persistence-policy.test.ts`

## gridcraft

© 2026 ArtCraft Team and the GridCraft contributors.

- `crates/core/src/parse.rs` (typed cell input parsing) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/date.rs` (1900 date-system serials, days in month, civil-day arithmetic) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/value.rs` (Excel comparison, 15-digit number comparison, sort order, number-to-text coercion) → `packages/core/src/spreadsheet/formula/values.ts`
- Test cases from the files above, re-expressed → `packages/core/tests/spreadsheet-typed-input.test.ts`
- `crates/numfmt/src/lib.rs`, `parse.rs`, `render.rs`, `decimal.rs`, `builtin.rs` (Excel number format parsing and rendering, 15-digit decimal rounding, General format, `TEXT()`, built-in formats 0–49, parse cache) and `crates/core/src/date.rs` (serial to date) → `packages/core/src/spreadsheet/numfmt/`
- `crates/numfmt/src/tests.rs` and `crates/numfmt/tests/poi_number_format_approx.rs` (test cases re-expressed) → `packages/core/tests/number-format.test.ts`, `packages/core/tests/fixtures/poi-number-format-approx.ts`
**Apache POI.** The rows of `packages/core/tests/fixtures/poi-number-format-approx.ts` (format, value and Excel's
`TEXT()` result) come from Apache POI's `test-data/spreadsheet/NumberFormatApproxTests.xlsx`, as collected in
GridCraft. Apache POI is © The Apache Software Foundation, licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0).

## lightcraft

© 2026 ArtCraft Team and the LightCraft contributors.

- `crates/color/src/cct.rs` (Kim et al. Planckian locus, temperature / tint ↔ xy, white-balance matrix) → `packages/core/src/image-editor/color.ts`
- `crates/color/src/lib.rs` (Bradford adaptation, RGB ↔ XYZ from primaries) → `packages/core/src/image-editor/color.ts`
- `crates/pipeline/src/tone.rs` (`ToneMap::display` S-curve anchored at 0, grey and 1) → `packages/core/src/image-editor/color.ts`
- `crates/pipeline/src/local.rs` (relative white balance with neutral-luminance normalisation) → `packages/core/src/image-editor/color.ts`
- `crates/develop/src/settings.rs` and `docs/process-versions.md` (process version semantics) → `packages/core/src/image-editor/color.ts`
- `crates/develop/src/controls.rs` (`ControlSpec` table: id, label, section, range, default, step, decimals, track style; clamping) → `packages/core/src/image-editor/controls.ts`

## pdfcraft

© 2026 ArtCraft Team and the PDFCraft contributors.

- `crates/compare/src/lib.rs` (`diff` with common prefix/suffix stripping, `myers` keeping only the −d..d frontier, patience `anchors` with longest increasing subsequence, recursion depth limit, grouping into inserted/deleted/replaced) → `packages/core/src/compare/diff.ts`
- Test cases from the file above (`long_documents_with_scattered_edits`, `very_different_documents_finish`, `insertions_deletions_and_replacements`), re-expressed → `packages/core/tests/compare-diff.test.ts`

## photocraft

© 2026 ArtCraft Team and the PhotoCraft contributors.

- `crates/ops/src/lib.rs` (`History { max_states, max_bytes }`, `trim`, `unique_bytes`) → `packages/core/src/history/HistoryManager.ts`
- `crates/ui-egui/src/palette.rs` (`fuzzy_score`, `exact_bonus`, `push_recent`) → `packages/core/src/commands/palette.ts`
- `crates/doc/src/adjust.rs` (`Adjustment` model, `HueRange::neutral` / `weight`, `LevelsChannel` defaults) → `packages/core/src/image-editor/types.ts`, `packages/core/src/image-editor/adjustment-layers.ts`
- `crates/compose/src/adjust.rs` (`curve_lut`, `levels_q`, `tone_luts_q`, `hue_saturation`, `range_lightness`, `hue_range_tables`, `rgb_to_hsl` / `hsl_to_rgb`, `vibrance_px` / `vibrance_lin`, `color_balance_channel`, `black_white_gray`, `photo_filter_matrix`, `posterize`, Threshold) → `packages/core/src/image-editor/adjustment-layers.ts`
- `crates/color/src/blend.rs` (separable and non-separable blend modes, hardened `clip_color`, `set_lum`, `composite`) → `packages/core/src/image-editor/blend.ts`
- `crates/color/src/convert.rs` (`D50`, `SRGB_TO_XYZ_D50`, `XYZ_D50_TO_SRGB`) → `packages/core/src/image-editor/adjustment-layers.ts`
- `crates/algo/src/histogram.rs` (bounded RGB histogram, transparent exclusion, exact-endpoint clipping) → `packages/core/src/image-editor/histogram.ts`
- Test cases from `crates/compose/src/adjust.rs`, `crates/compose/src/tests.rs`, `crates/doc/src/adjust.rs`, `crates/color/src/blend.rs` and `crates/algo/src/histogram.rs`, re-expressed → `packages/core/tests/image-editor-adjustment-layers.test.ts`, `packages/core/tests/image-editor-blend-histogram.test.ts`

## soundcraft

© 2026 ArtCraft Team and the SoundCraft contributors.

- `crates/engine/src/lib.rs` (`Engine::execute_merged`, `hold_merge`, `end_merge`) → `packages/core/src/history/HistoryManager.ts`
- `crates/engine/src/lib.rs` (`Engine::is_dirty`, `same_document`, `mark_clean`) → `packages/core/src/dirty.ts`

## vectorcraft

© 2026 ArtCraft Team and the VectorCraft contributors.

- `crates/tools/src/guides.rs` (`snap_scale`) → `packages/core/src/canvas/resizeSnap.ts`
- `crates/geom/src/snap.rs` (`snap_to_grid`) → `snapToGrid` in `packages/core/src/canvas/guides.ts`
- `crates/pathops/src/fit.rs` (`fit_cubics`, `fit_single`, `fit_single_from`, `generate`, `newton`, `chord_params`, `is_straight`) → `packages/core/src/canvas/curveFit.ts`
- `crates/pathops/src/edit.rs` (`simplify_with` corner splitting) → `packages/core/src/canvas/curveFit.ts`
- Test cases from the files above and `crates/pathops/tests/ops.rs`, re-expressed → `packages/core/tests/canvas-resize-snap.test.ts`, `packages/core/tests/canvas-curve-fit.test.ts`
---

## wordcraft

© 2026 ArtCraft Team and the WordCraft contributors.

- `crates/engine/src/cmd/mailings.rs` (`parse_csv` delimiter auto-detection and blank-row skipping, `table_from_rows`, `header_split` padding / truncation and record caps, `address_map` field aliases) → `packages/core/src/grammar/data-source.ts`
- `crates/formats/src/sheet.rs` (`field_names`: blank headers as `Column N`, repeated headers numbered) → `packages/core/src/grammar/data-source.ts`
- `crates/engine/src/cmd/mailings.rs` (`condition` numeric-or-text comparison with `= <> < > <= >=`, `finish` one copy per record with SKIPIF and a merge cap) → `packages/core/src/grammar/variables.ts`, `packages/core/src/grammar/merge.ts`
- Test cases from `crates/engine/src/cmd/mailings.rs` (`csv_parsing`, `merge_end_to_end`, `recipients_from_fields_and_array_rows`, `skipif_drops_matching_records`, `if_rule_previews_its_result`), re-expressed → `packages/core/tests/mail-merge.test.ts`
- `crates/engine/src/cmd/tools.rs` (`compare`: block-level diff of case-folded / white-space-collapsed paragraph keys, pairing the i-th deleted with the i-th inserted paragraph for word or character diffs, whole insertions/deletions otherwise, `MAX_CHAR_DIFF` fallback, options not honoured; `tokens`, `word_diff`) → `packages/core/src/compare/documents.ts`
- `crates/engine/src/cmd/fmt_revisions.rs` (`compare_formatting`: equal text compared for formatting changes) → `packages/core/src/compare/documents.ts`
- Test cases from `crates/engine/src/cmd/tools.rs` (`compare_marks_changes`, `compare_options_ignore_case_and_white_space`), re-expressed → `packages/core/tests/compare-documents.test.ts`

---
- `crates/engine/src/cmd/find_pattern.rs` (`compile`, `special`, `wildcards`, `count`, `class`, `find_code` / `replace_code` / `numeric_code`, `parse_replace`, `expand`) → `packages/core/src/extensions/find-replace/pattern.ts`
- `crates/engine/src/cmd/edit.rs` (`search_full`: live-text haystack with a position map and cuts at tracked deletions, joining paragraphs only for `^p`, stepping past empty matches, match cap; `replace_all`: last-to-first, tracked path, paragraph splits) → `packages/core/src/extensions/find-replace/search.ts`, `packages/core/src/extensions/find-replace/extension.ts`
- `crates/engine/src/tests.rs` (`find_replace`, `find_replace_special_codes`, `find_replace_wildcards`, `hostile_find_patterns_are_bounded`, `replace_under_track_changes_skips_deleted_text`, `find_reads_the_text_around_tracked_deletions`, `replace_all_is_tracked`, `replace_all_splits_paragraphs_at_a_paragraph_mark_in_the_replacement`; re-expressed) → `packages/core/tests/find-replace.test.ts`

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
