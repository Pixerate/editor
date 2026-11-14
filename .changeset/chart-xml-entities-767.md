---
'@pixerate/editor': patch
'@pixerate/swift': patch
---

The chart's fallback XML parser leaves unknown entities such as `&toString;` and character references past U+10FFFF or to a surrogate as text, instead of decoding `Object.prototype` members or throwing `RangeError: Invalid code point` out of `extractOfficeCharts` (#767).
