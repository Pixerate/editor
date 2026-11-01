---
name: pixerate-generation-budgeted-batch
description: The budgeted generation workflow with Pixerate's AI generation tools - choosing a model that supports the format, planning and estimating before spending, getting approval for cost, drafting cheap and finishing expensive, generating once with an idempotency key, retrying safely, reviewing results, and redoing or varying an earlier generation from the history. Use when asked to generate, render or create images, video, audio or text with AI, make several options or variations, work within a budget or quota, redo or vary an earlier result, or batch generations, or when plan_generation, estimate_generation, generate or vary_generation are available. Load with pixerate-generation, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-generation
---

# Generating within a budget

Generation costs money and cannot be undone, so every spend is planned: a model that supports
what the deliverable needs, a request the planner accepts without silent changes, an estimate
the user has agreed to, then one `generate` with an idempotency key. Explore at low cost, and
spend on quality only for the result that will be used.

This skill is the method. `pixerate-generation` has the full tool reference and request fields.

## Goal and quality bar

- The model supports the deliverable as asked (aspect ratio, resolution, duration, references):
  `plan_generation` shows no `adjustments` that change what the user wanted.
- The cost is known before spending (`estimate_generation`) and within the user's budget or
  approved; a batch, a high count, long video or the top quality tier is always confirmed.
- Exactly the generations intended: one `generate` per intended result, each with its own
  `idempotencyKey`; a retry reuses the key.
- Drafts are cheap (low `quality`, small `resolution`, several in one request with `count`);
  finals are at the quality the use needs.
- Redos and variations start from the history (`vary_generation`, `recreate_generation`) so
  prompt, seed and settings carry over.

## Inputs to confirm

- **The deliverable:** where it will be used (banner 16:9, story 9:16, thumbnail 1:1), how many
  results, the medium.
- **Budget** or quota, and whether drafts or finals are wanted.
- **References** (style, character, start frame) and how strictly they must be followed.

## Working method

1. **Discover.** `list_models` (with `media`), and read each candidate's `requestSchema`.
   **Check:** at least one model supports the format and references; pick it by schema, never
   by name.
2. **Plan.** `plan_generation` with the request; read every `adjustments` and `errors` entry.
   Use `strategy: "error"` (or `upgrade`) when exact settings matter.
   **Check:** `ok: true` and no adjustment that changes the deliverable; otherwise another model.
3. **Estimate.** `estimate_generation` with the same arguments; compare alternatives (fewer
   outputs, lower quality, smaller size) against the budget.
   **Check:** the cost fits the budget, or the user has approved it.
4. **Generate once.** `generate` with the same `model`, `request`, `strategy` and a fresh,
   descriptive `idempotencyKey`. On a timeout or transport error, call again with the identical
   arguments and the same key.
   **Check:** `list_generations` shows one new record per intended result.
5. **Review** the results with the user; keep the chosen one's id.
6. **Finish or vary.** For the final or a variation, `vary_generation` (or `recreate_generation`)
   from the chosen record with only the changed `settings`; read `drift`; then estimate and
   generate as above.

## Decision table

| Situation | Approach |
| --- | --- |
| A format only some models support | `list_models`, choose by `requestSchema`, plan with `strategy: "error"` |
| Several options to choose from | One request with `count`, low `quality` |
| Tight budget | Estimate alternatives; drafts low, one final high |
| A result to redo exactly | `recreate_generation`, then `generate` |
| The same result in another format or size | `vary_generation` with `settings` |
| A timeout or network error | Retry with identical arguments and the same key |
| A planner adjustment that changes the brief | Another model, or ask the user |

## Recipes

**One 16:9 banner.** `list_models` → `plan_generation` `{ model, request: { prompt,
aspectRatio: "16:9", count: 1 } }` → `estimate_generation` → `generate` with `strategy:
"error"` and `idempotencyKey: "banner-lighthouse-1"`.

**Four drafts under $1.** `estimate_generation` at `quality: "high"` and `"low"` with `count: 4`
→ pick the one within budget → one `generate`.

**The last image, wider.** `list_generations` → `vary_generation` `{ id, settings: {
aspectRatio: "16:9" } }` → `generate` with the returned `model` and `request`.

## Pitfalls

- **Generating to find out what a model supports.** Plan and estimate are free; generate is not.
- **Silent adjustments** with `nearest`: a different aspect ratio or a dropped reference; read
  `adjustments` before spending.
- **A new key on retry** pays twice; reuse the key for the same generation.
- **Separate calls for options** that one request with `count` would make more cheaply.
- **Finals at draft quality**, or drafts at final quality; match quality to the stage.
- **Rewriting a prompt by hand** to redo a result loses seed and settings; vary from the history.

## Tools used

- `list_models`: models and their request schemas
- `plan_generation`: check a request and read adjustments
- `estimate_generation`: cost and time before spending
- `generate`: the one paid call, with an idempotency key
- `list_generations`, `get_generation`: the history and a record's details
- `vary_generation`, `recreate_generation`: redo or vary an earlier result
