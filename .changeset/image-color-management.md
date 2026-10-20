---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add colour management. New `@pixerate/editor/cms`: a TypeScript ICC engine (ICC v2 / v4 profiles with matrix/TRC, grey and LUT tags, ICC v4.3 writing, transforms with all four rendering intents and black point compensation, soft-proof chains, gamut checks, built-in sRGB, Display P3, Adobe RGB- and ProPhoto-compatible, Rec. 2020, grey, Lab and a synthetic coated CMYK, and embedded profiles in PNG / JPEG / PSD). The image editor gets a document colour profile (working space) in history and JSON, `assignProfile` / `convertToProfile` with intents and BPC, a colour-managed viewport, `setProofSetup` soft proofing with a gamut warning, profiles read from and written to PSD and embedded in PNG / JPEG exports, `convertColors`, and the `get_color_profile`, `assign_profile`, `convert_to_profile`, `set_proof_setup` and `convert_colors` agent tools. React and Svelte get `<ColorProfilePanel>` in the Layers tab.
