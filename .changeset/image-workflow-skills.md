---
'@pixerate/editor': minor
---

Three new image workflow skills: `pixerate-image-photo-correction` (frame, light, colour, local, look, each checked for clipping and neutral greys), `pixerate-image-portrait-retouch` (blemishes, stray hairs, dodge and burn, eyes and teeth on their own layers) and `pixerate-image-product-photo` (product on white, a grounding shadow, centred marketplace crops), each with evals. `pixerate-image-editor` is back under 450 lines: its correction, effect, transform and smart object advice moved into the workflow skills and its reference files.

New agent tool `measure_region`: measures a rectangle of the composited image without a render (the histogram summary plus the mean colour and a red-blue and green-magenta cast), so agents can check a neutral reference, skin or a background, and so checks work where `render_preview` cannot.
