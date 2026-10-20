# Build memory and package size (plan for later)

**Status:** planned, not started. The feature tracks it waited for are finished, so it is next in line. Recorded 2026-10-20; still accurate on 2026-10-21 (`NODE_OPTIONS` is still set in `ci.yml`, `release.yml` and `demo.yml`, and `tsup` still builds declarations with `dts: true` in core and React).

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
