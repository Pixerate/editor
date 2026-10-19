# Animation command vocabulary

Every command is an object with a `type` and (except `wait`) `targets`: element ids from
`get_animation`. A group animates as one. Times are ms, distances document units, angles
degrees clockwise. Commands share names and defaults with Flair's motion primitives
(`get_animation` shows each command's `flairPrimitive`).

## Fields every command takes

- `targets`: element ids (at least one).
- `duration`: length per target. Leave it out: each type has a default (below) and `draw`
  follows the path length. With `repeat`, it is one cycle.
- `delay`: wait before starting (default 0).
- `stagger`: start each further target this much later (default 0).
- `with`: `"after"` (default) starts when the commands before it finish; `"previous"` starts
  together with the command before.
- `ease`: a preset (`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `ease-in-back`,
  `ease-out-back`, `ease-out-elastic`, `ease-in-elastic`, `ease-in-out-elastic`, `elastic`,
  `spring`, `spring-gentle`, `spring-quick`, `spring-bouncy`, `spring-slow`, `hold`), or
  `{ "type": "cubic-bezier", x1, y1, x2, y2 }`, `{ "type": "spring", stiffness (170),
  damping (26), mass (1), velocity (0) }`, `{ "type": "elastic", amplitude (1), period (0.3),
  mode (out | in | in-out) }`. Default: cubic ease-out for entrances, ease-in-out for moves.
  A spring with no `duration` lasts until it settles.
- `note`: why the command is there, in a few words.
- `split`: `letter`, `word` or `line` for outlined text (a group of letter paths), staggered
  40 / 120 / 300 ms per unit; `cascade`: `forward` (default), `backward`, `center`, `edges`,
  `random` (deterministic).
- `repeat` (1-1000, not for enter or exit) and `repeatMode`: `loop` (default), `mirror`
  (every other cycle backwards), `offset` (carry on: rotate by 90 with repeat 4 is a full turn).
- `steps`: hold poses on a grid of this many frames per second (12 = on twos).

## Default lengths (ms)

enter 600, exit 450, move 700 (+400 per `via` point), rotate 700, scale 500, fade 400,
style 500, morph 900, match 900, follow 1400, pulse 600, shake 500, teeter 600, wave 1000,
wiggle 1500, color-pulse 600, effect 900, play (the clip's own length). Shot hold 600,
camera move 1000.

## Entrances and exits

- `enter` brings hidden targets in. `style`:
  - `fade` (default); `pop` (scales up past full size and settles; `scale` start, default 0.5);
    `grow` (from nothing); `slide` (`direction` of travel, default up; `distance` default 40);
    `draw` (outline drawn on, then the fill fades in); `zoom` (settles from larger; `scale`
    default 1.6); `rise` (rises a short way, overshooting a touch; `distance` default 20).
  - Reveals through a clip over the target's box: `wipe` (edge travels `direction`, default
    right), `iris` (from the centre; `shape` circle or box), `split` (from a line through the
    middle; `orientation` horizontal or vertical). Need a box with width and height.
  - Drawing options for groups: `order` (`together` default, or `sequence`), `pace` (`time`
    or `speed`), `align` (`start` / `end`, with speed), `sortBy` (`document` or `distance`,
    with sequence), `origin` { x, y } for a radial reveal.
- `exit` takes targets out. `style`: `fade` (default), `shrink`, `slide` (default down,
  `distance` 40), `undraw`, `wipe`. Same drawing options as enter.

## Pose and paint

- `move`: `by` { x, y } offset or `to` { x, y } for the centre. `via`: up to 64 waypoints the
  centre passes through smoothly without overshoot; `pacing` `even` (default, steady speed)
  or `equal` (same time per stretch). `blend` default replace.
- `rotate`: `by` degrees or `to` degrees from rest. `blend` default replace.
- `scale`: `to` a factor or { x, y } (required); `geometric: true` for an even-rate zoom.
- `fade`: `to` opacity 0-1 (required).
- `style`: blends solid `fill`, `stroke` (CSS colours, mixed in OKLab) and `strokeWidth`. On a
  group it changes every path in it.
- `draw`: draws strokes to `to` (default 1) from `from` (default what is drawn now);
  `comet`: a travelling stroke this fraction long that runs off the end. Drawing options as
  enter.

## Shape change and paths

- `morph`: each target takes the shape and paint of node `into` (keep `into` hidden).
- `match` (Smart Animate): tweens a group into group `into`, part by part. Parts pair by name,
  then by id with the group ids taken out (`card-a-title` and `card-b-title`), then by kind in
  order. Unpaired parts fade out; parts of `into` with no partner never appear.
- `follow`: moves targets along path node `path` (it can be hidden), `from` / `to` fractions
  (default 0 / 1); `rotate: true` turns with the path, and moves or shakes made meanwhile turn
  with it.

## Emphasis (returns to rest; `blend` default add, so it stacks on other motion)

- `pulse`: scales up and back; `amount` extra scale (0.15), `count` (1).
- `shake`: side to side, settling; `amount` (8), `count` (3), `axis` horizontal or vertical.
- `teeter`: rocks about the centre; `angle` (8), `count` (3).
- `wave`: bobs without settling; `amount` (6), `count` (2).
- `wiggle`: smooth seeded noise; `amount` (6), `frequency` Hz (3), `octaves` (2), `rotate`
  degrees (0), `seed` (default from the target id; the same seed wanders the same way).
- `color-pulse`: tints `fill` or `stroke` (`paint`) toward `color` (default #f59e0b) and back;
  `count` (1).

`blend: "add"` on move, rotate or scale makes them a stacking layer too (what they add stays);
`blend: "replace"` on emphasis makes it take over instead.

## Other

- `effect`: tweens numeric `param` of live path effect `effect` (ids from the element's
  `effects` in `get_animation`) `to` a value.
- `play`: plays clip `clip` (defined with `set_animation_clip`, commands targeting `"$"`) on
  the targets; `speed` (0.05-20, default 1), `delay`, `stagger`, `with`. Clips cannot play clips.
- `wait`: waits `duration` ms (no targets).

## Shots

`{ id, run, label?, camera?, hold?, speed?, at? }`

- `id` matches `^[A-Za-z0-9_][\w.-]*$` and is unique.
- `camera`: `{ x, y, width, height }` or `{ frame: "<node id>", padding (24) }`, with `ms`
  (default 1000), `ease`, `geometric`. The first shot cuts to its camera.
- `hold`: ms after the commands (default 600).
- `speed`: plays the whole shot this many times as fast (0.05-20; `fit_animation` sets it).
- `at`: `{ beat: n }` (2.5 is the "and" of beat 3), `{ word: i }` or `{ ms: t }`; the shot
  before holds until the cue. Needs a `beat` grid or `narration` set with
  `set_animation_settings`; `check_animation` reports `cue-missed` when the previous shot runs
  past it.

## Drivers

`set_animation_drivers({ drivers: [{ target, property, source: { node, property }, factor (1),
offset (0), clamp: [min, max] }] })`, properties `x`, `y`, `rotation`, `scaleX`, `scaleY`,
`opacity`. The target's change from rest = source change · factor + offset, added to offsets
and turns, multiplied into scales and opacity, on top of the target's own commands. Examples:
parallax (`x` follows `x` · 0.5), a rolling wheel (`rotation` follows `x` · 360 / (2π · radius)),
a shadow that fades as a ball rises (`opacity` follows `y` · 0.005). Cycles are reported by
`check_animation` (`driver-cycle`).
