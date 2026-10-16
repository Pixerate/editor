# Third-Party Notices

Portions of this repository are ported from third-party source code. Each ported file carries a
header comment naming its source. The ported algorithms were re-expressed in TypeScript; test cases
were re-expressed as vitest cases rather than copied.

All sources below are from the ArtCraft "craft" apps, each licensed **MIT OR Apache-2.0**,
© 2026 ArtCraft Team and the respective app's contributors. They are used here under the MIT licence
reproduced at the end of this file. Paths are relative to each source repository.

## cadcraft

© 2026 ArtCraft Team and the CadCraft contributors.

- `crates/geom/src/region.rs` (`enclosing_loop`, `boundary_at_gap` and `build_gap`: curves split at their crossings, gaps between loose ends bridged to the nearest other loose end within reach, a ray from the point meeting edges in order and the face to the left of each traced by always taking the sharpest left turn until a counter-clockwise loop round the point comes back; islands — pieces nested in that face — as holes; `interior_point`) → `PlanarMap.regionAt` and `closeGaps` in `packages/core/src/canvas/pathops/planar.ts` and `fillRegion` in `packages/core/src/vector/controller.ts`; islands are taken per face (the smallest face of another piece around each outer boundary) rather than every group inside the loop, so islands inside islands are not holes; test cases re-expressed → `packages/core/tests/canvas-pathfinder.test.ts`
- `crates/engine/src/snap/curves.rs` (`Param::solve` with the `perpendicular` and `tangent` conditions: sign changes of sampled conditions narrowed by bisection, near-zero check, degenerate "every point qualifies" case) → `solveOnSegment` and `VectorSnapTargets` perpendicular / tangent snaps in `packages/core/src/vector/snap.ts`

## craft-libs

© 2026 ArtCraft Team and the craft-libs contributors.

- `crates/settings/src/migrate.rs` (`upgrade`: step-wise migration to a target version, missing version taken as current, newer version left alone) → `migrateDocument` in `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/document.rs` (`deserialize_sections`: per-section fallback to defaults) → `loadSections` in `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/error.rs` (`LoadReport`, `has_problems`, `SectionError`, read-only reasons) → `packages/core/src/persistence/migrate.ts`
- `crates/settings/src/store.rs` (debounced save, `retry_delay` exponential backoff with cap) → `packages/core/src/persistence/autosave.ts`, `exponentialBackoff` in `packages/core/src/persistence/recoveryPolicy.ts`
- Test cases from `crates/settings/tests/migrate.rs`, `tests/recovery.rs` and `tests/store.rs`, re-expressed → `packages/core/tests/persistence-migrate.test.ts`, `packages/core/tests/persistence-policy.test.ts`

## designcraft

© 2026 ArtCraft Team and the DesignCraft contributors.

- `crates/tools/src/snap.rs` (`pass_dimensions`: a resized or created object's side matches another object's width or height in its own frame, nearest within the zone, when nothing else snapped on that axis) → `VectorSnapTargets.snapScale` / `matchSize` in `packages/core/src/vector/snap.ts`

## effectcraft

© 2026 ArtCraft Team and the EffectCraft contributors.

- `crates/path/src/varstroke.rs` (`outline`: a variable-width stroke as the union of positively wound trapezoids per flattened segment, round wedges at bends and the caps, filled non-zero; `flatten` with a width-sampling step; `dash_intervals`; `width_factor` with the `Taper` lengths, widths and quarter-circle `ease` and the `Wave` amount, cycles and phase) → `variableStrokeRings` / `variableStrokeOutline` / `dashIntervals` in `packages/core/src/vector/varstroke.ts` and `taperWaveFactor` / `generateWidthProfile` in `packages/core/src/vector/width.ts`; the pieces are emitted as the boundary they add up to (offset sides, outer joins, inner sides trimmed at the offsets' crossing or routed through the centre) instead of being unioned one by one, and the result is refitted with cubics; test cases re-expressed → `packages/core/tests/vector-width.test.ts`

## figcraft

© 2026 ArtCraft Team and the FigCraft contributors.

- `crates/engine/src/distance.rs` (`between`, `inside`, `to_guide`, `label`) → `packages/core/src/canvas/measure.ts`
- `crates/engine/src/measure_tests.rs` (test cases re-expressed) → `packages/core/tests/canvas-measure.test.ts`
- `crates/engine/src/snap.rs` (`spacings` / `equal_spacing` / `spacing_guides`: centred between neighbours, repeating the gap of the pair before or after, gap labels; threshold in screen pixels divided by the zoom) → `VectorSnapTargets.snapRect` in `packages/core/src/vector/snap.ts`; its equal-spacing cases re-expressed → `packages/core/tests/vector-snap.test.ts`
- `crates/layout/src/lib.rs` (`layout_frame`, `distribute`, `main_offsets`, `fit_hug_text`, `enforce_limits`, `item_baseline`, `resize_child`, `grid_place`, `resolve_tracks`, `track_content`, `grid_geometry`, `layout_grid`, `apply_constraints`, `layout_page`, `layout_up`, `coherent_sizing`, `clamp_size`) → `packages/core/src/canvas/autoLayout.ts`
- `crates/layout/src/{tests.rs,behaviour_tests.rs,nested_tests.rs,content_align_tests.rs}` (test cases re-expressed) → `packages/core/tests/canvas-auto-layout.test.ts`
- `crates/doc/src/styles.rs` (`Collection`, `Mode`, `Variable`, `VariableValue`, `Variables::resolve`, `default_mode`, `current_mode`, `find_mode`, `scopes_for`, `normalize_scopes`, `in_scope`) → `packages/core/src/tokens/types.ts`, `packages/core/src/tokens/model.ts`
- `crates/engine/src/cmd/variables.rs` (`alias_target` cycle check, `forget_variables` alias detaching, `remove_mode`, `move_mode`, `rename_collection`, `delete_collection`, `field_scope`) → `packages/core/src/tokens/model.ts`, `packages/core/src/canvas/tokenBindings.ts`
- `crates/doc/src/lib.rs` (`modes_for`: modes inherited down the tree) → `getEffectiveTokenModes` in `packages/core/src/canvas/tokenBindings.ts`
- `crates/engine/src/variables_io_tests.rs` (behaviour of the variables JSON import / export: merging by name, junk and loop handling, CSS export per mode) → `packages/core/src/tokens/w3c.ts`, `packages/core/src/tokens/css.ts`
- `crates/engine/src/{variable_tests.rs,variables_behaviour_tests.rs,variables_io_tests.rs}` (test cases re-expressed) → `packages/core/tests/tokens.test.ts`, `packages/core/tests/canvas-tokens.test.ts`
- `crates/engine/src/components.rs` (instances rebuilt from their main keeping ids and overrides — `sync_instance`, `carry_overrides`, `path_map` matching, `variant_kept`, `diff_groups`, `sync_after_edit`, `rebuild_instances` ordering, `rebase_instance`, `unlink_layers`, `relink_copy`, component property chains, `default_variant`, `variant_props`, `variant_name`, `variant_options`, `find_variant`, `variant_conflicts`) → `packages/core/src/canvas/components.ts`
- `crates/engine/src/cmd/component.rs` (create component, combine as variants, create / detach / swap instance, reset instance and overrides, push changes, restore main, set instance properties, add / edit / delete / bind component properties) → `packages/core/src/canvas/components.ts`, `packages/core/src/canvas/componentsController.ts`
- `crates/engine/src/{components_tests.rs,components_behaviour_tests.rs,components_scale_tests.rs}` (test cases re-expressed) → `packages/core/tests/canvas-components.test.ts`, `packages/core/tests/canvas-components-controller.test.ts`
- `crates/engine/src/vectoredit/ops.rs` (`bend`: handles at the chord's thirds plus one shared offset so the segment passes through the pointer at `t`, `t` clamped to 0.05–0.95) → `bendSegment` in `packages/core/src/vector/pathEdit.ts`; its `delete_vertices` / `heal_handles` (a healed curve through the deleted point) were compared and not ported, as the least-error refit followed the old segments more closely
- `crates/doc/src/vector.rs` (`VectorNetwork::rounded` / `corner`, `trim`, `start_dir`: each side of a rounded point trimmed by arc length with the radius clamped so a cut takes at most half of each side, the round cut a cubic with handles `4/3 · tan(φ/4) · ρ` along the sides' directions at the cut, a curved side keeping the rest of its curve) → `packages/core/src/vector/corners.ts`
- `crates/pathops/src/lib.rs` (`stroke_outline_of`: an inside stroke as twice the width intersected with the fill, an outside one as twice the width minus the fill, open shapes always centred) → `packages/core/src/vector/stroke.ts`
- `crates/doc/src/props.rs` (`WidthProfile` / `WidthPoint`: `sanitized`, side scales, `interp` with Fritsch–Carlson `tangent` and `secant` — monotone cubic, flat before the first and after the last point — `insert_here`, `set_point` kept between neighbours, `max_scale`) → `packages/core/src/vector/width.ts`
- `crates/doc/src/vector_faces.rs` (`faces` / `cycles`: a half-edge walk of the planar graph turning at each vertex to the next half-edge in angular order, bounded faces positive, the outside of each connected piece negative and nested inside the smallest face around it as a hole; `components`; `interior_point`) → `PlanarMap` in `packages/core/src/canvas/pathops/planar.ts`; its linear scans per step were replaced by per-vertex sorted lists and half-edge slots, and its even-odd test over the whole network by per-face nesting
- `crates/engine/src/shapebuilder.rs` (merging regions styled like the top-most shape over the first one, every covering shape losing the area, removal, a stroke-only shape taking part as its stroke's outlined area filled with the stroke paint, one command per gesture) → `vectorPathfinderShape`, `vectorResultStyle` and `planShapeBuilder` in `packages/core/src/vector/builder.ts`
- `crates/pathops/src/width.rs` (`variable_outline`: one-sided widths offset along each side's normal, the outer side joined with the style's join and the inner side through the centre) → `packages/core/src/vector/varstroke.ts`

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
- `crates/project/src/keyframe.rs` (`Keyframe`, `Param::value_at` segment evaluation and hold, `set_at` inheriting the previous interpolation, `remove_keyframe_at` keeping the last value, `toggle_animation` keeping the value at a time, temporal influence easing, `cubic_bezier_y_for_x` Newton + bisection solver) → `packages/core/src/canvas/animation/{easing,model,evaluate,edit}.ts`
- `crates/engine/src/keyframe_move.rs` (`move_many`: one common delta across lanes clamped to the movement range, remove-all-originals-then-insert, validation without partial edits, at most 4096 keys) → `moveKeyframes` / `scaleKeyframes` in `packages/core/src/canvas/animation/edit.ts`, keyframe drags in `packages/core/src/canvas/animation/controller.ts`
- `crates/project/src/keyframe.rs` tests, `crates/engine/src/keyframe_move.rs` tests and `crates/ui-egui/tests/keyframes_ui.rs` (group move and undo as one step, snapping within a screen-space threshold, Escape cancelling a drag preview; test cases re-expressed) → `packages/core/tests/canvas-animation.test.ts`, `packages/react/tests/canvas-animation.test.tsx`, `packages/svelte/tests/canvas/canvas-animation.test.ts`

## gridcraft

© 2026 ArtCraft Team and the GridCraft contributors.

- `crates/core/src/parse.rs` (typed cell input parsing) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/date.rs` (1900 date-system serials, days in month, civil-day arithmetic) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/value.rs` (Excel comparison, 15-digit number comparison, sort order, number-to-text coercion) → `packages/core/src/spreadsheet/formula/values.ts`
- Test cases from the files above, re-expressed → `packages/core/tests/spreadsheet-typed-input.test.ts`
- `crates/numfmt/src/lib.rs`, `parse.rs`, `render.rs`, `decimal.rs`, `builtin.rs` (Excel number format parsing and rendering, 15-digit decimal rounding, General format, `TEXT()`, built-in formats 0–49, parse cache) and `crates/core/src/date.rs` (serial to date) → `packages/core/src/spreadsheet/numfmt/`
- `crates/numfmt/src/tests.rs` and `crates/numfmt/tests/poi_number_format_approx.rs` (test cases re-expressed) → `packages/core/tests/number-format.test.ts`, `packages/core/tests/fixtures/poi-number-format-approx.ts`
- `crates/calc/src/eval.rs` (LET/LAMBDA environments and closures, lambda calls and argument counts, ISOMITTED, MAP/REDUCE/SCAN/BYROW/BYCOL/MAKEARRAY, functions passed by name, defined-name evaluation, recursion depth limit) → `packages/core/src/spreadsheet/formula/evaluator.ts`, `packages/core/src/spreadsheet/formula/lambda.ts`, `packages/core/src/spreadsheet/formula/functions/lambda.ts`
- `crates/model/src/workbook.rs` (sheet name rules, defined-name lookup by scope) and `crates/engine/src/cmd/formulas.rs` (defined-name validation, R1C1 look-alikes, renaming names in formulas) → `packages/core/src/spreadsheet/workbook.ts`, `packages/core/src/spreadsheet/controller.ts`
- `crates/formula/src/adjust.rs` and `crates/formula/src/printer.rs` (rename/delete sheet rewriting, 3-D span shrinking, sheet-name quoting) and `crates/engine/src/cmd/sheet.rs` (add, rename, move, copy and delete sheets with their names) → `packages/core/src/spreadsheet/formula/references.ts`, `packages/core/src/spreadsheet/controller.ts`
- `crates/calc/src/tests.rs`, `crates/formula/src/tests.rs`, `crates/engine/src/tests.rs` and `crates/model/src/workbook.rs` tests (test cases re-expressed) → `packages/core/tests/spreadsheet-lambda.test.ts`, `packages/core/tests/spreadsheet-workbook.test.ts`
- `crates/model/src/features.rs` (conditional formatting and data validation rule model, icon-set thresholds) and `crates/engine/src/cf.rs` (rule evaluation: priority, stop if true, colour scales, data bars, icon sets, top/bottom, averages, duplicates, text and date rules, relative rule formulas) → `packages/core/src/spreadsheet/conditional-format/`
- `crates/engine/src/cmd/data.rs` (validation checks, list items, circle invalid data, removing rule cells) and `crates/engine/src/cmd/sheet.rs` (rule ranges following inserted / deleted rows and columns) → `packages/core/src/spreadsheet/validation/`, `packages/core/src/spreadsheet/rule-ranges.ts`
- Test cases from `crates/engine/src/cf.rs` and `crates/engine/src/tests.rs` (icon-set thresholds, relative validation formulas), re-expressed → `packages/core/tests/spreadsheet-conditional-format.test.ts`, `packages/core/tests/spreadsheet-data-validation.test.ts`
- `crates/calc/src/recalc.rs` (`Intervals`: row intervals sorted by start with an implicit max-end segment tree, pending insertions and dead entries merged lazily; ranges indexed per column with a per-sheet index for wide ranges; dependents of a cell in O(log n + k); dirty closure of an edit) → `packages/core/src/spreadsheet/formula/dependency-graph.ts`
- `crates/calc/src/tests.rs` and `crates/calc/src/recalc.rs` (interval-index and incremental-recalculation cases, re-expressed) → `packages/core/tests/spreadsheet-recalc.test.ts`
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
- `crates/export/src/lib.rs` (`body_size`: body text size by character count; `level`: heading levels relative to it, bold body-size headings; `tables`: grid columns from aligned cell edges, rows from overlapping spans, spanning header and totals rows next to a run, the 63-column cap) → `packages/core/src/import/pdf-layout.ts`
- `crates/edit/src/text_regions.rs` (`group_layout`: runs joined on a baseline across small gaps, rows grouped into blocks by pitch and alignment, line-end hyphens removed when joining rows) → `packages/core/src/import/pdf-layout.ts`
- Test cases from `crates/export/src/lib.rs` (`grid_text_becomes_a_real_table_in_every_format`, `a_staircase_of_blocks_is_not_a_huge_table`, `two_column_body_text_is_not_mistaken_for_a_table`, `word_does_not_invent_borders_for_aligned_invoice_fields`), re-expressed → `packages/core/tests/pdf-layout.test.ts`

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
- `crates/algo/src/selection.rs` (`SelectionMode` / `combine`, `magic_wand` / `wand_region` span fill and anti-aliasing, `color_range_samples`, `tone_range`, `hue_range`, `expand` / `contract` / `border`, anti-aliased `polygon`) → `packages/core/src/image-editor/selection/mask.ts`, `shapes.ts`, `wand.ts`, `modify.ts`
- `crates/algo/src/selection/distance.rs` (Felzenszwalb–Huttenlocher `edt`) and `crates/algo/src/selection_blur.rs` (Smooth: box + threshold; Feather: Gaussian with σ = radius) → `packages/core/src/image-editor/selection/modify.ts`
- `crates/algo/src/matting.rs` (`RefineParams`, `box_mean`, `guided_filter_color`, `edge_width`, `refine_buffer` band / smooth / feather / contrast / `shift_mask`) → `packages/core/src/image-editor/selection/refine.ts`, `modify.ts`
- `crates/paint/src/dynamics.rs` (`Smoother` pulled-string mode with `MAX_STRING_PX`, `string`, `finish` with catch-up on stroke end) → `LazyMouse` in `packages/core/src/vector/ink.ts`
- `crates/engine/src/layer_mask_props_cmds.rs` and `crates/compose/src/masks.rs` (non-destructive mask density and feather) → `packages/core/src/image-editor/selection/layer-mask.ts`
- Test cases from `crates/algo/src/selection.rs`, `crates/algo/src/selection_blur.rs`, `crates/algo/src/matting.rs` and `crates/algo/src/tests_selection_mix.rs`, re-expressed → `packages/core/tests/image-editor-selection.test.ts`, `packages/core/tests/image-editor-selection-controller.test.ts`

## soundcraft

© 2026 ArtCraft Team and the SoundCraft contributors.

- `crates/engine/src/lib.rs` (`Engine::execute_merged`, `hold_merge`, `end_merge`) → `packages/core/src/history/HistoryManager.ts`
- `crates/engine/src/lib.rs` (`Engine::is_dirty`, `same_document`, `mark_clean`) → `packages/core/src/dirty.ts`

## vectorcraft

© 2026 ArtCraft Team and the VectorCraft contributors.

- `crates/tools/src/guides.rs` (`snap_scale`) → `packages/core/src/canvas/resizeSnap.ts`
- `crates/tools/src/guides.rs` (`Targets` gathered once per gesture and kept x / y sorted with `within` bisection lookups; `for_move`, `for_drawing`, `for_handle`, `for_anchor_drag` leaving the moving anchors and their segments out, `push_segments`; the `snap_from` priority — Shift-constrained ray, point, intersection, on-segment, construction angle, x / y alignment — with `slide`, `lined_up`, `on_segment`, `crossing`; `align_rects`, `snap_rects`, `even_spacing`, `gap_marks`; `snap_scale` for rotated boxes; `Leave`, `construction`; the "anchor" / "centre" / "path" / "intersect" / "align" labels) → `packages/core/src/vector/snap.ts`; the curve–curve `meeting` search was not ported (`segmentIntersections` in `packages/core/src/canvas/pathops/boolean.ts` finds every crossing instead)
- Test cases from `crates/tools/src/guides.rs`, re-expressed → `packages/core/tests/vector-snap.test.ts`
- `crates/geom/src/snap.rs` (`snap_to_grid`) → `snapToGrid` in `packages/core/src/canvas/guides.ts`
- `crates/pathops/src/fit.rs` (`fit_cubics`, `fit_single`, `fit_single_from`, `generate`, `newton`, `chord_params`, `is_straight`) → `packages/core/src/canvas/curveFit.ts`
- `crates/pathops/src/edit.rs` (`simplify_with` corner splitting) → `packages/core/src/canvas/curveFit.ts`
- Test cases from the files above and `crates/pathops/tests/ops.rs`, re-expressed → `packages/core/tests/canvas-resize-snap.test.ts`, `packages/core/tests/canvas-curve-fit.test.ts`
- `crates/pathops/src/boolean.rs` (`BoolOp::apply`, fill-rule `inside`, `Tidy::keeping` / `exact_merge`: rebuilding split pieces as exact sub-curves of the input curves, `is_sliver` mean-width sliver test) → `packages/core/src/canvas/pathops/boolean.ts`
- `crates/pathops/src/offset.rs` (`offset_path`: fill ∪ / − a `2·|d|` stroke ring, open subpaths outlined with butt caps, spurious-contour removal by `deep_point` distance; `stroke_region`) → `packages/core/src/canvas/pathops/stroke.ts`
- `crates/effects/src/stroke/dash.rs` (exact dash plans: odd patterns doubled, offset into the pattern, restart per subpath, joining across the start of a closed subpath, zero-length dots, invalid / too-fine patterns drawn solid) → `packages/core/src/canvas/pathops/stroke.ts`
- `crates/pathops/src/boolean.rs` (`try_merge` refit of tangent-continuous runs) → `mergeSmoothRuns` in `packages/core/src/canvas/pathops/stroke.ts`
- Test cases from `crates/pathops/tests/ops.rs`, `tests/props.rs`, `tests/prop_pathops.rs`, `crates/pathops/src/offset.rs` and `crates/engine/src/tests_outlinestroke.rs`, re-expressed → `packages/core/tests/canvas-pathops.test.ts`
- `crates/pathops/src/edit.rs` (`remove_anchor` with `golden_min`: neighbours keep their handle directions and one cubic is fitted across the two segments with a golden-section search for where it passes the removed point; `smooth`; `remove_redundant_points` with `merge_pair`; `average`; `join` nearest endpoints first) → `packages/core/src/vector/pathEdit.ts`, `fitCubicWithTangents` in `packages/core/src/canvas/curveFit.ts`
- `crates/geom/src/path.rs` (`SubPath::cut_at`) → `cutSubpathAt` in `packages/core/src/vector/pathEdit.ts`; its `bend_segment` was not used
- `crates/tools/src/draw2/curvature.rs` (`curvature_move`) → `curvatureMoveAnchor` in `packages/core/src/vector/pathEdit.ts`
- `crates/engine/src/cmd/draw2.rs` (`knife`, `erase_region`, `erase_outline`, `cut_subpath`: which paths a stroke reaches, fills losing the stroke's area by a boolean difference, outlines cut into runs that keep the original curves and join across a closed path's start, one object per piece) → `packages/core/src/vector/pathCut.ts`; the fixed 0.05 pt knife slit and the 24-sample crossing search were replaced by gap-free chord splitting with exact crossings
- `crates/geom/src/corners.rs` (`path_corners`, `Corner` — `setback`, `max_radius`, `fitted`, `on_bisector`, `radius_change` — `arc_handle`, `square_to`, and `cut_corners` with the round, inverted round and chamfer kinds, curved sides trimmed between cuts and a closed subpath whose first corner is cut starting where that cut ends) → `packages/core/src/vector/corners.ts`; its curved-side `round_handles` were replaced by figcraft's chord-based arc handles
- `crates/tools/src/corners.rs` (the corner widgets: shown at the selected corners, on the bisector at the arc's centre at least 10 px in, hidden on sides under 30 px; a drag sets every shown corner's radius from the pointer's travel along the bisector up to fully round; Alt-click cycles the kind; a click picks that corner) → `getVectorCornerWidgets` and the `corner` drag in `packages/core/src/vector/controller.ts`
- `crates/effects/src/stroke/arrow.rs` (`pieces`, `end_of`, `cut_point`, `trim`, `inset`, `shape`, the `ring` / `arm` / `bar` sizes and `NOTCH`: arrowheads on the open ends of the first and last subpaths, `Tip` vs `Extend` alignment, the stroke ending under the head) and `crates/doc/src/appearance.rs` (`arrow_weight`) → `packages/core/src/vector/stroke.ts`; only the triangle, arrow, open arrow, circle, square and bar heads were ported
- `crates/svg/src/lib.rs` (stroke alignment written as a double-width stroke clipped to the shape for inside and masked by it for outside) → `packages/core/src/vector/svg.ts`
- Test cases from `crates/geom/src/corners.rs`, `crates/tools/src/corners.rs` and `crates/effects/src/stroke/arrow.rs`, re-expressed → `packages/core/tests/vector-corners-strokes.test.ts`
- `crates/doc/src/appearance.rs` (`WidthProfile` as `(t, left, right)` points, two points at one `t` making a step, `PRESETS` with Taper Start / End, Lens, Pinch, Teardrop and Wave, `preset_id` / `id_of`, and `PressureProfile` simplification) → `packages/core/src/vector/width.ts`; its linear interpolation was replaced by figcraft's monotone cubic
- `crates/pathops/src/pathfinder.rs` (`pathfinder` with `PathfinderOp::{Divide, Trim, Merge, Crop, Outline, MinusBack}` as coverage tests per result — the top-most covering shape, the shapes under the front one, the front shape alone — `Shape` with a paint key, Merge per key in connected groups, Divide with open paths through the planar map; `outline_edges`: outlines cut at the arrangement's junctions, coincident pieces once with the front-most key; `regions` / `merge_regions`) → `packages/core/src/canvas/pathops/pathfinder.ts` and `pathBooleanSelect` / `planarSplit` in `packages/core/src/canvas/pathops/boolean.ts`; the regions come from the existing `dividePaths` arrangement rather than a new sweep, and its mask batching was not needed
- `crates/pathops/src/planar.rs` (`map`: input paths split into a planar graph, coincident pieces one edge keyed by the front-most input, half-edges sorted by `leaving_angle` — where each first gets half the shortest edge away from the vertex — and `without_spurs`; `Map::merge`: merged faces traced along the map's own edges so shared edges drop out exactly; `build`: faces with the fills covering an interior point, and edges chained through vertices where nothing else meets; `shape_builder`, `encloses_area`; `interior_point`) → `PlanarMap` / `interiorPoint` in `packages/core/src/canvas/pathops/planar.ts`, `subpathEnclosesArea` / `vectorShapeBuilderMap` in `packages/core/src/vector/builder.ts`; the sweep and its shear were replaced by `planarSplit` (the boolean engine's intersection search), and `cut_out` (erasing closed outlines' edges) was not ported
- `crates/tools/src/builder.rs` (the Shape Builder tool: `BuilderMap` with regions and line pieces, `hit` preferring a line piece within tolerance when erasing, `sides`, `line_between`, `Touched`, `sample_polyline`, `shape_builder_shapes` closing filled open subpaths that enclose an area, hover and drag highlights, Alt to erase) and `crates/engine/src/cmd/buildcmds.rs` (`sb_merge`: line pieces deleted or lying between merged faces go, covering shapes keep their faces not merged, the merged shape styled like the top-most shape over the first region or the current fill for a gap) → `packages/core/src/vector/builder.ts` and the `shapeBuilder` tool in `packages/core/src/vector/controller.ts`; Live Paint groups, the hatch overlay and erasing outline edges were not ported
- Test cases from `crates/pathops/src/{pathfinder.rs,planar.rs}` and `crates/engine/src/tests_build.rs`, re-expressed → `packages/core/tests/canvas-pathfinder.test.ts`, `packages/core/tests/vector-pathfinder.test.ts`
- `crates/tools/src/distort/width.rs` (the Width tool: the stroke under the pointer and its width there, dragging outward to add or widen a width point — symmetric, Alt one side — dragging a point's centre to slide it along the path, its handle ends to widen it, width-point diamonds and side handles in the overlay, Delete removing the selected point) → `getVectorWidthHandles`, the `width` hover and drag in `packages/core/src/vector/controller.ts` and the overlay's `widthPoints` / `widthSpot` in `packages/core/src/vector/render.ts`; and its later additions: Alt-dragging a centre to slide a copy (`stroke.widthPoint.copy`), dropping a slid point onto another to make a discontinuous point, Shift-click multi-selection with selected points moved or widened together and kept selected after a move (`group` / `toggle` / `selected_indices`), Delete removing every selected point, and double-click opening Width Point Edit on a point or a stroke spot (the `widthPoint` dialog) → `selectedWidthPoints`, `selectWidthPoints`, `removeWidthPoints`, `setWidthPoint`, `openWidthPointEdit` / `commitWidthPointEdit` / `widthPointEdit` and the `copy` drag in `packages/core/src/vector/controller.ts`, and `VectorWidthPointEditor` in `packages/react/src/vector/VectorWidthPointEditor.tsx` and `packages/svelte/src/vector/VectorWidthPointEditor.svelte`; test cases re-expressed → `packages/core/tests/vector-width.test.ts`
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
- `crates/engine/src/cmd/moves.rs` (`move_sized`; `cut_tracked` / `take_paste`: a tracked cut gets its own revision and the paste right after it, by the same author and of the same text, links both ends with a move name; `resolve`: accepting a move removes its source and keeps its destination, rejecting restores the source and removes the destination, a moved paragraph's emptied block goes with it) and `crates/engine/src/cmd/review.rs` (moves listed as one change, accepting or rejecting either end resolves both) → `packages/core/src/extensions/track-changes.ts`
- Test cases from `crates/engine/src/cmd/moves.rs` (`a_tracked_cut_and_paste_of_a_paragraph_is_a_move`, `accepting_one_end_of_a_move_accepts_both`, `rejecting_a_move_puts_the_text_back`), re-expressed → `packages/core/tests/track-changes-moves.test.ts`
- `crates/doc/src/styles.rs` (`Style` with `based_on` / `next` / `linked`, the built-in style set's shape, `gallery`, `chain` (bounded, cycle-safe), `find`, `upsert`, `remove` (rebasing dependants, dropping `next` / `linked` references), `new_id`) and `crates/doc/src/resolve.rs` (cascade: document defaults → paragraph style chain → character style chain → direct formatting) → `packages/core/src/extensions/paragraph-styles/registry.ts`
- Test cases from `crates/doc/src/styles.rs` (`builtins_present`, `chain_is_cycle_safe`, `new_ids_unique`) and `crates/doc/src/resolve.rs` (`heading_resolves`, `char_style_then_direct`), re-expressed → `packages/core/tests/paragraph-styles.test.ts`
- `crates/docx/src/write/mod.rs` (package assembly: `[Content_Types].xml` defaults and overrides, part relationships with reused ids, `comments.xml` + `commentsExtended.xml` with `w15:paraIdParent` / `w15:done`, `annotation_author` and anonymous initials for removed personal information, `core_xml` without creator / last modified by, `styles_xml` / `style_xml` with `basedOn` / `next` / `link` / `uiPriority` / `qFormat`, lower-case built-in style names, `numbering_xml`), `crates/docx/src/write/story.rs` (`rev_open` / `rev_close`, `rev_tag` moves as `w:moveFrom` / `w:moveTo`, `move_ranges` with named move ranges, `w:delText` only for deletions that are not moves, `rpr_change` / `w:pPrChange` last in their properties, comment range start / end / reference runs, `w:p` with `w14:paraId` for comments, tables with `w:tblGrid`, `w:gridSpan`, `w:vMerge`, inline `wp:inline` pictures), `crates/docx/src/write/props.rs` (run property order), `crates/docx/src/package.rs` (relationship types), `crates/docx/src/xml.rs` (`esc`, XML 1.0 character filter, writer) and `crates/docx/src/units.rs` (twips / EMU conversion) → `packages/core/src/export/docx.ts`, `packages/core/src/export/xml.ts`, `packages/core/src/export/units.ts`
- `crates/docx/src/read/mod.rs` (`read_comments`: comments keyed by the `w14:paraId` of their last paragraph, `commentEx` parents and `done`) and `crates/docx/src/read/story.rs` (tracked insertions, deletions and named move ranges) → `packages/core/src/import/docx.ts`
- Test cases from `crates/docx/tests/privacy.rs` (`remove_personal_information_and_dates_on_save`: the two-commenter fixture, no names or initials in any part, "Author" / "A"), `crates/docx/tests/roundtrip.rs` and `crates/docx/tests/fixtures.rs` (comments, replies, tracked changes and moves surviving a save and reload), re-expressed → `packages/core/tests/docx-export.test.ts`
- `crates/engine/src/cmd/ink_shape.rs` (`recognise`, `ellipse_rms`, `snap_square`, `corners`, `turning`, `rdp`, `upright`, `MIN_SIZE`, `MAX_CORNERS`) → `recognizeInkShape` in `packages/core/src/vector/ink.ts`; its test cases re-expressed → `packages/core/tests/vector-path-edit.test.ts`

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
