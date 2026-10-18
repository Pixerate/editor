---
"@pixerate/editor": patch
---

`toLottie` now leaves hidden artwork nodes (`visible: false`) out of the exported file. They were written as groups marked `hd: true`, which lottie-web ignores on groups, so hidden follow routes and morph targets showed in Lottie players. Follows and morphs that use a hidden node are unchanged: they are sampled into keyframes.
