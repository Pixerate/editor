---
'@pixerate/editor': minor
---

Video editor: drop-frame timecode at 29.97 and 59.94 fps. `formatVideoTimecode` now writes `HH:MM:SS;FF` drop-frame at those rates by default (pass `false` for non-drop), and new helpers `isVideoDropFrameRate`, `formatVideoTimecodeFrames`, `videoTimecodeFrames` and `videoHourFrames` are exported. EDLs at NTSC rates now declare `FCM: DROP FRAME`, with a `dropFrame` option on `toVideoEdl` and the `export_video_edl` tool to force non-drop. EDL record timecode now starts at timecode 01:00:00:00 counted in frames, so non-drop EDLs at 29.97 no longer start at 00:59:56:12.
