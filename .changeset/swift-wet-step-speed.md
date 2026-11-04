---
"@pixerate/swift": minor
---

**Swift:** wet paint steps about 15× faster, with the same bits (#607). On an M4 Pro, a fully wet 2048² canvas now takes 15 ms a step instead of 223 ms.

- **Threads:** `WetWorld` steps tiles on every core and refills their halos the same way. `WetWorld.threads` changes only the speed.
- **SIMD:** each tile steps four cells at a time in a new C target, `PixerateWetKernel`, the counterpart of the core's WebAssembly SIMD kernel.
- **Same results:** saved paintings, exports and conformance results are unchanged. Tests compare the SIMD kernel with the scalar one, and several threads with one, bit for bit.
