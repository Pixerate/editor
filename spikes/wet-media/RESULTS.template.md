# Wet media spike: WebGPU vs WebAssembly SIMD vs TypeScript

**Status:** spike, not for release. Nothing here is imported by `packages/`. Measured 2026-10-19.

**Question:** how should the paint editor's wet media (watercolour first) run in the browser?

## Recommendation: hybrid, with the CPU as the authority

1. **Build the WebAssembly SIMD engine first and treat it as the reference.** It runs in Web Workers on 256 px tiles and works in every browser with cross-origin isolation. It owns drying, save, export and any stroke replay. Its results were bit-identical with 1 and 14 workers, and between Chrome 156 and Safari 27.
2. **Add WebGPU second, as an accelerator for big wet areas.** It's 2.0–2.7× faster than wasm on large washes on this M4 Pro. It also keeps the CPU almost idle: the renderer used about 1–7% CPU, against 700–1050% for wasm. Turn it on when `navigator.gpu` is present and the wet area is large. Results stay within 1/255 of the CPU, but they are not bit-identical, even between two browsers on the same GPU.
3. **Plain TypeScript is for tests and Node only.** It's 60–120× slower than wasm with workers, and about 9× slower than one wasm worker. A dab takes 50–1400 ms to show up, which is unusable for painting.

The hint from Rebelle (OpenMP + Highway) and Corel Painter (AVX2 LBM builds) holds up. A SIMD CPU lattice Boltzmann watercolour is fast enough to paint with on its own. On this machine, wasm SIMD sustains ≥ 120 steps/s (two steps per 60 Hz frame) for every case up to a fully wet 2048² canvas, and for 4096² at 10% wet. It runs 99 steps/s at 4096² 50% wet. It's too slow only for a fully wet 4096² sheet (37 steps/s). WebGPU reaches 101 steps/s there.

So the CPU path isn't a "low resolution fallback", and it's needed anyway: dry painting must work without a GPU, and save has to dry deterministically. WebGPU is worth having for headroom, battery and very large washes. It shouldn't be the only engine, and it shouldn't be the source of truth.

Why not GPU-first with a CPU fallback? The two cost about the same to build, since both kernels are needed either way. The difference is which one defines the result. With GPU-first, the saved painting depends on the shader compiler and GPU vendor. Chrome's Tint and Safari's compiler already give different bits on the same Apple GPU. The CPU result is reproducible everywhere.

Why not CPU-only? On this Mac the CPU path keeps 10 cores busy while paint is wet, and it falls behind on full-sheet 4096² washes. Lower-end machines have fewer cores (see the scaling table) and would hit the limit sooner. With WebGPU accepted, it's the cheap way to buy headroom.

## What was built

All of it is in `spikes/wet-media/`:

| File | What |
|---|---|
| `src/model.ts` | Parameters, D2Q9 constants, paper grain (seeded value noise), flow map, display shading, the `WetSim` interface |
| `src/ts-sim.ts` | **Reference.** `stepTile` defines the model: one pass per cell over dense `Float32Array` planes |
| `assembly/step.ts` | AssemblyScript port of `stepTile`, 4 cells per `f32x4`, on 258² tile slots (256 + 1-cell halo) |
| `src/wasm-layout.ts`, `src/wasm-worker.ts`, `src/wasm-sim.ts` | One shared `WebAssembly.Memory`. Workers take tiles from an atomic counter, then barrier, grow the tile set, exchange halos, and barrier again |
| `src/gpu/step.wgsl`, `edit.wgsl`, `display.wgsl`, `src/gpu-sim.ts` | WGSL port. Dense storage buffers, ping-ponged bind groups, `dispatchWorkgroups(16, 16, activeTiles)`, per-tile wet flags read back asynchronously |
| `src/active.ts` | Grow-only active tile set, shared by all three |
| `src/main.ts`, `index.html` | Vite page: interactive painting (`/`), plus `?mode=bench|latency|diverge|scaling|readback` |
| `scripts/run-bench.mjs` | Drives Chrome with Playwright. Samples `ps` (per Chrome process) and `ioreg` GPU utilisation |
| `scripts/summarize.mjs` | Turns `results/*.json` into the tables below |

Run it:

```bash
pnpm install --ignore-workspace && pnpm dev   # http://localhost:5199, paint with the mouse
pnpm bench && pnpm summarize                  # full matrix, about 25 min
```

### The model (from the literature only)

- **Water.** A D2Q9 lattice Boltzmann model with BGK collision, τ = 3ν + 0.5. Streaming uses partial bounce-back with a per-cell blocking factor, taken from the paper grain: κ = (1 − permeability)·h. The blocking between two cells is b = max(κₓ, κₙ). b = 1 at the canvas edge, and also when the wet front is *pinned*: one side is dry and the other is shallower than a threshold that rises with grain roughness. That's the scheme in Chu & Tai, *MoXi: Real-Time Ink Dispersion in Absorbent Paper* (SIGGRAPH 2005). b is symmetric, so water is conserved exactly. The table below shows drift of 1e-9 to 4e-6 over 300 steps.
- **Forcing.** Tilt plus an optional flow map, applied as a velocity shift (u += τ·g), with |u| capped at 0.25 cells per step.
- **Paper.** Absorption fills each cell's paper capacity, and evaporation is stronger where the wet area meets dry cells (edge darkening, as in Curtis et al., *Computer-Generated Watercolor*, SIGGRAPH 1997).
- **Pigment.** Advected with a first-order **upwind finite-volume** flux, using the previous step's velocities scaled by mobility (1 − weight/2). I chose this over semi-Lagrangian advection on purpose. It conserves pigment, has no gathers (so it vectorises), and with |u| ≤ 0.25 it is CFL-stable and never goes negative.
- **Deposition and lift.** Deposition is boosted in grain valleys, which gives granulation. Pickup lifts deposit back into clear water. On drying, all suspended pigment settles.
- **Parameters exposed.** Wetness and concentration (per dab), viscosity, evaporation, edge evaporation, pigment weight, pickup rate, fixture rate, paper absorption, capacity, permeability and roughness (all from the grain height map), pin threshold, tilt x/y, and flow-map strength.

| Wet, step 100 | Wet, step 300 | Dried, step 500 (TS) | Dried, step 500 (WebGPU) |
|---|---|---|---|
| ![](results/ts-wet-step100.png) | ![](results/ts-wet-step300.png) | ![](results/ts-dry-step500.png) | ![](results/gpu-dry-step500.png) |

These are a 512² test: 4 dabs at step 0, a clear-water dab at step 150 (it lifts pigment), and another dab at step 300, with tilt and a swirl flow map. The look isn't tuned (edge darkening is mild). This spike is about cost, and tuning the look doesn't change the cost.

### Why AssemblyScript, not Rust

Rust and `wasm-pack` aren't installed on this machine. AssemblyScript is an npm dev dependency, set up in one line with no toolchain download. Its `v128` / `f32x4` intrinsics map one-to-one onto wasm `simd128`, and it supports `--sharedMemory --importMemory` for threads. The kernel is straight-line SIMD with explicit instructions, so the output doesn't depend on an auto-vectoriser. Rust's `core::arch::wasm32` would produce essentially the same instructions; LLVM might schedule them a little better. For production I'd still consider Rust for the wider ecosystem, but the AssemblyScript build is 5 KB of wasm with no extra dependencies, which also suits this repo.

## Method

- **Machine.** Apple M4 Pro (10 performance + 4 efficiency cores, 24 GB unified memory), macOS 27.
- **Chrome.** **Chrome for Testing 156.0.8078.4** (Playwright's build; Google Chrome itself isn't installed), headed, default flags. **Safari 27.0.1** was used for a cross-check, opened with `open -a Safari …&report=1`.
- **WebGPU adapter.** `apple metal-3`. Its limits allow 4 GiB storage bindings and 10 storage buffers per stage. The step uses 9.
- Each configuration ran on a fresh page with a fresh context.
- **Wet area.** "X% wet" means a tile-aligned block of about X% of the tiles. It's washed with an 80 px inset (so no neighbouring tile wakes up) and stirred with 64 px dabs every 128 px. The tables give the number of tiles actually dispatched.
- **Steps per second.** The median over batches of about 250 ms, after 8 warm-up steps, for a budget of 4 s. TS at 4096² ran far fewer steps.
- **wasm workers.** wasm uses `hardwareConcurrency` workers: 14 in Chrome, 8 in Safari, which caps the reported value.
- **Dab to pixels.** Time from `dab()` through one step and presenting the dab's tiles until the pixels are committed. For WebGPU that's `onSubmittedWorkDone`; for CPU paths it's `putImageData`. A compositor frame (≤ 8–17 ms) comes on top. Each run does 9 dabs on fresh paper, and the first one includes allocation.
- **Load.** CPU % of the renderer and GPU processes (`ps`), and Apple GPU *Device Utilization %* (`ioreg`), sampled every 0.4 s while stepping. Benchmarks run flat out, so the GPU shows about 99% by design. A real editor would cap the steps per frame.
- **Memory.** "Sim state" is the analytic size of the buffers each path allocates. Process RSS is shown too. WebGPU buffers live in IOKit memory, which doesn't show up in the GPU process RSS.

## Results

{{steps}}

The wasm 1024²/10% row is low because only 2 tiles exist for 14 workers. Splitting a tile into row bands would fix that. The GPU 1024²/10% row is cache-resident and dispatch-bound. At scale, WebGPU is **bandwidth-bound at about 1.7 G cell-steps/s**: roughly 110 B per cell-step, about 190 GB/s against about 270 GB/s peak. wasm reaches 0.6–0.8 G cell-steps/s on 10 performance cores.

{{memory}}

The state costs **120 B per cell on the GPU** (dense, regardless of how much is wet) and **126 B per active cell for wasm** (31 f32 planes on 258² slots, allocated only for wet tiles). An RGBA8 raster tile costs 4 B per cell, so the wet layer is about 30× the size of the paint it produces. That's why wet state must be sparse and short-lived. On the GPU, a 4096² canvas holds 1.9 GB however little of it is wet. A production GPU path should use a tile atlas (256² slots plus an indirection table) like the wasm slots.

{{latency}}

Every WebGPU and wasm case except one is under one 60 Hz frame (16.7 ms): wasm at 4096² with half the canvas wet takes 19 ms. That's one step of 164 tiles, plus shading the dab tiles in JS. The first GPU dab on a fresh 4096² canvas took 228 ms, because the first use of the 1.9 GB of dense buffers faults them in. The single 339 ms outlier at GPU 1024² looks like a one-off pipeline or driver stall. Both should be done at document open, not on the first stroke. The CPU paths shade the display tiles on the main thread in JS, at about 1.1 ms per tile (see below). Moving that into the wasm workers would remove most of the wasm latency.

{{scaling}}

Scaling is close to linear up to the 10 performance cores (7.6×) and then flat: the efficiency cores add nothing, and memory bandwidth is the next limit. A 4-core laptop should get roughly 4/10 of these numbers, about 90 steps/s at 2048² fully wet.

### Wet layer → RGBA8 raster tiles (2048², fully wet, Chrome)

{{readback}}

The compositor stays on the CPU, so the GPU path has to hand RGBA8 tiles back. That turned out to be cheap: 64 tiles (16 MB) in 4.4 ms, including shading the whole canvas. On the CPU path, the expensive part is the shading in JS on the main thread, at about 1.1 ms per tile (3 `exp` per pixel). In production it belongs in the SIMD kernel, run in the workers.

{{diverge}}

### Safari 27.0.1 cross-check (same Mac)

| Run | Steps/s (ms/step) |
|---|---|
| WebGPU 2048², 100% wet | {{s_gpu2048}} |
| wasm SIMD ×8, 2048², 100% wet | {{s_wasm2048}} |
| WebGPU 4096², 100% wet | {{s_gpu4096}} |
| wasm SIMD ×8, 4096², 50% wet | {{s_wasm4096}} |

The step-500 state hashes in Safari: **TypeScript and wasm match Chrome bit for bit**: TS `e1c8003f1a5f2236bcc95b4c`, wasm `276867b8e97d13108f5c61bb`. **WebGPU doesn't**: Chrome gives `b662c73e…`, Safari `58320f48…`. The hardware is the same, but WGSL is compiled by different compilers (Tint→MSL in Chrome, WebKit's own in Safari). Safari WebGPU is still within the same 1/255 of the reference. Safari's `maxStorageBufferBindingSize` is 2 GiB (Chrome's is 4 GiB), and it reports `hardwareConcurrency` = 8.

## Questions from the brief

### How results diverge over 500 steps

They barely do. Against the TS reference (which computes in f64 and stores f32), wasm and WebGPU stay within **~3e-6 absolute (relative RMS ≤ 1.1e-5)** in water, pigment and deposit. After display or drying, pixels differ by at most **1/255** on **≤ 0.002 %** of them. The model is dissipative (evaporation, deposition, BGK relaxation) and has no chaotic amplification. The discontinuities (pinning, the dry threshold) didn't cause visible forks in this test.

- **Bit-identical within an implementation:** wasm with 1 and 14 workers (work split, halo exchange and order don't matter, because each cell is computed independently), two WebGPU runs on the same browser, and TS and wasm across Chrome and Safari.
- **Not bit-identical:** across the three implementations, and WebGPU across browsers. Expect WebGPU to differ across GPU vendors and driver versions too, since WGSL allows fused multiply-add contraction and approximations in `exp`, `sqrt` and division.

### WebGPU availability today, and what the fallback costs

- **Chrome / Edge:** on by default on Windows, macOS and ChromeOS since 113, and on Android 12+ (Qualcomm and ARM GPUs) since 121. Linux is still rolling out by GPU and driver.
- **Safari:** on by default in Safari 26 (macOS, iOS, iPadOS, visionOS 26). Verified here in Safari 27.0.1: it ran the same WGSL unchanged.
- **Firefox:** on by default on Windows since 141, and on Apple Silicon macOS since 145. Linux and Android are still in progress. (Firefox isn't installed here, so it wasn't measured.)

Sources: the [gpuweb implementation-status wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) and [WebGPU on Wikipedia](https://en.wikipedia.org/wiki/WebGPU), checked 2026-10-19. This is AI-gathered and should be re-checked against the browser release notes before it's relied on.

**The fallback costs about 2–2.7× in steps/s on this machine, plus CPU load and heat.** The wasm path keeps up to 10 cores busy while paint is wet (700–1050% renderer CPU on large washes). Visually nothing is lost (≤ 1/255). WebGL2 isn't worth a third kernel: the CPU path already covers browsers without WebGPU.

**One hard requirement for the fallback: cross-origin isolation.** Shared wasm memory needs `SharedArrayBuffer`, so the host page has to send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). Embedding apps must be told this. Without it, wasm runs on one thread: 24 steps/s at 2048² fully wet, which is still about 9× TS. A message-passing tile design could run without it, at the cost of copying halos.

### Fit with the shared `@pixerate/editor/raster` tiles (256 px RGBA8, copy-on-write)

**Yes, the wet state needs its own float tiles.** 13 ping-ponged f32 planes plus deposit, paper water, grain and flow take about 126 B per cell, while RGBA8 is 4 B. No 8-bit encoding survives the LBM: the distributions are around 1e-2 and steps change them by around 1e-6.

- **The geometry already matches.** The wasm slots use the raster's 256 px tile grid and the same tile keys, plus a 1-cell halo. A wet layer can be a `Map<TileKey, WetSlot>` next to a raster layer's `TiledSurface`.
- **Display.** Each step (or each frame), shade only the active tiles into fresh RGBA8 tiles and swap them into the layer's surface. That fits copy-on-write: untouched tiles are shared, and the compositor sees an ordinary RGBA8 layer. WebGPU can do the shading and hand tiles back cheaply (see the readback table).
- **Lifetime.** The set is grow-only in this spike. In production, a tile and its ring that stay dry for N steps get baked into the raster tile and their slot freed.
- **WebGPU.** In production, use the same slot model as a GPU tile atlas rather than dense canvas buffers, so memory follows the wet area. The spike's dense 4096² GPU state is 1.9 GB.
- **Grow-only activation works on every path.** A dry tile computes to exactly its previous zero state, so activating early never changes results. That's why late, asynchronous GPU flag readback still matches the CPU.

### Can "dry on save" bake deterministically?

**Yes, if the bake runs on the CPU.** Drying is a pure function of the final f32 state: all suspended pigment settles (d + p), the water goes, and `shade()` turns that into RGBA8 tiles. Baking the same state twice gave the same hash. A GPU session reads back `d` and `p` (8 B per cell) and bakes with the same CPU code.

The final state still depends on the engine that produced it: wasm, TS and WebGPU each differ by ≤ 1/255 on a few pixels. That's fine for the decision as made. Documents store dried pixels, never wet state, so reopening is exact.

Any feature that **re-simulates** strokes needs the wasm engine, whose results don't depend on threads or browser. That covers replaying a recording, re-rendering at a higher resolution for export, or "redo from history".

## Gotchas found (carry to `GOTCHAS.md` when the paint editor lands)

- **Same GPU, different bits.** WebGPU in Chrome and Safari on the same Apple GPU gives different results, because the WGSL compilers differ. Never make a GPU result authoritative for saved pixels or replay.
- **Safari reports `hardwareConcurrency` = 8** on a 14-core M4 Pro. Size the worker pool from a quick self-benchmark, not from that value alone.
- **Efficiency cores add nothing to the wasm step.** Speed-up stops at the performance-core count, and more workers just burn power.
- **WebGPU's default limits are too small** for 2048² and above: `maxStorageBufferBindingSize` is 128 MiB and `maxBufferSize` 256 MiB, while the f planes at 2048² take 151 MB (604 MB at 4096²). Request the adapter's limits. Safari's adapter caps bindings at 2 GiB, which rules out dense 8192² state and is another reason for a tile atlas.
- **The WebGPU canvas texture is new every frame**, so dirty-rect presenting needs a persistent texture that gets copied (or a CPU compositor).
- **Tile activation must run ahead of the water**: activate the neighbour when wet cells come within 64 px of a tile edge. Otherwise water crossing into a tile that isn't stepped is lost silently.

## Not done (time box)

- Only one machine. No discrete GPU, no Windows or Android, no low-end laptop.
- Firefox wasn't measured (not installed).
- No `f16` storage. Halving the distributions would roughly halve GPU bandwidth and memory. Divergence would need re-checking.
- No sparse GPU tile atlas, and no "A-A pattern" streaming to drop the f ping-pong (about −30% memory).
- Only one pigment channel. Several Kubelka-Munk pigments add about 1 plane each per pigment, so cost grows with the pigment count.
- Display shading for the CPU paths runs in JS on the main thread rather than in SIMD in the workers.
