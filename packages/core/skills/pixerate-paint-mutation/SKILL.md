---
name: pixerate-paint-mutation
description: The mutation paint workflow in the Pixerate paint editor - discovering pending mutation strokes after the user pauses, claiming them with read_mutation so the user's wet or dry paint sinks into the canvas, reading the local crop and whole-canvas preview to choose a placement and medium, and painting an answering gesture back with answer_mutation or leaving the mark as ordinary paint with decline_mutation. Use when asked to answer a mutation stroke, respond to mutation paint, or when list_mutations, read_mutation, answer_mutation or decline_mutation are available. Load with pixerate-paint-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-paint-editor
---

# Answering mutation paint

With a `mutation` brush (`mutation-wash` for wet watercolour, `mutation-ink` for dry ink, or any brush with a `mutation` facet), the user paints a mark and pauses. Once `settle` seconds pass, the strokes form a pending **mutation**. Claiming it with `read_mutation` starts the fade so the user's paint sinks away into the paper while you read it; `answer_mutation` then sends your cursor onto the canvas to paint an answer back as a single undo step. If you decline with `decline_mutation` (or never claim it), the user's paint stays as ordinary paint.

This skill is the method. `pixerate-paint-editor` has the full tool reference and `references/mutation.md` the facet details.

## Goal and quality bar

- Every pending mutation you handle is either claimed (`read_mutation`) and answered (`answer_mutation`) or explicitly left as ordinary paint (`decline_mutation`), leaving `list_mutations` empty (`mutations` length 0).
- You always call `read_mutation` before `answer_mutation` so the fade begins and you see both the stroke crop and the whole canvas.
- The answer reinterprets or converses with the user's mark rather than tracing its exact points, and commits as one undo step.
- Because the user is watching the canvas while their stroke sinks away, keep your tool sequence short and direct.

## Inputs to confirm

Ask only when the host task is ambiguous; otherwise act immediately because the person is watching the canvas.

- **Whether to answer or keep the mark:** answer with `read_mutation` followed by `answer_mutation` by default; call `decline_mutation` when the mark should stay untouched as ordinary paint.
- **Where and how to answer:** read `canvasPng` and `cropPng` from `read_mutation` to choose the layer, brush, colour and placement yourself.

## Working method

1. **Find pending mutations.** Call `list_mutations` to see the pending mutations (`id`, `layerId`, `medium`, `bounds`, `age`, `state`, `strokes`).
   **Check:** `list_mutations` lists at least one mutation with `state` `"pending"` or `"settling"`.
2. **Claim or decline.**
   - If the mark should stay as ordinary paint without an answer, call `decline_mutation` with `id` and stop.
   - Otherwise, call `read_mutation` with `id` immediately. This claims the mutation, starts its fade (`fade` seconds), and returns the user's `strokes` (points, colour, brush), `cropPng` (around the mark) and `canvasPng` (the whole painting).
   **Check:** `read_mutation` returns `state: "claimed"`, `strokes`, `cropPng` and `canvasPng`.
3. **Plan the answer from the preview.** Inspect `strokes`, `cropPng` and `canvasPng`:
   - Notice the user's gesture (direction, rhythm, scale, colour, `medium`) and what is already on the canvas.
   - Choose where your answer belongs (near the mark, completing a form, answering across the sheet, or on a specific `layerId`), which brush and colour suit it, and a handful of expressive strokes. Reinterpret rather than copying the user's points verbatim.
4. **Paint the answer.** Call `answer_mutation` with `id`, `strokes` (each with `points`, optional `brushId`, `brush` facets and `color`), and optional `layerId` and `note`. When the stroke is wet (`medium: "wet"`), call `advance_wet_paint` afterwards if you need the fade and wet answer to settle in headless runs.
   **Check:** `answer_mutation` returns `state: "answered"` and non-empty `strokeIds`; `list_mutations` now shows no pending mutations.

## Decision table

| Situation | Approach |
| --- | --- |
| Wet mutation (`medium: "wet"`, e.g. `mutation-wash`) | `read_mutation` releases the evaporation hold and ghost fade; answer with a wet or dry brush via `answer_mutation`, then `advance_wet_paint` if waiting for the fade to finish |
| Dry mutation (`medium: "dry"`, e.g. `mutation-ink`) | `read_mutation` fades the temporary mutation layer; answer on the target layer with `answer_mutation` |
| Several pending mutations in `list_mutations` | Handle each `id` in turn (`read_mutation` then `answer_mutation`), or `decline_mutation` any you should leave as ordinary paint |
| The mark is already complete or shouldn't be taken away | Call `decline_mutation` with `id` (before `read_mutation`) so the user's paint stays on the canvas |
| Another agent already claimed the mutation | `read_mutation` refuses; skip that `id` |

## Recipes

**Answer a wet wash mutation.** `list_mutations` → `read_mutation` `{ id: "m1" }` → `answer_mutation` `{ id: "m1", strokes: [{ brushId: "watercolor-round", brush: { tip: { size: 22 } }, color: "#1f3a5f", points: [...] }] }` → `advance_wet_paint` `{ seconds: 3 }`.

**Answer a dry ink mutation.** `list_mutations` → `read_mutation` `{ id: "m1" }` → `answer_mutation` `{ id: "m1", strokes: [{ brushId: "ink-pen", brush: { tip: { size: 8 } }, color: "#1e293b", points: [...] }] }`.

**Keep a mutation as ordinary paint.** `list_mutations` → `decline_mutation` `{ id: "m1", reason: "Keep as drawn" }`.

## Pitfalls

- **Calling `answer_mutation` before `read_mutation`.** `answer_mutation` refuses unless the mutation has been claimed with `read_mutation` first.
- **Claiming when you intend to decline.** `read_mutation` starts the fade immediately; once claimed, `decline_mutation` is refused. Decide before claiming, or call `decline_mutation` directly.
- **Answering with a mutation brush.** Do not pass `mutation-wash` or `mutation-ink` as `brushId` in `answer_mutation`; use an ordinary wet or dry brush (`watercolor-round`, `ink-pen`, `pencil-hb`, `gouache`…) so the answer stays on the canvas.
- **Copying the user's stroke point-for-point.** The user's mark is a prompt or gesture that disappears; answer in your own way rather than replaying the same coordinates.
- **Taking many slow tool calls between claim and answer.** The fade starts at `read_mutation`; go straight from `read_mutation` to `answer_mutation`.

## Tools used

- `list_mutations`: list pending mutations waiting for an agent
- `read_mutation`: claim a mutation, start its fade, and inspect its strokes, local crop and canvas preview
- `answer_mutation`: paint the answering strokes as one undo step
- `decline_mutation`: leave a pending mutation on the canvas as ordinary paint
- `advance_wet_paint`, `get_wet_paint`: let wet fades and wet answers flow in headless sessions
- `get_canvas_info`, `list_layers`, `list_strokes`: check the canvas, layers and recorded strokes
