---
'@pixerate/editor': patch
'@pixerate/swift': patch
'@pixerate/conformance': patch
---

Tool argument validation (`validateJsonSchema`) no longer treats `Object.prototype` names such as `toString` or `constructor` as declared properties or present required ones: with `additionalProperties: false` they are reported as unknown properties (#766).
