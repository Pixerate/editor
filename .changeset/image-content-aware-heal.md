---
"@pixerate/editor": minor
---

Image editor: Content-Aware spot healing. The Spot Healing Brush has a new `content-aware` type that synthesises texture and continues lines and patterns across the spot from patches all around it. It runs PatchMatch nearest-neighbour fields with patch voting, coarse to fine, and then blends seamlessly. It's available through `spot_heal` `type: "content-aware"` and the Content-Aware choice in the React and Svelte options bars. New `contentAwareFill` in `/paint`.
