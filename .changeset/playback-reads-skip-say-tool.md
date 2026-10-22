---
"@pixerate/editor": minor
---

Agent playback now shows only changes by default: `createAgentPlayback()` defaults `reads` to `'skip'`, so read-only tools return at once without moving the cursor. Pass `reads: 'glance'` (or `'play'`) to keep the previous behaviour, e.g. for demos and tours.

New, optional `createPlaybackToolProvider(playback)` adds a `playback__say` tool that lets an agent show a short note beside its cursor. It is UI-agnostic (it only writes to the presence store), returns `{ shown, surface }`, and shows nothing without an error when no cursor is on screen. `playback.say()` now returns the surface id it showed the note on, or `null`.
