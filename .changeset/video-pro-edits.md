---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

feat(core): professional edits for the video editor. New ops `slip_clip`, `roll_edit` and `slide_clip` (clamped to the media and neighbours, returning the delta applied), `lift_range`, `extract_range` and `split_at` (across tracks), each with its own agent tool (`slip_video_clip`, `roll_video_edit`, `slide_video_clip`, `lift_video_range`, `extract_video_range`, `split_video_at`). `add_clip` and `move_clip` take `mode: 'refuse' | 'overwrite' | 'insert'` (`ripple: true` on `add_clip` is now the same as `insert`, which cuts clips across the insert point instead of refusing). Tracks have `syncLocked` (default true): ripple inserts, trims, deletes and extracts now move every unlocked sync-locked track together (cutting clips across an opened edit point), and a ripple that would close time where another sync-locked track still has a clip is refused with the fix — turn `syncLocked` off on a music bed to keep the old per-track behaviour. Edit outcomes report `created`, `trimmed`, `removed`, `rippled` and `delta`. The React and Svelte timelines insert with Alt and overwrite with Shift while dragging a clip (`planVideoClipDrag` `placement`, `videoDragLabel`).
