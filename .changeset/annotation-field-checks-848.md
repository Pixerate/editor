---
"@pixerate/editor": patch
"@pixerate/swift": patch
"@pixerate/conformance": patch
---

Opening a paint or image editor document with a malformed annotation layer no longer refuses the whole document with a bare `TypeError` (#848). The annotation migration checks every field it reads (a pen's `points`, a text's `text`, geometry, `strokeWidth`, `opacity`, `rotation`, `fontSize`, `fontFamily`, `fontWeight`), reports `Layer "X": the annotation could not be read (points must be an array of { x, y } points.)` and leaves only that layer out. Wrong types that used to load as `NaN` geometry are reported the same way, and an arrow without `strokeWidth` gets the 12 px arrowhead of a 1 px canvas line instead of `NaN`. The Swift paint editor reports the same problems, and the `document-load-vector-layers` scenario covers them.
