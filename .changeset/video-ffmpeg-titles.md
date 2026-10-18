---
"@pixerate/editor": minor
---

The video editor's ffmpeg export is now checked against a real ffmpeg (an integration test renders every transition, speed changes, transforms, colour clips, fades and mixed sound, and checks pixels). New `titleImage` option for `toVideoFfmpeg`: titles go in as transparent full-frame images instead of `drawtext`, which needs an ffmpeg built with libfreetype (Homebrew's is not). `videoTitleFrame` gives the frame to draw for one title with `drawVideoFrame`. When titles do use `drawtext`, the export's notes say so.
