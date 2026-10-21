# Build memory and package size

**Status:** done (October 2026). The plan below is kept as it was written; [Results](#results) says what was done and measured. See GOTCHAS.md, "[monorepo/build] Declarations Come From `tsc`".

## Why

- **Build memory.** `@pixerate/editor`'s build ran out of memory on CI on 2026-10-20 (`ERR_WORKER_OUT_OF_MEMORY` in tsup's type-declaration worker). CI, Release and Deploy demo all failed on `main`. #280 worked around it by setting `NODE_OPTIONS: --max-old-space-size=8192` in `ci.yml`, `release.yml` and `demo.yml`. The ubuntu-latest runners for public repos have 16 GB, so there's headroom, but the cause grows with the codebase.
- **Package size.** npm reports about 35 MB unpacked for `@pixerate/editor`. A local build on 2026-10-20 measured:
  - source maps: about 28.5 MB, roughly 80% of the published size
  - JavaScript: about 15.5 MB, ESM and CJS together
  - type declarations: about 5.7 MB, each written twice (`.d.ts` and `.d.cts`)
  - the largest entries' declarations: `vector` 312 KB, `canvas` 204 KB, `paint-editor` 164 KB, `video-editor` and `image-editor` 120 KB each

## Cause

tsup's `dts: true` builds declarations for every subpath entry (about 30) in a single worker. That worker loads the whole program and bundles a `.d.ts` per entry with rollup, so memory scales with codebase size and with type information duplicated across entries.

## Work, in order

1. **Measure first.**
   - Record peak build memory (for example `/usr/bin/time -v pnpm --filter @pixerate/editor build` on Linux, or `-l` on macOS) and the published size (`npm pack --dry-run` totals by file type).
   - Run `tsc -p packages/core --noEmit --extendedDiagnostics`, plus `--generateTrace` for hot spots.
2. **Emit declarations with tsc, and let tsup bundle only the JavaScript.**
   - Set `tsc --emitDeclarationOnly` (or `tsc -b` with project references) to write `dist/**/*.d.ts`.
   - Turn off tsup's `dts`.
   - Check that every `exports` entry's `types` path (`dist/<subpath>/index.d.ts`) still resolves, for ESM and CJS (`.d.cts` or `typesVersions` as needed).
   - Add a test that type-checks a small consumer against every subpath, for example with `tsd` or a fixture project compiled with `--moduleResolution bundler` and `node16`.
3. **Fix type hot spots** found in step 1: huge `as const` schema objects (agent tool `inputSchema`s), deep mapped and union types (for example the adjustment-layer and param maps), and heavy generic inference. Use explicit annotations where they cut checker work.
4. **Trim the published package.**
   - Leave source maps out of `files`, or publish them without `sourcesContent`.
   - Decide separately whether to keep CJS. Dropping it would be a breaking change and needs a major version, so record the decision and don't bundle it into this work.
5. **Lower the heap limit back down** once peak memory has dropped, keeping a margin, or remove `NODE_OPTIONS` if it isn't needed any more.
6. **Optional, longer term:** TypeScript's `isolatedDeclarations` would let a fast emitter (oxc / swc) write declarations with almost no memory. It requires explicit return types on every export, a large refactor, so only do it if steps 2–3 aren't enough.

## Done when

- Peak build memory is measured before and after, and is comfortably under the default Node heap, or under a documented, smaller limit.
- Every subpath's types resolve for consumers, with a test.
- The published package size is measured before and after, with source maps trimmed.
- The change is recorded in GOTCHAS.md, with a changeset if the published files change.

## Results

Measured on 2026-10-21 on an Apple-silicon Mac, Node 25, with `/usr/bin/time -l` (maximum resident set size of the largest process) and `npm pack --dry-run --json`. CI now writes its own peak to the job summary.

| | Before | After |
|---|---:|---:|
| `@pixerate/editor` build: time, peak memory | 72 s, 2.94 GB (with an 8 GB heap) | 9 s, 1.17 GB (default heap) |
| `@pixerate/editor-react` build | 10 s, 2.55 GB | 6 s, 0.58 GB |
| `pnpm build` (all packages and the demo) | needed `--max-old-space-size=8192` on CI | 25 s, 1.22 GB |
| `pnpm typecheck`, `pnpm --filter demo build` | | 1.20 GB, 1.16 GB |
| `@pixerate/editor` unpacked / tarball | 52.0 MB / 13.1 MB (source maps 29.8 MB, JS 16.1 MB, declarations 5.7 MB) | 22.3 MB / 5.9 MB (JS 16.1 MB, declarations 5.7 MB) |
| `@pixerate/editor-react` unpacked / tarball | 8.3 MB / 1.8 MB | 3.5 MB / 0.7 MB |
| `@pixerate/editor-svelte` unpacked / tarball | 1.7 MB / 0.4 MB | 1.5 MB / 0.4 MB |

What each step came to:

1. **Measure.** `tsc --noEmit --extendedDiagnostics` on core: 1,179 files, 209k instantiations, about 1 GB, 7 s. `--generateTrace` with `@typescript/analyze-trace` found no hot spots (the slowest expression, in `extensions/track-changes`, takes 72 ms). The memory went to tsup's DTS worker, which rolls up a declaration bundle per entry, not to the checker.
2. **Declarations from tsc.** Core and React run tsup for JavaScript only, then `tsc -p tsconfig.build.json` (one declaration per source file) and `scripts/finalize-declarations.mjs`, which adds the extensions `node16` needs and writes `.d.cts` twins. Each `exports` entry nests `types` under `import` and `require`, which also fixes `require` consumers on `node16`: before, they got TS1479 because `types` pointed at ESM declarations. `pnpm check:packages` (in CI and Release) checks every subpath of all three packages under `bundler`, `node16` ESM and `node16` CommonJS, and imports every core and React subpath with `import` and `require`.
3. **Type hot spots.** None to fix (see step 1). Optional step 6 (`isolatedDeclarations`) isn't needed.
4. **Trim.** No source maps are built or published. Maps without `sourcesContent` would still be 8.4 MB and point at `src/`, which isn't shipped; leaving them out of `files` only would leave `sourceMappingURL` comments to missing files. Svelte's declaration maps went too. CJS stays (see [outstanding.md](./outstanding.md), "Whether to drop CJS").
5. **Heap.** `NODE_OPTIONS: --max-old-space-size=8192` is gone from `ci.yml`, `release.yml` and `demo.yml`. The largest process now peaks at about 1.2 GB against Node's default heap of about 4 GB on a 16 GB runner.
