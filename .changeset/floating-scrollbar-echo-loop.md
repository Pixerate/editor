---
'@pixerate/editor-svelte': patch
---

Fix `FloatingHorizontalScrollbar` cancelling smooth scrolls on its target. The bar mirrored the target's position into itself, but its guard flag cleared in `requestAnimationFrame` before the bar's own scroll event arrived. That late event then wrote the stale position back onto the target, which stopped a smooth `scrollTo` after its first frame. The bar now ignores scroll events that only echo the position it mirrored.
