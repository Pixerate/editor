# Mutation paint (`mutation` facet)

Mutation paint is an exchange between the person at the canvas and an agent. The user paints one or more strokes with a `mutation` brush (`mutation-wash` for wet watercolour, `mutation-ink` for dry ink, or any brush with a `mutation` facet) and pauses. After `settle` seconds (default 1.5 s), those strokes form one pending **mutation** (`m1`, `m2`, …). When an agent claims it with `read_mutation`, the user's paint sinks away into the paper over `fade` seconds (default 2 s) and the agent paints its own answer back with `answer_mutation`.

If no agent claims the mutation before `patience` seconds (default 45 s), or an agent calls `decline_mutation`, nothing is lost: the user's strokes stay on the canvas as ordinary paint.

## Facet settings

| Facet path | Engine path | Range | Default | Meaning |
| --- | --- | --- | --- | --- |
| `mutation.settle` | `mutation.settle` | `0.5..10` s | `1.5` | Seconds after the user's last mutation stroke before the mutation is ready to claim |
| `mutation.patience` | `mutation.patience` | `5..300` s | `45` | Seconds to wait for an agent to claim the mutation before keeping the paint as ordinary paint |
| `mutation.fade` | `mutation.fade` | `0.5..10` s | `2` | Seconds the user's paint takes to sink away once claimed |

## How wet and dry mutation strokes work

- **Wet mutation strokes (`mutation-wash`):** Under the hood, a wet mutation brush is a ghost brush (`ghost.trigger: "agent"`, `ghost.linger: mutation.fade`). While the mutation is waiting to be claimed, the layer's evaporation is held at `0` so the wash stays wet even if the model takes several seconds to reply. When `read_mutation` claims it, evaporation is restored and the ghost fade is released: the user's pigment subtracts away over `fade` seconds while any smear it made in existing wet or dry paint remains. If unclaimed or declined, `keepGhost` drops the ghost tracer without subtracting pigment, so the wash dries and bakes as ordinary watercolour.
- **Dry mutation strokes (`mutation-ink`):** Dry paint cannot be subtracted from a layer after other paint lands on it, so dry mutation strokes are routed to a hidden temporary pixel layer named `"Mutation"` directly above the active layer (`activeLayerId` stays on the target layer). When `read_mutation` claims it, the temporary layer's opacity fades to `0` over `fade` seconds and the layer (along with its recorded strokes) is silently removed without adding an undo step. If unclaimed, declined, or saved before claim, the temporary layer merges down into the target layer.

## The agent exchange (`pixerate-paint-mutation`)

1. **Discover (`list_mutations`):** Lists pending mutations (`id`, `layerId`, `medium`, `bounds`, `age`, `state`, `strokes`).
2. **Claim and inspect (`read_mutation`):** Claims `id` (starting its fade immediately) and returns the user's strokes (points, colour, brush), a PNG crop around them (`cropPng`), and a whole-canvas preview (`canvasPng`). Refuses if another agent already claimed it.
3. **Answer (`answer_mutation`):** Paints the agent's response (`id`, `strokes`, optional `layerId` and `note`). Strokes use the same shape as `propose_paint` / `PaintAgentCommand` (`brush`, `color`, `points`) and run through `PaintDirector` so the user watches the agent's cursor paint live. Commits as one undo step with origin `agent:<id>`. Refuses a second answer to the same `id`.
4. **Decline (`decline_mutation`):** Releases the mutation without answering so the user's paint stays as ordinary paint.
