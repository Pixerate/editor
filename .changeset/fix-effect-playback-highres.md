---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

**Paint editor (TypeScript core and Swift):**

- **`set_effect_playback` keeps the setting a call leaves out.** `{ playing: false }` keeps the frame rate, and `{ fps: 12 }` keeps the play state. Before, the setting left out was unset (#602).
- **`export_high_res` works on paintings with stroke-mapped effect paint.** The replay now renders the effect paint the scaled strokes ask for, so a 2× export no longer fails with "is not rendered at this canvas size" (#603).
