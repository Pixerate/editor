# Vortex paint

Vortex paint (`marks.kind: "vortex"`, engine `vortex`; wet preset `wet-vortex` with `behaviour.surface: "wet"`) turns the stroke you draw into the shape of a vortex that pulls in and winds the surrounding paint around it when the stroke ends.

- **Shape from the stroke.** Every stroke is classified from its smoothed path into one of three shapes (reported in `paint_stroke` / `stroke_path` as `vortex.shape`):
  - `point`: a tap or tiny mark (path length within a tip diameter) creates a round whirlpool around the point.
  - `open`: a line, curve or squiggle creates a racetrack flow that wraps around both sides and both ends of the stroke.
  - `closed`: a stroke ending within a tip diameter of its start (and not self-crossing like a figure of eight) creates a closed-loop vortex where the signed distance inside is negative, so paint inside and outside winds coherently around the outline.
- **Flow and displacement.** A coarse Euclidean distance field $d$ is computed around the stroke (signed for closed loops) and lightly smoothed. The velocity combines a Lamb-Oseen tangential spin profile $(1 - e^{-d^2 / r_c^2}) / d$ (faded where $|\nabla d|$ collapses at the medial axis of a loop and windowed smoothly to zero at `reach`) with an inward radial pull $-\text{pull} \cdot \nabla d$. Fixed sub-steps integrate the velocity into a single backward displacement field $\mathbf{D}(\mathbf{x})$, and the pre-stroke layer is resampled **once** using premultiplied bilinear sampling so repeated turns never blur the image.
- **Settings (`marks` when `kind: "vortex"`):**
  - `reach` (`1..8`, default `3`): how far the vortex pulls from the stroke, in multiples of the tip radius (scaled locally by pen pressure when `dynamics.sizePressure > 0`).
  - `turns` (`0.25..6`, default `1.5`): how far paint winds around the shape, in full turns.
  - `pull` (`0..1`, default `0.3`): how strongly paint is drawn inward toward the stroke spine.
  - `direction` (`"follow" | "cw" | "ccw"`, default `"follow"`): `"follow"` winds closed loops in the direction they were drawn and open strokes/taps clockwise; `"cw"` and `"ccw"` force clockwise or counter-clockwise spin. Mirrored symmetry copies and `replay_strokes { flipX: true }` automatically invert spin direction.
  - `ink` (`0..1`, default `0`): how much of the brush's own paint colour is laid along the stroke before the warp, so the colour winds into the surrounding paint (`0` is colourless and only moves existing paint).
  - `duration` (`0..3`, default `1.2` s): how long the visual winding animation takes on screen (`0` shows the final state at once; committed pixels and headless tool calls are immediate).
- **Channels moved together.** On dry layers, the same displacement field warps the layer's RGBA pixels, impasto `height` and `material` (`doc.thick`, using nearest sampling for material so `A = 0` stays "no material"), `light`, `ferro`, `fluor` and `thermo` channels together.
- **Wet paint.** Using a vortex brush on a wet layer (or painting with `wet-vortex`) swirls the fluid simulation (`WetWorld.swirl`) instead of drying the layer first, injecting the vortex velocity field and lightly lifting settled pigment so the wet wash keeps spinning as the fluid advances (`advance_wet_paint`).
- **Built-in presets:**
  - `vortex`: colourless dry vortex (`reach: 3`, `turns: 1.5`, `pull: 0.3`, `ink: 0`).
  - `ink-vortex`: lays paint colour along the stroke before winding (`ink: 0.75`).
  - `whirlpool`: strong inward pull (`reach: 4`, `turns: 2`, `pull: 0.65`).
  - `wet-vortex`: swirls wet watercolour/gouache/oil fluid (`behaviour.surface: "wet"`).
- **Refusals.** Stroke layers (`add_layer { type: "strokes" }`) refuse vortex brushes because each vortex warps the layer's pixels in place. A colourless vortex (`ink: 0`) over bare canvas makes no change and returns `strokeId: null`.
