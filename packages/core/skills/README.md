# Agent skills

Each editor domain in `@pixerate/editor` ships an [Agent Skill](https://agentskills.io): a
`SKILL.md` that teaches a model when and how to use that domain's tools, and the practice an
expert in the domain would follow. They are published with the package, so an app or agent
that uses the tools can load the matching skill.

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
- **Workflows and practice.** The test cannot check advice. When a feature changes the best
  way to do something (a new batch tool, a new check, a better default), update the working
  method and best practices too.
