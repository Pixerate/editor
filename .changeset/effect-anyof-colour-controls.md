---
'@pixerate/editor': patch
---

Effect colour controls written as `anyOf` now show as colour fields. Flair writes its colour controls this way: `[r, g, b]` channels from 0 to 1, a CSS colour string, or `"currentColor"`, with no top-level `type`. Before this change, `effectControlField` returned `null` for them, so these colours were missing from the React and Svelte effect parameter panels, the Effect Authoring workspace and `effect_authoring_describe`. Such a control becomes a colour field when its default is `#rrggbb` (or `#rrggbbaa`) or a 3- or 4-channel array, which is converted to hex. `effectFieldValue` shows a colour field's channel arrays as hex. It falls back to the default for a value a colour well can't show (`"currentColor"`, `rgb(…)`).
