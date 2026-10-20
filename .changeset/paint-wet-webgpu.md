---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Wet media: Engine B, a WebGPU accelerator for large wet areas. With `navigator.gpu` and at least 16 wet tiles (256 px), the wet step and the display shading also run in WebGPU compute shaders on the CPU engine's tile layout, and every stale tile is shaded at once instead of in main-thread JavaScript. Between strokes the GPU runs up to 16 steps ahead within the batch the CPU is computing, so large washes keep moving on screen. The CPU engine stays the authority: drying, saving, export and replay are byte-identical with the GPU on or off, and the display stays within 1/255. New in `/paint`: `createWetGpuEngine`, `wetGpuSupport`, `WetGpuEngine`, `WetWorld.attachGpu` and `displayGpu`. New in the paint editor: the `gpu` and `gpuMinTiles` wet options, `setWetEngine`, `wetEngine`, `engine` in `wetState`, `wetEngineSummary`, and the `set_wet_engine` agent tool. React and Svelte `WetPanel` get an engine select (GPU for large washes, or CPU only) and a status line.
