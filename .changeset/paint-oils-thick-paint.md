---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Oils and thick paint in the paint editor. Wet oil runs on the wet simulation as a thick, slow-drying medium that blends into the wet paint it meets (`wet.medium`: watercolour, gouache or oil, with paint loading and thinner). Thick paint (`engine: 'impasto'`) gives a layer height and material channels (gloss, metallic) lit at render time by a movable light: impasto brush, paint tube, palette knife, roller, gloop pen and metallic paint, with paint loading and thinners. Instant dry, metallic paper, and relief and lighting saved with the document. New agent tools `set_lighting`, `get_relief`, `flatten_relief` and `set_instant_dry`; React and Svelte add impasto and medium menus in `<BrushPanel>`, a light section in `<PaperPanel>` and Instant dry in `<WetPanel>`.
