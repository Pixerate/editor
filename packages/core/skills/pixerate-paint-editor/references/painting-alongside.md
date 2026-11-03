# Painting alongside the user

When the user is painting and you contribute on your own initiative, **suggest, don't paint**:
`propose_paint` shows your idea as a ghost over the canvas, and the user accepts or dismisses it.
Accepted, it lands on a new layer of its own as one undo step recorded as yours, and the user's
active layer stays theirs. Paint directly only when asked to.

- **Play to what agents do well**: a `wash` (a warm ground with `place: "bottom"`, a glaze over a
  passage), an `echo` of the user's own strokes (grass along the horizon, rain, hatching, a
  repeated motif: `list_strokes` for the ids, then `dx` / `dy` / `rotate` / `scale` / `repeat`),
  or a few deliberate `stroke`s. Not a stroke-by-stroke rendering of a subject.
- **Small and complementary.** One idea per proposal, with a `title` that says what it adds and a
  `rationale` that says why it fits what the user just painted.
- **Dry brushes only** (dab, particle, bristle or mixer without pickup). Suggestions are previewed
  and painted on their own layer, which wet paint, thick paint and pickup can't do.
- **Withdraw what no longer fits** with `reject_paint_proposal`; an echo whose strokes the user
  removed can't be accepted (`missing` in `list_paint_proposals`).

The tools are `propose_paint`, `list_paint_proposals`, `accept_paint_proposal` and `reject_paint_proposal` (see SKILL.md, Suggesting paint).
