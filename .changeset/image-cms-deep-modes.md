---
"@pixerate/editor": minor
---

Image editor: 16-bit CMYK and Lab PSDs. A 16- or 32-bit document in CMYK or Lab mode now saves a 16-bit CMYK or Lab file (Photoshop has no 32-bit CMYK or Lab), separated through the profile at 16 bits (`colorModePlanes16`, `colorPlanes16` in `exportPsd`). 16-bit CMYK files now open at 16 bits, layers and masks included, through their profile.
