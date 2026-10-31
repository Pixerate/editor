---
'@pixerate/editor': patch
---

Workflow skills get their own checks, a template and evals, and there is a new one: `pixerate-spreadsheet-clean-import`, which teaches agents to turn imported or pasted data into tidy data (structure, headers, currency and comma decimals, day-first dates, leading zeros, missing values, duplicates, validation). Each workflow skill now ships scenarios in `evals/*.json` (task, starting document, checks and a known-good solution). The reference skills for the image editor, spreadsheet and video editor list their workflow skills, and `skills/README.md` has separate tables for reference and workflow skills.

`inspect_mask_edge` no longer counts anti-aliasing as softness: `softFraction` measures only transitions wider than about 2 px, so a clean Magic Wand or ellipse selection of a hard-edged object no longer reports "Very soft".
