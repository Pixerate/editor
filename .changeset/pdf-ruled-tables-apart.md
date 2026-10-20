---
"@pixerate/editor": patch
---

PDF import keeps same-width ruled tables apart. Horizontal rules with the same extent were joined as one booktabs-style table even when they belonged to separate grids, so every ruled table of that width on a page, and the text between them, came out as a single table. Rules that meet a vertical rule now join only through their grid.
