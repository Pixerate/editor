---
'@pixerate/editor': patch
---

Speed up dual-colour `SchemeReplay` on large wet-paint canvases (~60 s down to ~1.3 s on `4000 × 4000`: await `WetWorld.ready` before replay stepping so initial batches never run on the TypeScript fallback kernel, batch halo refreshes lazily across brush dabs, step headlessly in `FREE_INTERVAL` chunks without intermediate tile shading or WebGPU readbacks, yield in 12 ms `MessageChannel` slices, and fast-skip dry quads in the WASM SIMD wet kernel) and queue `PaintGesture` strokes started while a wet step batch is in flight instead of throwing `Wet paint is mid-step`.
