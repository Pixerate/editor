---
name: pixerate-agent-tools
description: How to drive any Pixerate editor (rich text, spreadsheet, canvas, vector, chart, diagram, image, animation, video, generation) through its agent tools - finding the right editor over the MCP bridge, reading toolset-namespaced tool names, finding tools in a large catalogue with list_toolsets / search_tools / enable_tools and reading a toolset's skill with get_skill, running editor commands with list_commands / run_command / run_commands, batching with result references, undo, and recovering from tool errors. Use whenever Pixerate editor tools are available, before the domain skill for the editor at hand.
---

# Driving Pixerate editors with agent tools

Every Pixerate editor exposes the same kind of tool surface: a strict, one-tool-per-operation
set of MCP tools from its tool provider, plus (where the host registers them) its commands
through three generic command tools. This skill covers what is common to all of them. Each
editor domain has its own skill for its tools: `pixerate-rich-text`, `pixerate-spreadsheet`,
`pixerate-canvas`, `pixerate-vector`, `pixerate-chart`, `pixerate-diagram`,
`pixerate-image-editor`, `pixerate-animation-editor`, `pixerate-video-editor`,
`pixerate-generation` and `pixerate-parameters`.

## How tools are named

- Tools come in toolsets, one per open editor or feature (`chart`, `video`, `image-editor`,
  `doc-1`), and are named `<toolset>__<tool>`: `chart__get_chart`, `doc-1__find_text`. Skills use
  the bare name; match on the part after `__`.
- The tool part is a `snake_case` verb on a noun: `get_*` / `list_*` / `find_*` / `render_*`
  read, everything else writes.
- A bare name (`get_chart`) also works when only one toolset has that tool. When several do (two
  documents open), the error names each full name: pick the one for the editor you mean.
- The annotations are reliable: `readOnlyHint: true` never changes anything, `destructiveHint:
  true` removes content, `idempotentHint: true` is safe to retry.
- The tool list changes while you work (an editor mounts, a chart becomes read-only and its
  write tools disappear). If a tool you used before is gone, list tools again rather than guess.

## Finding the right tool

A host with many editors open can have hundreds of tools. It may list them all, only the open
editor's, or (in discovery mode) only `list_toolsets`, `search_tools`, `enable_tools`,
`disable_tools` and `get_skill` at first.

1. **Know what is open.** `list_toolsets` gives each toolset's title, what it covers, its skill
   and whether its tools are in your list.
2. **Search by task, not by guessing names.** `search_tools` with a few plain words ("add a
   trendline", "remove silences") returns the best matches with a one-line summary. Pass
   `toolset` to search one editor.
3. **Enable only what you need.** `enable_tools` with the tool names from the search (or a whole
   toolset when you will use many of its tools). The tools then appear in your list. Use
   `disable_tools` to drop a toolset you are done with.
4. **Read the skill before working in a toolset.** `get_skill` with the skill `list_toolsets`
   names (or the MCP prompt / `skill://` resource of the same name).

## Working method

1. **Read before you write.** Start with the domain's `get_*` tool. Write tools take the ids,
   ranges and positions that read tools return; never invent an id.
2. **Prefer the specific tool.** A dedicated tool (`set_chart_values`, `add_video_clip`) has a
   strict schema and a precise error; use generic commands only for what has no tool.
3. **Batch related edits.** Use the domain's batch tool (`edit_animation`, `edit_video`,
   `run_commands` with `atomic: true`) so a multi-step change is one undo step and either all
   applies or none does. Use `dry_run` where offered when you are unsure.
4. **Use what writes return.** Writes return what they created or changed (new ids, the
   resulting range or value). Chain on those rather than re-reading the whole state.
5. **Check, then look.** Run the domain's `check_*` tool and fix every error and warning.
   Render (`render_*`, `view_editor`) after a batch of edits, not after every edit: images cost
   tokens, so use them for what text cannot tell you (overlap, legibility, balance).
6. **Undo your own mistakes** with the domain's `undo_*` tool or the `history.undo` command, not
   by hand-reverting with more edits.

## Playback

The host may act your calls out on screen (agent playback): your cursor glides to what a call
names, presses, drags or types, and the change lands as one undo step. Results are the same with
or without it, and calls simply take a little longer while it plays. Only changes play by
default: reads return at once and do not move your cursor.

- Do not add waits or poll for the animation; each call returns once its change is applied.
- Name your targets with the ids read tools return (`ids`, `nodeId`, `layerId`, a range). They are
  also what the cursor heads for, so the user can follow along.
- A batch (`run_commands`) plays its steps' moves first, then applies once as one undo step.
- If you connect over MCP, your client's name labels your cursor; several agents get separate
  cursors.
- If the host registers `say`, use it sparingly to tell the user why, before a change that
  is not obvious from the cursor alone (one short sentence). It shows beside your cursor on the
  editor you last changed, so call it after your first write there; `shown: false` means no
  cursor was on screen, which is fine: carry on. Never call it instead of doing the work.

## Errors

A failed call comes back as an `isError` result whose text says what was wrong and how to fix
it, with `structuredContent.error.code`:

- `invalid_arguments`: the arguments do not match the schema; `details` names each bad path.
  Fix the arguments and call again.
- `tool_failed`: the editor refused the change (unknown id, out-of-range position, read-only
  target). Nothing was applied. Read the state again, then retry with valid input.
- `unknown_tool`: the tool is not registered now (the editor closed, or it is read-only), a
  bare name matches several toolsets (use a full name from the message), or this agent may not
  use that toolset or write at all (the message says which).

Never repeat an identical failing call. Never work around a read-only refusal; tell the user.

## Tool reference

| Tool | Use it to |
| --- | --- |
| `list_editors` | See which editors are open in the browser and connected to the MCP bridge (id, name, kind, tool count, last activity). Call it first when tools come through the bridge; pass an id or part of a name as `editor` to any tool to pick one when several are open, otherwise the most recently active editor with that tool answers. If none is connected, ask the user to open the app and connect it. |
| `list_toolsets` | See the toolsets open now: name, title, what each covers, its skill, how many tools it has and whether they are in your tool list (`enabled`: all, some, none). Call it first in a discovery view, then `search_tools` or `enable_tools`. |
| `search_tools` | Find the tool for a task: pass `query` in plain words (and `toolset` to search one editor, `limit` for more than 10). Returns the best matches first with name, toolset, title, one-sentence summary, whether it only reads and whether it is listed. Follow with `enable_tools`. |
| `enable_tools` | Add tools to your tool list by full name (`tools`, from `search_tools`) and/or whole `toolsets` (from `list_toolsets`). Returns the names added and how many are listed. Prefer single tools to large toolsets. Unknown names fail and change nothing. Allowed tools can also be called by name without enabling them. |
| `disable_tools` | Drop tools or whole toolsets you are done with from your tool list, to keep it short. Returns the names removed. |
| `get_skill` | Read a toolset's skill (markdown) before working with it; pass `file` for one of its reference files (listed at the top). The note at the top says how names are prefixed here. |
| `list_commands` | Discover the commands an editor registers: id, label, group, params JSON Schema, shortcuts, and whether each is enabled now (with the reason when it is not). Filter with `query`; pass `enabledOnly: true` to see only what you can run now. |
| `run_command` | Run one command by `id` with `params` matching its schema. Disabled commands and unknown params fail with a reason; read it before retrying. |
| `run_commands` | Run several commands in order as `steps`. A param string `"$0.id"` or `"$last.id"` is replaced by that path of an earlier step's result, so a step can use an id an earlier step created. Pass `atomic: true` and a `label` to make the batch one undo step that rolls back entirely on failure; without it, steps before a failure stay applied. |
| `say` | Optional; only where the host shows your cursor. Put one short sentence (`text`, at most 200 characters) in the bubble beside your cursor so the user can follow why you are about to change something. Returns `shown` and the `surface` it appeared on (`shown: false`, `surface: null` when no cursor is on screen, which is not an error). Call it after a write on that editor, before the next one. Changes nothing. |

## Commands

These history commands are registered wherever a host shares a history with its command
registry. Domain editors also have their own `undo_*` / `redo_*` tools.

| Command | Use it to |
| --- | --- |
| `history.undo` | Revert the last change (one tool call or one atomic batch is one step). |
| `history.redo` | Re-apply the change you just undid. |
