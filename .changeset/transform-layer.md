---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Move, scale, rotate and flip a pixel layer: `transformLayer` (and the `transform_layer` agent tool) resamples a layer's paint about an origin (default the centre of its painted area) in one undo step. Wet paint is dried first; layers with relief, light, UV or thermochromic ink, ferrofluid, a culture or a mask are refused for now. Swift matches, with a conformance scenario.
