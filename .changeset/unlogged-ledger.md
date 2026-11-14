---
"@pixerate/editor": patch
"@pixerate/swift": patch
"@pixerate/conformance": patch
---

Paint editor: pixel layers whose pixels the stroke log can't rebuild stay marked `unlogged` after reopening, whatever saved the document (#720).

- Saves keep the `unlogged` marks whenever there are any (not only with dual-colour strokes), and add `unloggedComplete: true` when the save keeps the stroke log and the marks are known to be complete. The saved file is the same in either colour scheme.
- A document opened without that flag (saved before the marks, or without its log) marks each pixel layer with pixels that no logged stroke or event names at once ("Opened from an older document", "Opened without its stroke log"). A layer the log does name is checked the first time the colour scheme needs it: the log as opened is replayed in the background (the frozen scheme replay, every stroke as recorded) and compared with the opened pixels, within 8/255 per premultiplied channel and leaving out paint the replay still has wet. A layer that doesn't match keeps its colours instead of losing its imported or merged pixels in the other scheme.
- Documents saved by #843 with marks but without the flag are checked the same way for their unmarked layers.
- `get_color_scheme_view` reports a layer being checked as `replay` `building` with a `reason`, then `ready` or `kept` with why. The check is view state: it is never saved or undone.
- Swift: the same saving, opening and check (`SchemeReplay(frozen:)`, `openLedger`, `runOpenedCheck`). Conformance: new `color-scheme-older-document` scenario; saved documents in the recorded scenarios gain `unloggedComplete`.
