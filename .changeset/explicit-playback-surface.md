---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
---

An explicit agent playback surface now wins over a provider's own. `createImageEditorToolProvider`, `createImageEffectsToolProvider`, `createVideoEditorToolProvider`, `createVideoEffectsToolProvider`, `createAnimationEditorToolProvider`, `createAnimationEffectsToolProvider`, `createChartToolProvider`, `createPaintEditorToolProvider` and `createPaintEffectsToolProvider` take a `playbackSurface` option, so several editors of one kind on one registry can each play on their own surface (default unchanged: `image`, `video`, `animation`, `chart`, `paint`). `withImagePlayback`, `withVideoPlayback`, `withAnimationPlayback`, `withChartPlayback` and `withPaintPlayback` prefer an explicit `surface` argument over the provider's `playbackSurface`, and fall back to the default only when neither is given. The React hooks that register these providers (`useImageEffectsTools`, `useVideoEditorTools`, `useVideoEffectsTools`, `useAnimationEditorTools`, `useAnimationEffectsTools`, `usePaintEffectsTools`, `useChartToolProvider`) forward `playbackSurface`; the Svelte hooks already pass their options through.
