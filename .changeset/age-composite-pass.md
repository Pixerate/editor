---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Paint time machine: ageing (`set_age`: varnish, fading, cracks, dust) is now one pass over the composite instead of inside each layer, in TypeScript and Swift. Multiply and Overlay layers are no longer yellowed twice, and light-spill (Linear Dodge) layers no longer pick up dust and bleach and brighten. Normal layers age as before. `bake_age` now bakes a layer that, over the painting, gives exactly what the preview showed (a Multiply glaze or a translucent wash over the paper no longer bakes to its own colour), and paint in hidden groups no longer counts as painted for the cracks.
