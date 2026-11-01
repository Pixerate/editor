---
'@pixerate/editor': patch
---

`pixerate-image-portrait-retouch` now gives a spot-heal brush size that removes the whole spot. With a soft brush (hardness 0.2-0.5) it says 2.5-3× the spot's width, because a brush "a little larger than the spot" leaves a faint dark ring. The clean-up recipe now says how to measure that a spot is gone, and the pitfall about brush size covers brushes that are too small as well as too big. Found when Pixie followed the old advice in the `remove-blemishes` eval.
