# Agent skills

Each editor domain in `@pixerate/editor` ships an [Agent Skill](https://agentskills.io): a
`SKILL.md` that teaches a model when and how to use that domain's tools, and the practice an
expert in the domain would follow. They are published with the package, so an app or agent
that uses the tools can load the matching skill.

## Reference skills

One per editor domain. A reference skill owns its domain's tool and command tables, its mental
model and its general practice.

| Skill | Covers |
| --- | --- |
| [`pixerate-agent-tools`](pixerate-agent-tools/SKILL.md) | What every editor has in common: the MCP bridge, toolsets and tool naming, finding tools with `list_toolsets` / `search_tools` / `enable_tools` / `get_skill`, `list_commands` / `run_command` / `run_commands`, errors, undo. Load it with any domain skill. |
| [`pixerate-rich-text`](pixerate-rich-text/SKILL.md) | Documents and prompts: text, tables, find and replace, charts in documents, prompt variables. |
| [`pixerate-spreadsheet`](pixerate-spreadsheet/SKILL.md) | Cells, ranges, rows and columns, filters, merges. |
| [`pixerate-canvas`](pixerate-canvas/SKILL.md) | Node-graph canvas, components and variants, arranging, shape booleans, keyframe animation. |
| [`pixerate-vector`](pixerate-vector/SKILL.md) | Vector paths, styles, gradients, effects, blends, Pathfinder, SVG. |
| [`pixerate-chart`](pixerate-chart/SKILL.md) | Chart specs, data, series, presets, trendlines, Office and Mermaid charts. |
| [`pixerate-diagram`](pixerate-diagram/SKILL.md) | Mermaid diagrams: nodes, edges, groups, layout. |
| [`pixerate-image-editor`](pixerate-image-editor/SKILL.md) | Adjustments, adjustment layers, selections and masks. |
| [`pixerate-paint-editor`](pixerate-paint-editor/SKILL.md) | Natural-media painting: paper and grain, dry-media brushes, the brush library, strokes as data, pigment mixing. |
| [`pixerate-animation-editor`](pixerate-animation-editor/SKILL.md) | Vector animation: shots, commands, timing, Flair and Lottie. |
| [`pixerate-video-editor`](pixerate-video-editor/SKILL.md) | Non-linear video editing: tracks, clips, transitions, export. |
| [`pixerate-generation`](pixerate-generation/SKILL.md) | Planning, estimating and running paid media generation. |
| [`pixerate-parameters`](pixerate-parameters/SKILL.md) | Effect parameters, presets and keyframes. |
| [`pixerate-tokens`](pixerate-tokens/SKILL.md) | Design tokens: collections, modes, variables and aliases, through the whole-set document tools. |
| [`pixerate-effect-authoring`](pixerate-effect-authoring/SKILL.md) | Authoring shaders and procedural effects: inspecting parameters and source code, setting values and presets, keyframing animation tracks, playback timing, and previewing. |
| [`pixerate-color`](pixerate-color/SKILL.md) | Colour inspection, WCAG accessibility and contrast optimization, CVD simulation, palette audits, harmonies, and OKLab/OKLCH blends. |
| [`pixerate-typography`](pixerate-typography/SKILL.md) | Fonts and fallback stacks, font loading, modular type scales and hierarchies, fluid sizes, readability and type-aware contrast audits, text segmentation, the font picker. |

## Workflow skills

A workflow skill covers one job from start to finish: what to confirm first, the steps in
order with a check after each, a decision table, recipes and the job's pitfalls. It is built on
its reference skill's tools (load both), and its description is written about the job, so a
request like "clean up this export" finds it.

| Skill | Editor | Covers |
| --- | --- | --- |
| [`pixerate-image-selection-masking`](pixerate-image-selection-masking/SKILL.md) | Image (`pixerate-image-editor`) | Cutouts, background and sky replacement, local adjustments through masks; choosing a selection method, checking and refining edges, and outputting an editable mask. |
| [`pixerate-image-photo-correction`](pixerate-image-photo-correction/SKILL.md) | Image (`pixerate-image-editor`) | Global correction in order: straighten and crop, exposure and white balance, points and contrast, colour, local, look; each checked for clipping and neutral greys. |
| [`pixerate-image-portrait-retouch`](pixerate-image-portrait-retouch/SKILL.md) | Image (`pixerate-image-editor`) | Blemishes, stray hairs and flaws healed on their own layer, dodge and burn, eyes and teeth, kept natural. |
| [`pixerate-image-product-photo`](pixerate-image-product-photo/SKILL.md) | Image (`pixerate-image-editor`) | Product cutouts on pure white or a brand colour, a grounding shadow, accurate colour, centred marketplace crops. |
| [`pixerate-spreadsheet-clean-import`](pixerate-spreadsheet-clean-import/SKILL.md) | Spreadsheet (`pixerate-spreadsheet`) | Imported or pasted data made tidy: structure, headers, types (currency, comma decimals, day-first dates, leading zeros, missing values), text, duplicates and validation. |
| [`pixerate-vector-icon-set`](pixerate-vector-icon-set/SKILL.md) | Vector (`pixerate-vector`) | Icons on one grid with padding, one stroke, cap, join and radius, crisp coordinates, clean paths, symbols and SVG export. |
| [`pixerate-vector-logo`](pixerate-vector-logo/SKILL.md) | Vector (`pixerate-vector`) | Marks from primitives with live booleans, optical corrections, an aligned lockup, colour variants as symbols, outlined delivery files. |
| [`pixerate-vector-illustration`](pixerate-vector-illustration/SKILL.md) | Vector (`pixerate-vector`) | Block in back to front, gradients and stacked fills for form, masks, blends, subtle shadows with one light, export. |
| [`pixerate-paint-watercolour`](pixerate-paint-watercolour/SKILL.md) | Paint (`pixerate-paint-editor`) | Watercolour paper, light to dark with the paper's white kept, wet-in-wet and wet-on-dry washes, drying before glazing, steering the water. |
| [`pixerate-paint-oil-impasto`](pixerate-paint-oil-impasto/SKILL.md) | Paint (`pixerate-paint-editor`) | A toned ground, thin block-in to thick paint, pigment mixing, impasto relief and its light. |
| [`pixerate-paint-sketch-to-finish`](pixerate-paint-sketch-to-finish/SKILL.md) | Paint (`pixerate-paint-editor`) | Sketch, ink, flats under the lines, clipped shading and light, one named layer per pass. |
| [`pixerate-video-social-cut`](pixerate-video-social-cut/SKILL.md) | Video (`pixerate-video-editor`) | Vertical or square reframes that fill the frame, the hook first, platform lengths, titles in the safe area. |
| [`pixerate-video-colour-grade`](pixerate-video-colour-grade/SKILL.md) | Video (`pixerate-video-editor`) | Correct and match shots, then one look on an adjustment clip; LUTs at moderate strength with skin protected. |
| [`pixerate-video-montage`](pixerate-video-montage/SKILL.md) | Video (`pixerate-video-editor`) | Selects on the beat, varied pacing, short transitions with handles, music under everything and a clean ending. |
| [`pixerate-chart-choose-and-build`](pixerate-chart-choose-and-build/SKILL.md) | Chart (`pixerate-chart`) | From the question to the type, clean ordered data, honest axes, units and colour-blind-safe colours. |
| [`pixerate-chart-annotate`](pixerate-chart-annotate/SKILL.md) | Chart (`pixerate-chart`) | A takeaway title, highlights, labelled targets and ranges, callouts and a source note, kept few. |
| [`pixerate-spreadsheet-analysis`](pixerate-spreadsheet-analysis/SKILL.md) | Spreadsheet (`pixerate-spreadsheet`) | Summary tables with SUMIFS, COUNTIFS and AVERAGEIFS, growth, shares and rankings as live formulas that reconcile with the data. |
| [`pixerate-spreadsheet-financial-model`](pixerate-spreadsheet-financial-model/SKILL.md) | Spreadsheet (`pixerate-spreadsheet`) | Inputs apart from calculations, one formula pattern per row, no hard-coded numbers, scenarios and audits. |
| [`pixerate-diagram-process-flow`](pixerate-diagram-process-flow/SKILL.md) | Diagram (`pixerate-diagram`) | Processes as flowcharts: terminals, verb steps, decisions with labelled exits, loops and swimlanes. |
| [`pixerate-diagram-architecture`](pixerate-diagram-architecture/SKILL.md) | Diagram (`pixerate-diagram`) | Systems at one level of detail, store shapes, tiers and trust boundaries, flows labelled with protocols. |
| [`pixerate-talking-head-edit`](pixerate-talking-head-edit/SKILL.md) | Video (`pixerate-video-editor`) | Talking-head cleanup by transcript: fillers, long pauses and stutters found in one pass and cut as one plan reviewed before it applies. Owns the dialogue tools. |
| [`pixerate-bgm-alignment`](pixerate-bgm-alignment/SKILL.md) | Video (`pixerate-video-editor`) | Background music: beats and cuts on the beat, ducking under speech, loudness in LUFS. Owns the music tools. |

## Using them

Copy or symlink the directories into your agent's skills folder, for example for Claude Code:

```bash
cp -R node_modules/@pixerate/editor/skills/* .claude/skills/
```

Skills use bare tool names (`get_chart`). Registries expose them as `<toolset>__get_chart`
(the provider's namespace, or its id), and accept the bare name when only one toolset has it.

They can also be served rather than copied: the MCP bridge (`pixerate-mcp-bridge`) serves them as
MCP prompts and `skill://<name>/SKILL.md` resources, `createMcpServer(source, { skills })` does
the same for your own server, and a discovery view (`registry.view({ discovery: { skills } })`)
adds a `get_skill` tool. In Node, `loadSkillFiles()` from `@pixerate/editor/bridge` reads them.

## House-style skills

The skills above teach how to use the tools and ship with the package. A host can also give
agents **house-style skills** at runtime: an org's, a team's, a user's or a document's
preferences for a domain, in the same `SKILL.md` format plus optional per-domain profiles
(`chart.json`, `tokens.json`) whose strings may be `{ "$token": "brand/primary" }`
references to design tokens. `createStyleResolver` merges them in layers (later layers win
unless an earlier one is `locked`), `createStyleToolProvider` serves `list_styles`,
`get_style`, `get_style_file` and `get_style_schema`, and each domain's
`check_<domain>_style` runs the checks a profile turns on. They never replace the skills
here; `pixerate-agent-tools` tells a model how to use them.

## Maintaining them

A skill is part of its domain's agent path (see section 4 of `AGENTS.md`). When you add,
rename or remove a tool or command, or change how one should be used, update the skill in the
same change.

- **Format.** YAML frontmatter with `name` (the directory name) and `description` (what the
  skill covers and when to use it, at most 1024 characters), then: a mental model, a working
  method, best practices, a tool reference, commands (if any) and pitfalls. Keep `SKILL.md`
  under 500 lines and move long reference material to `references/*.md`.
- **Tool tables.** Every tool and command id the domain exposes is the first cell of exactly
  one table row: `` | `get_chart` | when and how to use it | ``. Say when to reach for it, what
  it returns, the arguments that matter (with units and defaults) and what to call before or
  after.
- **The test.** `packages/core/tests/agent-skills.test.ts` builds every provider and command
  set and fails when a skill misses a tool, lists one that no longer exists, or a new
  `create*ToolProvider` / `create*Commands` factory is not mapped to a skill. A new domain
  gets a new skill directory, an entry in `expectedBySkill()` and `FACTORIES`, and a row in
  the table above.
- **Workflow skills.** A skill that covers one job end to end on another skill's tools has no
  tool table (unless the job has its own provider, as the two video ones do). Start from
  [`WORKFLOW_TEMPLATE.md`](WORKFLOW_TEMPLATE.md). Its frontmatter adds `metadata` with
  `kind: workflow` and `reference: <skill>`; it lists the tools it uses as bullets under
  `## Tools used`; and it is mapped in `WORKFLOWS` in the test (and to `[]` in
  `expectedBySkill()`). The test checks that every tool it uses exists in the reference skill,
  that every backticked tool or command name in its prose is real, that the reference skill
  names it under `## Workflow skills`, that it stays under 250 body lines (aim for 200) and that
  it ships evals. Add its row to the workflow table above.
- **Evals.** Each workflow skill ships at least three scenarios in `evals/*.json`, run by
  `packages/core/tests/agent-skill-evals.test.ts`. An eval has a `prompt` (the task, in the
  user's words), a `fixture` (the starting document: `{ "editor": "spreadsheet", "rows" }`,
  `{ "editor": "image", "width", "height", "background", "shapes" }` or `{ "editor":
  "vector", "width", "height", "setup" }` with commands that draw the starting art, 
  `{ "editor": "paint", "width", "height", "setup" }` `{ "editor": "video", "setup" }` or `{ "editor":
  "chart", "setup" }` or `{ "editor": "diagram", "setup" }` with tool calls), `checks` (a read-only
  tool, or `run_command` with a read-only command such as `vector.list`, its `args`, what its result must match in `expect`, and `why`) and a `solution` (the
  tool calls an expert would make). The test proves each eval: some check fails on the fixture,
  and all pass after the solution. A model harness runs the same file with the model in place
  of the solution, using `@pixerate/editor/tools`: `listSkillEvals` reads the eval files,
  `imageEvalFixturePixels` paints an image fixture, and `failedEvalChecks` runs the checks
  through the harness's own tool calls (`matchesEvalExpectation` is the matcher on its own). In `expect`, objects match key by key and arrays element by element, with
  operators for ranges and lists (`$min`, `$max`, `$match`, `$every`, `$some`, `$length`,
  `$unique`, `$distinct`, `$sum`, `$column`, `$nonEmpty`, `$not`, `$in`, `$type`); a check's
  argument can read a value the job created with `{ "$read": "list_layers", "path":
  "layers.-1.id" }`. Checks test the outcome the user asked for, not one way of getting it.
- **Workflows and practice.** The test cannot check advice. When a feature changes the best
  way to do something (a new batch tool, a new check, a better default), update the working
  method and best practices too.
