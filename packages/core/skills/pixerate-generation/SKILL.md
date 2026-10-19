---
name: pixerate-generation
description: How to generate images, video, audio or text through Pixerate's AI generation tools safely - discovering models and their request schemas with list_models, checking a request with plan_generation (aspect ratio, resolution, quality, count, duration, seed, references with roles such as start_frame, style_ref, character_ref or mask, edit and inpaint modes), estimating cost and time with estimate_generation, starting a paid generation with generate and an idempotency key so retries never bill twice, and reusing past generations from the history (list_generations, recreate_generation, vary_generation) with drift reports. Use when asked to generate, render, create or edit media with an AI model, text-to-image, image-to-video, inpainting, or when list_models or generate are available.
---

# AI generation

The generation tools front a host's model catalogue. Each model is a capability record (id,
media kind `image` / `video` / `audio` / `text`, which request fields it supports and their
options or ranges, which reference roles it accepts). A request is a plain object (`prompt`,
`aspectRatio`, `resolution`, `quality`, `count`, `duration`, `seed`, `mode`, `references`,
`params`, …); the planner checks it against the model, adjusts unsupported values per a
`strategy`, and reports every change. `generate` costs money or quota and cannot be undone.
See `pixerate-agent-tools` for errors and namespacing.

- **Model ids** come only from `list_models`. Never guess one from a brand name.
- **References** are assets the host already knows: `{ id, role, url?, mediaType?,
  contentHash? }`. Ids come from the host (an asset library, an upload, a mention in the
  prompt), never invented. Roles: `start_frame`, `end_frame`, `style_ref`, `character_ref`,
  `background_ref`, `mask`, `image_ref`, `video_ref`, `audio_ref`, plus any role a model
  declares; each model lists the roles it accepts and their min/max counts.

## Working method

1. **Discover.** `list_models` (filter with `media`) and read each candidate's `requestSchema`:
   supported fields, enum options, ranges, prompt limits, reference roles.
2. **Plan.** Build the request from the user's intent and call `plan_generation`. Read every
   `adjustments` entry (`field`, `from`, `to`, `kind`, `reason`) and every `errors` entry. If
   an adjustment changes what the user asked for (a different aspect ratio, a dropped
   reference, fewer outputs), choose another model or tell the user before going on.
3. **Estimate.** When `estimate_generation` is offered, call it with the same arguments. Report
   the cost and time to the user and get confirmation when it is significant, when the user has
   not already agreed to spend, or for any batch, high count, long video or top quality tier.
4. **Generate once.** Call `generate` with the same `model`, `request`, `strategy` and a fresh
   `idempotencyKey`. Return what it returns (typically a job id inside `result`) to the user.
5. **On a timeout or transport error,** retry with the identical arguments and the same key.
   Only change the key when you intend a new, separate generation.

To redo or vary an earlier result ("make that one again", "same but wider", "another take"),
find it with `list_generations`, inspect it with `get_generation`, and build the request with
`recreate_generation` or `vary_generation`. They return `model` and `request` ready for
`generate`, plus `drift`: tell the user about every `warning` or `error` item (an edited
template, a model that changed, a missing reference) before spending. Then continue from step 3.

## Best practices

- **Plan before you pay.** `plan_generation` and `estimate_generation` are free and read-only;
  `generate` is not. Never call `generate` to discover what a model supports.
- **Pick the strategy deliberately.** `nearest` (default) snaps and clamps, ties up, and may
  drop unsupported references; `downgrade` ties down (cheaper, smaller); `upgrade` never drops
  references, so a lost reference becomes an error; `error` changes nothing and fails on any
  mismatch. Use `error` or `upgrade` when exact settings or every reference matter (brand
  work, a required start frame); use `nearest` for exploration.
- **Write prompts for the medium.** Subject, then setting, composition and framing, lighting,
  style and lens or medium; for video add camera motion and action over time. Put exclusions
  in `negativePrompt` only when the model supports it (its schema says so). Keep the prompt
  within the model's limit as resolved, not as written (see Pitfalls).
- **Match the deliverable.** Choose `aspectRatio` and `resolution` for where the result will be
  used (16:9 video, 9:16 stories, 1:1 thumbnails, 4:5 feeds) rather than cropping later.
- **Explore cheap, finish expensive.** Draft at a low `quality` or `resolution` and small
  `count`, then re-run the chosen direction at full quality with the same `seed` (when the
  model supports seeds) for a closer match.
- **Batch sensibly.** Prefer one request with `count: n` over n requests when the model
  supports it. For genuinely different requests, give each its own key and estimate the total
  first. Do not fan out dozens of paid calls without the user's go-ahead.
- **Pass references with the right role.** A start frame for image-to-video as `start_frame`,
  a look to copy as `style_ref`, a person or product to keep consistent as `character_ref`.
  Editing needs `mode: "edit"` and a model with editing; inpainting needs `mode: "inpaint"`
  plus a `mask` reference.
- **Keep provenance.** Record the model id, the planned request and seed the tools returned,
  so the user can reproduce or vary a result.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `list_models` | List available models: `id`, `media`, optional `name`, `description`, `badges`, and the `requestSchema` (JSON Schema of the request fields, options, ranges and reference roles it accepts). Optional `media` filter: image, video, audio or text. Call first; the list can change while you work. |
| `plan_generation` | Check a request without generating. Takes `model`, `request`, optional `strategy` (nearest default, upgrade, downgrade, error) and `resolvedPrompt`. Returns `plan`: `ok`, the adjusted `request`, `adjustments` (snapped, clamped, truncated, dropped, defaulted, each with a reason) and `errors`. Fix every error before estimating or generating. |
| `list_generations` | Find past generations (newest first): id, model, kind (generate, recreate, variation), parent, time, templates, assets and a 160-character prompt preview. Filter by `model`, `template`, `text`, `kind` or `parentId`; page with `limit` (default 20, max 100) and `offset`. Returns `total` too. |
| `get_generation` | Read one record by `id`: raw and resolved prompt, the settings as the user set them, strategy, the seed used, assets, templates and parent. Use it to answer what was used, or before a recreate. |
| `recreate_generation` | Build (not run) the request that reproduces a record. `mode` `exact` (default) keeps the recorded prompt and settings; `latest` uses current templates and re-plans for the current model. Returns `ok`, `model`, `request`, `resolvedPrompt`, `drift` and any `planErrors`. Pass `model` and `request` to `generate` with a new key. |
| `vary_generation` | Build (not run) a variation: the same prompt, settings and assets with a new `seed` (random unless given, `null` for none), `values` for prompt variables, `settings` merged over the recorded ones, or a new `rawPrompt`. Same result shape as `recreate_generation`. |
| `estimate_generation` | Get the host's cost and/or time estimate for the planned request (same arguments as `plan_generation`). Returns `plan` and `estimate`; nothing is generated. Only present when the host provides estimates; when it is missing, say you cannot quote a cost. A request that fails planning returns an `isError` result with code `plan_failed`. |

### Write

| Tool | Use it to |
| --- | --- |
| `generate` | Plan and start a generation (paid, irreversible). Takes `model`, `request`, optional `strategy` and `resolvedPrompt`, and a required `idempotencyKey` (1..200 chars, unique per intended generation). Returns `result` (the host's value, e.g. a job id), the `plan` actually sent and the key; a retry with the same key and arguments returns the first result with `deduplicated: true`. Planning errors return `plan_failed` and generate nothing. |

## Pitfalls

- **Idempotency keys:** the same key with different arguments is rejected ("already used with
  different arguments"); use a new key for a new generation. A failed call forgets its key, so
  retrying a failure with the same key does generate. Never reuse a key to "regenerate" or to
  get a variation: that returns the old result.
- **Templates:** when `request.prompt` contains template variables, pass the expanded text as
  `resolvedPrompt`. Limits count the resolved text; when it is over the limit the plan errors
  under every strategy and the prompt is not truncated. Shorten the resolved prompt yourself.
- **Read adjustments, not just `ok`.** `ok: true` under `nearest` can still mean a reference was
  dropped or the count reduced. Compare the adjusted request with what the user asked for.
- **Unknown model:** a model id not in the current catalogue fails validation; call
  `list_models` again (the catalogue may have changed) instead of retrying the same id.
- `generate` only starts the job; the result may be a job id rather than media. Do not call it
  again to "check" progress; that is a new paid request unless the key and arguments match.
- `idempotencyKey` belongs only on `generate`; `plan_generation` and `estimate_generation`
  reject it as an unknown argument.
