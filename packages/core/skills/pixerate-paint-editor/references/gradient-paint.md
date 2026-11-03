# Gradient paint

Paint that changes colour as the stroke goes: give a gradient where a colour would go.

1. **`set_paint`** with `{ type: "gradient", stops, map }` makes it the paint for every following
   stroke (`set_color` goes back to one colour); `paint_stroke` `paint` overrides it for one stroke;
   a brush can carry its own (`set_brush` `paint`, presets `gradient-round`, `pressure-ombre`,
   `rainbow-marker`, `gradient-wash`).
2. **Choose the mapping by what the stroke should do**: `distance` (default, 300 px then
   `mirror` back) for "drag it out" colour; `pressure` for light-to-heavy shading in one stroke;
   `direction` for strokes coloured by their heading; `across-tip` for a brush loaded with several
   colours side by side; `random` (`every` dabs) for speckled or confetti colour; `time` and
   `velocity` need timed points (`t`). Set `length` to about the stroke length you will paint.
3. **Stops**: 2..16, sorted by `offset`; `"paint"` / `"secondary"` follow the two editor colours;
   `opacity` multiplies flow (fade a stroke out); `midpoint` shifts where two colours meet;
   `softness` 0 makes hard bands. `space` `pigment` (default) mixes like paint (blue to yellow
   through green), `oklab` keeps rainbows bright.
4. **It works with every colour engine**: dab, Mixer Brush (each dab reloads its reservoir),
   watercolour and gouache (each deposit carries its pigment into the wet layer, which then flows
   and mixes), oil and impasto (the colour varies along the relief), particles, bristles and
   stickers. Erasers, blenders and smudges ignore it; the eyedropper picks one colour.
5. Strokes record the gradient (with concrete colours), so replays, time-lapses, high-res
   re-renders and drying are exact. `get_brush` `strokePaint` says what the next stroke paints.
