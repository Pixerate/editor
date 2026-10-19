---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: speed ramps and freeze frames. Media clips take `timeRemap`: keys mapping clip time to source time after the in point. The slope is the speed, a flat stretch is a freeze, and eased keys glide between speeds (`videoSpeedRampKeys` builds them from `[{ duration, speed, toSpeed }]`, with ramps eased exactly). Ramps stay on the same frames of source through trims, splits and slips. `videoClipSourceTime` and `videoClipSpeedAt` read them, and the preview pauses and seeks through speeds browsers refuse. The ffmpeg export re-times the picture with `setpts` + `fps` + `tpad` and steps the sound with `atempo` pieces (checked frame by frame against a real render). New `set_time_remap` edit op, agent tools `set_video_speed_ramp`, `add_video_freeze_frame` and `remove_video_speed_ramp`, helpers `videoSpeedRampEdit`, `videoFreezeFrameEdit` and `videoSlowMotionRamp`. The React and Svelte `ClipInspector` add "Freeze 1 s here", "Slow-mo ramp" and "Remove ramp".
