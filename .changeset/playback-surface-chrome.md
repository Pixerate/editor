---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

App chrome on canvas and element playback surfaces. `useCanvasPlaybackSurface` / `createCanvasPlaybackSurface` and `useElementPlaybackSurface` / `createElementPlaybackSurface` take `locate(ref)` (a rectangle in surface coordinates), `locateElement(ref)` (an element anywhere on the page, whose client box is mapped into surface coordinates through the surface's `fromViewport`) and `open(ref)`, so a host's HUD, toolbar or panels can answer `{ kind: 'panel' | 'control', id }` refs and open steps. The surface's own locator runs first; the element surface's `selectors` are now optional. `usePlaybackSurface` / `createPlaybackSurface` define `open` on the attached surface only when the options give one, so `AgentPlayback` skips `open` steps on surfaces that can't open anything instead of clicking nothing and waiting 220 ms. Core adds `PlaybackChromeOptions`, `PlaybackClientRect`, `playbackRectFromClient` and `locatePlaybackChrome` to `@pixerate/editor/tools`.
