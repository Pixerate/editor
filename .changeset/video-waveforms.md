---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: waveforms, sound levels and silence detection. `buildVideoAudioPeaks` turns decoded audio into a min / max peak pyramid that answers any stretch exactly at any zoom (`videoAudioPeakRange`, `videoAudioPeakSpans`); `videoClipWaveform` / `videoClipWaveformPath` draw what a clip plays through its in point, speed, volume and fades; `videoAudioLevels` and `findVideoAudioSilences` measure it. `VideoEditorController` gets an `audioPeaks` cache (`VideoAudioPeaksCache`, decoding each asset once with Web Audio by default, or with the `audioPeaks` loader you pass). New agent tools `get_video_audio_levels` and `find_video_silences` read a clip (timeline times, ready for `extract_video_range`) or an asset. The React and Svelte `VideoTimeline` draw waveforms in audio clips, with a `waveforms` prop (`audio`, `all` or `none`). `videoAssetHasSound` and `videoClipShowsWaveform` are exported.
