---
'@pixerate/editor': patch
---

Object Selection without a model (GrabCut): a click now learns the object's colours from a disk around the click instead of the whole search window. A click on an object whose surroundings reach the window's edge (a castle in mist on a hill) no longer selects the whole image, and a click on a fruit no longer takes its shadow. An object smaller than the disk is re-seeded from what was found. On the new synthetic evaluation, mean IoU over 15 box and click cases rises from 0.785 to 0.934, and the castle clicks take about 75 ms instead of 1.5 s. Box selection is unchanged.
