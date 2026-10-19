---
'@pixerate/editor': minor
---

Video editor: loudness normalisation on export. `toVideoFfmpeg` takes `loudness: { integrated, truePeak, range, measured }` and adds EBU R128 `loudnorm` to the mix (back to 48 kHz after it). Without `measured` it normalises in one pass; `toVideoLoudnessMeasure` builds a sound-only measuring pass whose stderr `parseVideoLoudnessMeasurement` reads, for an exact linear second pass (checked against a real ffmpeg: within 1 LU of the target). New agent tool `export_video_loudness_measure`, and `export_video_ffmpeg` takes `loudness`.
