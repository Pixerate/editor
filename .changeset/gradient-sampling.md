---
"@pixerate/editor": minor
---

Gradients from sampled colours: `simplifyGradientStops` (and `fitGradientStops`, which also returns the largest error left) reduces noisy colours sampled along a line to the fewest stops within an OKLab tolerance. `sampleGradientFromLine` reads colours from any pixel reader and returns a linear OKLab gradient at the line's angle, with optional angle snapping. New agent tools: `set_gradient_from_samples` (gradient provider) and `sample_gradient` (image editor, read-only).
