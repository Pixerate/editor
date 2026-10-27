---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: adjustment clips, masks, skin-tone protected LUTs, plan-first edits, transcript cleanup, ducking, loudness and beats.

- **Adjustment clips** (`type: 'adjustment'`, `scope`: `underneath` / `all` / `track` with `targetTrack`): their grade, provider effects and mask apply to the composite of the pictures in scope while they play, in the preview, SVG frames and the ffmpeg export (a full-opacity grade or LUT over what is underneath or the whole frame; anything else needs rendered frames). Their effects open in the effect authoring editor (`openVideoClipEffectAuthoring`, `videoClipEffectDocument`, `videoEffectValuesFromDocument`), with video keys and animation easings converted both ways.
- **Clip masks** (`mask`: rectangle with corner radius, ellipse, linear split, polygon; position, size, rotation, feather, invert) in the preview and SVG (`videoMaskPolygon`, `videoLayerMask`, `videoMaskContains`).
- **Skin-tone protection** for LUTs (`preserveSkinTones`, `videoSkinToneWeight`) in the preview and frame renders; the ffmpeg export notes it.
- **Edit plans**: `planVideoEdits`, `diffVideoProjects`, and `controller.proposePlan` / `applyPlan` / `discardPlan` with `state.plans`, re-checked when the project changed since.
- **Transcript cleanup**: `findVideoRepetitions`, `detectVideoDisfluencies`, `videoCutsWithMargin` and `TranscriptVideoController` (playhead word, selection, text offsets to times, delete or plan words, one-click disfluency cuts, cleanup plans).
- **Mix**: BS.1770 loudness in peaks (`VideoAudioPeaks.loudness`, `measureVideoLoudness`, `videoAudioLoudness`, `videoLoudnessGain`), ducking keys (`videoSpeechRanges`, `videoDuckingKeys`) and beats (`findVideoAudioBeats`, `nearestVideoBeat`).
- **Agent tools**: `add_video_adjustment_clip`, `set_video_clip_mask`, `remove_video_clip_mask`, `set_video_skin_protection`, `plan_video_edits`, `list_video_edit_plans`, `apply_video_edit_plan`, `discard_video_edit_plan` (and `preserve_skin_tones` on `set_video_lut`); `createVideoDialogueToolProvider` (`find_video_disfluencies`, `plan_video_dialogue_cleanup`; skill `pixerate-talking-head-edit`); `createVideoMusicToolProvider` (`find_video_beats`, `plan_video_beat_snap`, `duck_video_music`, `measure_video_loudness`, `normalize_video_loudness`; skill `pixerate-bgm-alignment`).
- **React and Svelte**: `TranscriptEditor` (in `VideoEditor` with `transcriptMode="editor"`; the default stays `TranscriptPanel`), `EditPlanPreview`, an "Adjustment" button in `VideoTransport`, adjustment scope, mask and skin protection rows in `ClipInspector`, "author" in `VideoEffectsPanel`, `useVideoDialogueTools`, `useVideoMusicTools`, `useTranscriptVideoController` / `transcriptVideoOf`.
