---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Paint time machine: ageing (`set_age`: varnish, fading, cracks, dust) is now one pass over the composite instead of inside each layer, in TypeScript and Swift. Multiply and Overlay layers are no longer yellowed twice, and light-spill (Linear Dodge) layers no longer pick up dust and bleach and brighten. Normal layers age as before, and `bake_age` commits the same aged composite the preview shows.
