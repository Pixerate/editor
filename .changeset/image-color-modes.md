---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add CMYK and Lab document modes. CMYK PSDs now open through their embedded CMYK profile (or the default coated CMYK) instead of a plain ink approximation, and keep CMYK mode; Lab PSDs keep Lab mode. `setColorMode('cmyk' | 'lab' | 'rgb', { profile, intent })` (and the `set_color_mode` agent tool) keeps editing in RGB, soft-proofs a CMYK document through its profile, and makes `toPsd` write CMYK (with the profile in resource 1039) or Lab channels. `<ColorProfilePanel>` gets a Mode menu in React and Svelte.
