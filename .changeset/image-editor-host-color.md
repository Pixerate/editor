---
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Image editor panels take the host's own colour control. `ImageEditorControls` gains `Color` (`ImageColorProps`: `value`, `label`, `alpha`, `disabled`, `onChange`/`oninput`, `onStart`/`onEnd`), used for every colour well in the image editor (brush FG / BG, shape fill and stroke, text colour, layer-effect colours, photo filter and black & white tint, annotation colour); without one they stay native colour inputs. Parameter panels gain a matching `color` slot (`ParameterColorProps`), and `imageEditorParameterComponents` maps the host's `Color` to it, so effect-parameter colours use the host's picker too.
