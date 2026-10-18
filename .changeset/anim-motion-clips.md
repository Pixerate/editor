---
"@pixerate/editor": minor
---

Animation scenes get reusable clips.

- **Clips:** `scene.clips` holds named command lists written against the target `"$"`.
- **Playing:** a `play` command plays a clip on any nodes, with stagger and `speed`. Each command of the clip is timed as in a shot, and the clip's length comes from its commands (`motionClipLayout`).
- **Checks:** `unknown-clip` (with "did you mean") flags a play of a missing clip, and clips that name missing nodes are reported. Clips cannot play clips.
- **Agent tools:** `set_animation_clip` defines, replaces or deletes a clip, refusing to delete one still being played. `copy_animation` gives other nodes one node's motion, inserting each copy after its original as one undo step. `get_animation` lists clips with their lengths.
