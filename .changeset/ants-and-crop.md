---
'@pixerate/editor': patch
---

Two fixes:
- **Marching ants:** they now march along diagonal and curved selection edges, instead of the whole line flashing. The outline is stroked as joined paths (`selectionOutlinePaths`), so the dash pattern no longer restarts at every one-pixel step.
- **Crop on load:** an image that loads after the crop tool was opened now starts uncropped. A whole-image crop made at the placeholder size grows to the image's real size, and a real crop is kept as it is.
