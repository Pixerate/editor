---
'@pixerate/editor': minor
'@pixerate/editor-react': patch
'@pixerate/editor-svelte': patch
---

Effects providers can offer timing effects: a new `timing` effect kind (and `timing` use) that retimes video footage instead of drawing pixels (speed changes, ramps, reverses, freezes, echoes, long exposures). Providers set `capabilities.supportsTiming` and implement two synchronous, pure methods: `timingLength(id, footageMs, values?)`, the retimed clip's length in ms, and `timingSample(id, { time, footage, fps? }, values?)`, which returns `{ frames: [{ time, weight }], blend: 'average' | 'lighten' }`: footage frame starts held within the footage, distinct, earliest first, at most `TIMING_MAX_FRAMES` (128), weights adding up to 1. The host decodes and blends the frames; `blendTimingFrames` is the reference blend for `EffectPixels`. `normaliseTimingSample`, `timingSampleProblems`, `checkTimingRequest` and `checkTimingFootage` are new helpers, `checkEffectProvider` checks timing effects when `supportsTiming` is set, and `createFakeEffectProvider({ timing: true })` adds three. `search_effects` filters by `kind: 'timing'`; the React and Svelte effect browsers leave timing effects out unless asked for the `timing` use, and their thumbnails label them "Timing".
