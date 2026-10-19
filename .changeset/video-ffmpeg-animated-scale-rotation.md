---
'@pixerate/editor': patch
---

Video editor: fix keyframed scale and rotation in the ffmpeg export. A keyframed scale stayed at its first size when the clip also had keyframed opacity, a wipe or a rotation (`geq` and `rotate` keep the size they first see), and a keyframed rotation drew an opaque box around the picture (`rotate`'s `c=none` with a moving angle). The animated scale now comes last in the chain, scaling by the input size, and `rotate` fills with transparent black.
