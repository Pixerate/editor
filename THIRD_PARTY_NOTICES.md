# Third-Party Notices

Portions of this repository are ported from third-party source code. Each ported file carries a
header comment naming its source. The ported algorithms were re-expressed in TypeScript; test cases
were re-expressed as vitest cases rather than copied.

All sources below are from the ArtCraft "craft" apps, each licensed **MIT OR Apache-2.0**,
© 2026 ArtCraft Team and the respective app's contributors. They are used here under the MIT licence
reproduced at the end of this file. Paths are relative to each source repository.

## figcraft

© 2026 ArtCraft Team and the FigCraft contributors.

- `crates/engine/src/distance.rs` (`between`, `inside`, `to_guide`, `label`) → `packages/core/src/canvas/measure.ts`
- `crates/engine/src/measure_tests.rs` (test cases re-expressed) → `packages/core/tests/canvas-measure.test.ts`

## filmcraft

© 2026 ArtCraft Team and the FilmCraft contributors.

- `crates/engine/src/lib.rs` (`Session::edit_merged`, `undo_mark`, `revert_to`) → `packages/core/src/history/HistoryManager.ts`
- `crates/engine/src/commands.rs` (command specs, lookup by id, enablement with reasons) → `packages/core/src/commands/registry.ts`
- `crates/engine/src/lib.rs` (`Session::execute`, `enabled_for`: re-checking enablement against targets named in params, catching command failures) → `packages/core/src/commands/registry.ts`
- `crates/engine/src/shortcuts.rs` and `crates/engine/src/shortcuts_tests.rs` (platform-neutral chords, `Mod` resolution per platform, scoped bindings, conflict detection, per-platform conflict test) → `packages/core/src/commands/chords.ts`, `packages/core/src/commands/shortcuts.ts`, `packages/core/tests/commands.test.ts`
- `crates/automation/src/server.rs` (`command_list` / `command_run` / `command_batch` tools, complete MCP annotations, unknown-argument errors naming the accepted keys) → `packages/core/src/commands/agentTools.ts`, `packages/core/src/commands/registry.ts`

## gridcraft

© 2026 ArtCraft Team and the GridCraft contributors.

- `crates/core/src/parse.rs` (typed cell input parsing) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/date.rs` (1900 date-system serials, days in month, civil-day arithmetic) → `packages/core/src/spreadsheet/formula/parse-input.ts`
- `crates/core/src/value.rs` (Excel comparison, 15-digit number comparison, sort order, number-to-text coercion) → `packages/core/src/spreadsheet/formula/values.ts`
- Test cases from the files above, re-expressed → `packages/core/tests/spreadsheet-typed-input.test.ts`

## lightcraft

© 2026 ArtCraft Team and the LightCraft contributors.

- `crates/color/src/cct.rs` (Kim et al. Planckian locus, temperature / tint ↔ xy, white-balance matrix) → `packages/core/src/image-editor/color.ts`
- `crates/color/src/lib.rs` (Bradford adaptation, RGB ↔ XYZ from primaries) → `packages/core/src/image-editor/color.ts`
- `crates/pipeline/src/tone.rs` (`ToneMap::display` S-curve anchored at 0, grey and 1) → `packages/core/src/image-editor/color.ts`
- `crates/pipeline/src/local.rs` (relative white balance with neutral-luminance normalisation) → `packages/core/src/image-editor/color.ts`
- `crates/develop/src/settings.rs` and `docs/process-versions.md` (process version semantics) → `packages/core/src/image-editor/color.ts`

## photocraft

© 2026 ArtCraft Team and the PhotoCraft contributors.

- `crates/ops/src/lib.rs` (`History { max_states, max_bytes }`, `trim`, `unique_bytes`) → `packages/core/src/history/HistoryManager.ts`
- `crates/ui-egui/src/palette.rs` (`fuzzy_score`, `exact_bonus`, `push_recent`) → `packages/core/src/commands/palette.ts`

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
