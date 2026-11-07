---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
'@pixerate/swift': minor
---

Add path-native effect paint (`map: { by: 'path' }`) for effects with a `format: 'svg-path'` control, passing each stroke's centreline in canvas pixels (simplified to at most 256 points) to the effect's path control, with UI placement ("Along the stroke (native)") in React and Svelte and full Swift parity.
