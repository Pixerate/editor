---
"@pixerate/swift": minor
"@pixerate/editor": patch
---

**Swift:** Metal now shades the display of large wet areas (#604). With `set_wet_engine` `auto` (the default) and at least `minTiles` live tiles (16), `WetMetalEngine` shades every stale wet tile in one command buffer. It reads the CPU engine's tiles in place on shared memory, so nothing is uploaded. A fully wet 2048² canvas shades in 10 ms instead of 119 ms on an M4 Pro.

- **Results are unchanged.** The CPU engine stays the authority, so drying, saving, export and replay are byte-identical with the GPU on or off. The display stays within 1/255 of the CPU's.
- **Engine reports:** `set_wet_engine` and `get_wet_paint` now report the engine's real state (`not-started`, `standby`, `active`, `unavailable`, `failed`, `off`) and the GPU's name.
- **Shader source:** the kernel is the core's `WGSL_SHADE`, translated to Metal by `pnpm gen:msl` (naga).

**Core:** the `set_wet_engine` and `get_wet_paint` descriptions now say that Engine B is WebGPU in browsers and Metal in the Swift editors.
