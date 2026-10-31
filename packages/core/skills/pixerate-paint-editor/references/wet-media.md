# Wet media

1. **Choose a watercolour paper** (`cold-pressed`, `rough-watercolor` for granulation and broken
   edges, `hot-pressed` for smooth washes). Absorption, permeability and roughness of the paper
   drive the simulation.
2. **Plan light to dark.** Watercolour is transparent: you cannot paint light over dark (use
   `gouache`, body 1, for that). Lay the lightest washes first.
3. **Wet-in-wet or wet-on-dry.** `wet_paper` over an area first for soft, feathered, blooming
   colour (skies, backgrounds); paint on dry paper for crisp edges with a darker rim.
4. **Paint washes** with `watercolor-wash` (large, flat, very wet) in a few long strokes, then
   shapes with `watercolor-round`, details with `watercolor-detail`. Colours touching while wet
   bleed into each other; that is the point.
5. **Let it flow, then dry.** `advance_wet_paint` (`seconds` 1..5) to let water spread, run and
   bloom; `render_preview` shows the paint as it is now (wet paper looks a little darker).
   `dry_paint` sets it where it is. Dry before glazing a second wash over a first, or the two
   mix instead of layering.
6. **Steer the water** with the wet tools: `add-water` (softens and lifts with `rewet`),
   `hair-dryer` (stops a wash spreading), `blow` (pushes the water along the stroke),
   `wet-blend` (evens out a wash), `wet-drag` (drags wet paint), `blot` (lifts wet paint: clouds,
   highlights). `set_canvas_tilt` makes washes run downhill and very wet paint drip;
   `set_flow_map` pushes water in a swirl, a direction or eddies.
7. **Tune the medium** per layer with `set_wet_settings`: `granulation` (grainy pigment, needs a
   rough paper), `edgeDarkening`, `bloom`, `bleed`, `viscosity` (runny .. thick), `evaporation`,
   `pigmentWeight`, `pickup` (how easily dried paint lifts), `fixture` (staining).

- **Saving dries the paint** (deterministically): the saved file and every export hold dried
  pixels; the editor keeps painting wet. A dry brush, fill, merge or duplicate on a wet layer
  dries it first (in the same undo step).
- **Time** runs by itself in an editor on screen (`pause_wet_paint` stops it); for an agent with
  no screen, nothing moves until `advance_wet_paint` or `dry_paint`.
- **The GPU only draws.** With WebGPU and a large wet area (16 tiles of 256 px by default), Engine B
  shades the wet paint on the GPU; the CPU engine still computes every step, so the painting,
  `dry_paint`, saving, export and replay come out the same with it on or off. `get_wet_paint`
  shows it as `engine` (`state`, `reason`). Leave it on `auto`; `set_wet_engine` with `gpu` "off"
  only when the user says the display looks wrong or the GPU is needed for something else.
