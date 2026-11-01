---
'@pixerate/editor': patch
---

Two image workflow evals now accept the routes their skills allow. Pixie running them in Pixerate was failed on both.

- **`neutralise-cast`:** white balance in the base sliders counts as adjustable, as `pixerate-image-photo-correction` says. The grey card only has to stay mid grey (60–200), because the task asks only for neutral and the card starts at 80.
- **`grounding-shadow`:** a layer masked to the product, such as the one `separate_subject` makes, counts as the product on its own layer, as `pixerate-image-product-photo` allows ("masked, not erased").
