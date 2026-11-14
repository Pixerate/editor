---
'@pixerate/editor': patch
'@pixerate/swift': patch
'@pixerate/conformance': patch
---

The image editor's `parseCssColor` no longer reads `Object.prototype` names such as `constructor` and `__proto__` as colours; shape and type layers using them are refused with a colour problem (#849).
