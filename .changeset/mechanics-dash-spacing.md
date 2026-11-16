---
"@pixerate/editor": patch
"@pixerate/conformance": patch
"@pixerate/swift": patch
---

Text mechanics: the `dashes` check picks the dash by how `--` is typed. Spaced (`word -- word`) it becomes an en dash; between words (`word--word`) an em dash, as most American writers mean it. `---` is always an em dash.
