# Brush drafting evals

How good is a model at designing **new brushes** in the Pixerate brush library? This package gives a model the brush tools and the shipped brush skills, asks it to make a brush of each type, either **from scratch** (a request in a person's words) or **from reference** (the sample stroke of a built-in preset it can't see), then checks, draws and grades what it saved.

It is a private workspace package, not published: `@pixerate/editor` keeps its rule of no LLM vendor dependencies, and only this package (and the core's own tool-selection eval) depends on `@anthropic-ai/sdk`.

## Running it

Needs Node 24.2 or newer (it runs its TypeScript directly) and `pnpm build` at the repo root first (it uses the built `@pixerate/editor`). Strokes are drawn by the library's own renderers in Node, so no browser is needed.

```bash
cd packages/evals
node src/cli.ts --list                                               # the tasks
node src/cli.ts --model oracle                                       # the graders' ceiling, no model calls
node src/cli.ts --model anthropic:claude-opus-5-5 --judge anthropic:claude-opus-5-5
node src/cli.ts --model anthropic:claude-sonnet-5-5?effort=high --mode reference --samples 3
node src/cli.ts --model anthropic:claude-opus-5-5 --type wet,glow --host vector --turns 12
```

Each run writes `results/<time>-<model>/`:

- `report.md`: scores overall, by mode, by host, by type and by task, the commonest failed checks, which tools were called, the judge's notes and any errors.
- `results.json`: every sample's checks, scores, judge grades, tool use, tokens and timings.
- `samples/<task>/<n>/`: the saved brush (`brush.json`), its stroke (`stroke.png`) and `transcript.md`, every tool call and result.
- `references/<task>/reference.png`: the stroke the model was shown.
- `answers/`: every model answer by key, so `--model replay:<run>/answers` (and `--judge replay:…`) re-grades a run without calling a model.

A sample that ended in an error (a dropped connection, a rate limit that outlasted the retries) can be rerun on its own: `--out <run> --redo-errors` with the run's `--model` and `--judge`.

Model calls cost money: a full run is 35 tasks × samples × several turns (each turn resends the conversation, though the system prompt and tools are cached on the Claude API), plus one judge call per sample. Start with `--task` or `--type` and one sample.

### Models

| Spec | What it is |
| --- | --- |
| `anthropic:<model>[?effort=…]` | The Claude API, through `@anthropic-ai/sdk` (credentials from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile). |
| `command:<shell command>` | Any other model: the command reads the request as JSON on stdin (`{ key, system, tools, messages, schema }`; images as base64 PNG; tool calls and results as parts) and prints a `#pixerate-eval-response` envelope (`{ text, toolCalls, usage, stop }`). |
| `replay:<folder>` | Answers saved by an earlier run. |
| `oracle` | Known-good answers: a scratch task's `solution`, or a reference task's held-out preset remade under the task's id. Use it after changing a grader or a task. |

## Comparing models

Run the same tasks, samples and judge for each model, then put the runs side by side:

```bash
node src/cli.ts --model anthropic:claude-opus-5-5 --judge anthropic:claude-opus-5-5 --samples 3 --out results/opus
node src/cli.ts --model "command:node src/adapters/gemini.ts gemini-4-hydrogen" --judge anthropic:claude-opus-5-5 --samples 3 --out results/gemini
node src/compare.ts results/opus results/gemini --out results/opus-vs-gemini.md
```

`src/adapters/gemini.ts` calls the Gemini API with `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or without a key Vertex AI with Application Default Credentials (`gcloud auth application-default login`; `GOOGLE_CLOUD_PROJECT` defaults to gcloud's project, `GOOGLE_CLOUD_LOCATION` to `global`), over plain HTTPS, so no Google SDK is installed. It sends the tools as function declarations, hands each function call's thought signature back on the next turn, puts images a tool returned after its function response, retries rate limits, and exits 3 (stopping the run) on a bad key or unknown model. Write an adapter like it for any other vendor.

The comparison shows the score and first-try rate overall, by mode, by host, by type and by task, the change between the runs, and which tasks each model did better on. It warns when the judges differ, and when a model judged its own brushes: models tend to favour their own work, so re-judge both runs with another model before trusting a close result. Re-judging needs no new drafts:

```bash
node src/cli.ts --model replay:results/opus/answers --judge "command:node src/adapters/gemini.ts gemini-4-hydrogen" --samples 3 --out results/opus-gemini-judged
```

## What it measures

**The prompt.** The system prompt is the `pixerate-brushes` and `pixerate-brushes-design` skills exactly as shipped (`packages/core/skills`), plus a line saying the job ends when the brush is saved and previewed. So the eval measures the model *and* the docs agents get; a change to a skill shows up here.

**The tools.** Each sample gets a fresh brush library and the brush tools for its host's profile (`list_brush_presets`, `describe_brush`, `create_brush`, `update_brush`, `check_brush`, `preview_brush`, …), exactly as an app registers them; `preview_brush` returns an image the model sees. Tools that import files (`import_brushes`, `import_brush_pack`, `add_brush_source`) are withheld, as no task gives it a file. Tool errors go back to the model as tool errors. The model works until it stops calling tools (at most `--turns`); if it stops without saving the brush it is told so once, as a person would.

**Types.** The paint families `describe_brush` reports (`dry`, `ink`, `wet`, `thick`, `metallic`, `spray`, `glow`, `iridescent`, `strands`, `stickers`, `living`, `ethereal`, `volatile`, `reactive`) and `tool` (smudge, blender, eraser…). **Hosts:** most tasks are for the paint editor, which renders everything; some are for the image editor, canvas strokes and vector strokes, which render less, so the model has to pick a brush the host accepts.

**Reference tasks** hold a built-in preset out of the library, so it can be neither listed nor based on, and show the model only its sample stroke (512 × 160, as `preview_brush` draws it). Where a still stroke can't show what a brush does (paint that fades, grows a pattern or acts like a magnetic liquid), a sentence says so. The model is told the colour the stroke was drawn in, and whether it is the preset's own default or only `preview_brush`'s fallback for its medium (a brush with no colour of its own paints in the person's colour, so it should leave `colour.default` unset).

**Scores**, 0–100 per sample:

| Area | Weight | What |
| --- | ---: | --- |
| Valid | 15% | The brush is saved under the task's id, and `check_brush` says the host can paint it. A sample that saved nothing scores 0. |
| As asked | 25% | It files under the task's type (`describe_brush`'s `family`, or `kind: tool`), and what the request plainly asks for (`checks`: the medium, the surface, grain, a colour, a light, a vortex…). On reference tasks: the same kind, medium, surface and marks as the held-out preset, the same kind of tip (an ellipse, bristles or a stamp: `round`, `flat` and `chisel` are one ellipse, named for people) and a roundness within 0.3. |
| Paints | 15% | Its stroke is not blank. A brush that paints nothing scores at most 20. |
| Look | 45% | The judge's grade (it is told what the host ignores, such as paper grain in the image editor, the colour each stroke was drawn in, and when a colour is only the preview's fallback; fidelity counts double, then medium, craft and settings, each 1–5) of the stroke and the brush's settings. On reference tasks without a judge, stroke similarity to the reference (coverage 30%, colour 35%, placement 35%); with both, judge 30% and similarity 15%. Without a judge, scratch tasks are scored on the other areas only. |

*First try* is the share of samples that saved the brush without any write tool being refused on the way.

Strokes are drawn by the host's own `preview_brush` renderer, as apps register it (`renderCanvasBrushPreview` for canvas, `renderVectorBrushPreview` for vector, the paint engine otherwise). If it ever refuses a brush, the paint engine draws the graded stroke and `stroke-note.txt` says so.

Stroke similarity is rough: it rewards the right width, colour and spread, not the right texture, and two soft wide brushes (an airbrush and a wash) look alike to it. Use a judge for anything you will act on; `--model oracle` scores 100 on every task, which shows the graders' ceiling.

## Tasks

`src/tasks.ts` holds 19 scratch tasks (every type, every host) and 16 reference tasks (every type but `metallic`, which has one preset). Each scratch task has a `solution`, which the oracle replays and the tests prove against its checks.

Your own tasks go in a JSON file, used with `--tasks <file>` instead of the built-in ones; see `tasks/custom.example.json`. A task has an `id`, a `type`, a `host` (default `paint`), a `brushId` to save under (default `my-brush`), and either a `brief` with optional `checks` (`{ why, expect }`, matched against `describe_brush`'s result with the skill evals' matcher: `$min`, `$max`, `$expr`, `$type`…) or a `reference: { "preset": "<built-in id>" }`.

## Changing it

`pnpm --filter @pixerate/editor-evals test` runs the harness's own tests (no model calls): every scratch solution passes its checks, the oracle scores 100, a brush from the wrong preset scores lower, the reminder, tool errors, replay, the adapters' wire formats and the reports. Run `--model oracle` after changing a grader or a task, and say in your PR what a live run showed.
