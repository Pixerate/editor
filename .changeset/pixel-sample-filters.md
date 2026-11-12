---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Pixel expressions can read an input picture with `sample(p)` (#754), so an effect written at run time can be a filter. `p` is a vec2 in uv (pixel centres, y down, as `uv`); the result is the `source` input as a straight-alpha vec4, bilinear with colour weighted by alpha and clamped to the edge, and transparent when there is no input. It counts 4 steps in the per-pixel cap, and the checker refuses a non-vec2 argument or the wrong number of arguments. A program that calls `sample` describes itself with `uses: ['filter']` and an image input `source` (and keeps no paint hint); any other stays a generator. In the paint editor an authored filter runs on a layer's dried paint with `apply_effect`, and the trial render times it on a picture. New exports: `pixelSample`, `pixelProgramSamples`, `PIXEL_SOURCE_INPUT`, and an optional `source` argument to `PixelEvaluator.render`. The Swift evaluator matches the TS one exactly, and the generated Metal kernel takes the source as `buffer(2)` with its size after the controls (`PixelMSLSource.sourceSizeOffset`).
