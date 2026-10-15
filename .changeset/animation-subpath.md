---
"@pixerate/editor": minor
---

Add `@pixerate/editor/animation`, the keyframe animation model as its own dependency-free subpath: `AnimationTrack` / `AnimationKeyframe` / `AnimationValue` and the easing types, `resolveEasing`, `evaluateEasing`, `cubicBezierAt`, `springAt`, the easing presets and labels, `parseCssEasing`, `easingToCss`, `evaluateTrack`, `interpolateAnimationValue`, `normalizeKeyframes`, the OKLab colour helpers, `AnimationPlayer` / `createAnimationPlayer` and the `Clock` / `ManualClock` / `realClock` time sources. It imports no dagre, TipTap or canvas-node code, so apps that only need keyframes no longer have to install `@dagrejs/dagre`. `@pixerate/editor/canvas` still re-exports all of it.
