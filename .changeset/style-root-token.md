---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

House style: a style profile that is itself a `$token` reference (`chart.json` set to `{ "$token": "…" }`) no longer crashes `createStyleResolver`. The profile is left out with an issue saying why, and `get_style` / `check_chart_style` keep working (#768).
