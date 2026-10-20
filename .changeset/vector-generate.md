---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Generative prompts in the vector editor through `@pixerate/editor/generation`: `generateVectorArt` / `regenerateVectorArt` plan a prompt against a model, call the host's generator, and add the SVG (or the traced or stylised picture) as one editable group with its provenance; agent tools `list_vector_art_models`, `generate_vector_art` and `regenerate_vector_art` (idempotency keys required); `<VectorGeneratePanel>` and `useVectorGenerationTools` in React and Svelte.
