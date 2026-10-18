---
"@pixerate/editor": minor
---

Animation scenes export to Lottie with `toLottie` and the `export_lottie` agent tool. The output is Bodymovin JSON v5 for lottie-web and the iOS and Android players.

- **Structure:** one shape layer whose groups mirror the artwork. Each node is an outer group for its animated pose (anchor at its centre) around an inner group for its own transform.
- **Paint and drawing:** paths have solid fills and strokes with their colour, width and opacity animated. Drawing on becomes trim paths, the camera becomes a root transform, and each shot gets a marker.
- **Keyframes:** a change driven by one cubic-bezier ease (mirrored repeats included) is an eased keyframe pair. Springs, elastic, behaviours, stepped time, follows, additive layers and camera moves are sampled at `fps`. A test compares Lottie's values against the editor's frame by frame.
- **Notes:** the export lists what it could not carry over: gradients, dashes, reveal clips, skewed groups and morphs that change point counts.
- **Demo:** the animation tab has an Export Lottie button.
