---
"@pixerate/editor": minor
---

PSD files keep their layer effects. Import maps `lfx2` / `lfxs` / `lmfx` (and legacy `lrFX`) to live effects. It also reads the embedded patterns (`Patt` / `Pat2` / `Pat3`) and the global light (resources 1037 and 1049), and warns only for what it draws approximately: gradient midpoints and smoothness, noise gradients, glow jitter, Dissolve, legacy bevels, and patterns the file lacks. Export writes effects as `lfx2` (`lfxs` on groups). A block opened from a PSD is written back byte for byte while its effects are unchanged, and the patterns the effects use are embedded. Document patterns are saved in the v3 document and listed by `list_layer_effects`. The image editor entry re-exports the effects model.
