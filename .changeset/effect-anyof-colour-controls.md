---
'@pixerate/editor': patch
---

`effectFieldValue` now shows a colour field's value as hex when the value is saved as 0–1 channels (`[r, g, b]` or `[r, g, b, a]`), the way Flair's colour controls also accept them. For a value a colour well can't show (`"currentColor"`, `rgb(…)`), it shows the field's default instead of passing the string through.
