---
"@pixerate/editor": minor
---

House style for animation and video (#779).

- `animationStyleDomain` (`animation-editor.json`): the easings allowed, a range for command durations, the least hold per shot, a length limit, the frame rates allowed, and the brand's palette-only on style commands. Agent tools `check_animation_style` and `fix_animation_style` (easings, durations, holds and frame rate as one undo step; hidden when read-only), `createAnimationStyleToolProvider`.
- `videoStyleDomain` (`video-editor.json`): frame aspect ratios and rates, a length limit, title sizes, the transitions allowed and their longest length, and the brand's palette-only / min-contrast / fonts-allowed on titles. Agent tools `check_video_style` and `fix_video_style` (frame rate, title sizes and transitions as one undo step; hidden when read-only), `createVideoStyleToolProvider`.
