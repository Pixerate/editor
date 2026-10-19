---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: text-based editing. Assets take a `transcript` of words timed in the source, so it stays right however clips are cut; `parseVideoTranscript` reads Whisper-style JSON (word timings), SubRip and WebVTT (words spread across each cue). `videoTimelineTranscript` maps the words through clips, in points and speed onto the timeline, and `findVideoTranscriptText`, `findVideoFillers` (longest phrase first) and `findVideoTranscriptPauses` return timeline ranges that `videoRemoveRangesEdits` cuts out last first as one undo step. New agent tools `set_video_transcript`, `get_video_transcript`, `find_video_transcript_text`, `find_video_fillers`, `find_video_pauses` and `remove_video_ranges` (`get_video_project` lists a transcript as its word count). New `<TranscriptPanel>` in React and Svelte, also shown in `<VideoEditor>` (`showTranscript`): click a word to go to it, Shift-click to select a run and delete it, remove fillers, tighten pauses, and load transcript files per asset.
