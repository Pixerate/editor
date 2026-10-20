---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Optional provider effects in the video editor. With an `EffectProvider` (`effects` option, `setEffectsProvider` / `useEffects`), clips get an ordered effect stack (`effects`, with enabled, opacity and keyframable values), transitions can use a provider effect (`type: 'effect'`), and effect clips (`type: 'effect'`) draw generators, titles and overlays. Effects render frame-exact through the provider, cached per frame (`VideoEffectsEngine`), in the preview and in `renderVideoFrameExact`. `toVideoFfmpeg` refuses projects with enabled provider effects unless it gets the rendered `frames`. Without a provider, projects keep their effects and show them as placeholders. New agent tools: `search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`, `remove_effect`, `add_video_effect_clip`, `set_video_effect_transition` and `set_video_effect_keyframes` (`createVideoEffectsToolProvider`; the shared `createEffectToolProvider` is in `@pixerate/editor/effects`). React and Svelte add a new `effects` subpath with `<EffectsBrowser>`, `<EffectParameters>`, `<EffectThumbnail>` and `useEffects`, plus `<VideoEffectsPanel>`, `<VideoEditor effects>` and `useVideoEffectsTools`.
