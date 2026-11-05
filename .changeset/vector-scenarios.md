---
"@pixerate/editor": patch
---

**Conformance:** `conformanceValuesMatch` and `CONFORMANCE_NUMBER_TOLERANCE` compare recorded scenario values as the Swift runner does, with numbers equal within a relative 1e-9. Maths functions can differ in their last bits between CPUs. Also adds the vector conformance scenarios (#620).
