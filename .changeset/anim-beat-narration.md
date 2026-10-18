---
"@pixerate/editor": minor
---

Animation shots can be cued to music or a voiceover.

- **Timing tracks:** a scene can carry a `beat` grid (`bpm`, `offset`, `meter`) and `narration` word timings, for example from TTS or speech-to-text.
- **Cues:** a shot's `at` cue (`{ beat }`, `{ word }` or `{ ms }`) starts it on that moment, and the shot before holds until then.
- **Checks:** `cue-missed` warns when the shot before runs past a cue, and `unknown-cue` flags a beat with no grid or a word the narration lacks.
- **Helpers:** `motionBeatTime`, `motionBeatAt` and `motionCueTime`. `MotionShotTiming` gains `cue` and `missedBy`.
- **Agents:** a new read tool, `get_timing_grid`, lists beats (with bar and beat) and words with their times. `set_animation_settings` sets the beat grid and narration, and shot tools take `at`.
