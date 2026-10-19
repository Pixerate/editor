---
name: pixerate-agent-tools
description: How to drive any Pixerate editor (rich text, spreadsheet, canvas, vector, chart, diagram, image, animation, video, generation) through its agent tools - finding the right editor over the MCP bridge, reading tool names and namespaces, running editor commands with list_commands / run_command / run_commands, batching with result references, undo, and recovering from tool errors. Use whenever Pixerate editor tools are available, before the domain skill for the editor at hand.
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

- Tool names are `snake_case` verbs on a noun: `get_*` / `list_*` / `find_*` / `render_*` read,
  everything else writes.
- When several editors register a tool with the same name, or a host gives a provider a
  namespace, the name is prefixed: `chart__get_chart`, `doc-1__find_text`. Skills use the bare
  name; match on the suffix after `__`.
- The annotations are reliable: `readOnlyHint: true` never changes anything, `destructiveHint:
  true` removes content, `idempotentHint: true` is safe to retry.
- The tool list changes while you work (an editor mounts, a chart becomes read-only and its
  write tools disappear). If a tool you used before is gone, list tools again rather than guess.

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

## Errors

A failed call comes back as an `isError` result whose text says what was wrong and how to fix
it, with `structuredContent.error.code`:

- `invalid_arguments`: the arguments do not match the schema; `details` names each bad path.
  Fix the arguments and call again.
- `tool_failed`: the editor refused the change (unknown id, out-of-range position, read-only
  target). Nothing was applied. Read the state again, then retry with valid input.
- `unknown_tool`: the tool is not registered now (the editor closed, or it is read-only).

Never repeat an identical failing call. Never work around a read-only refusal; tell the user.

## Tool reference

| Tool | Use it to |
| --- | --- |
| `list_editors` | See which editors are open in the browser and connected to the MCP bridge (id, name, kind, tool count, last activity). Call it first when tools come through the bridge; pass an id or part of a name as `editor` to any tool to pick one when several are open, otherwise the most recently active editor with that tool answers. If none is connected, ask the user to open the app and connect it. |
| `list_commands` | Discover the commands an editor registers: id, label, group, params JSON Schema, shortcuts, and whether each is enabled now (with the reason when it is not). Filter with `query`; pass `enabledOnly: true` to see only what you can run now. |
| `run_command` | Run one command by `id` with `params` matching its schema. Disabled commands and unknown params fail with a reason; read it before retrying. |
| `run_commands` | Run several commands in order as `steps`. A param string `"$0.id"` or `"$last.id"` is replaced by that path of an earlier step's result, so a step can use an id an earlier step created. Pass `atomic: true` and a `label` to make the batch one undo step that rolls back entirely on failure; without it, steps before a failure stay applied. |

## Commands

These history commands are registered wherever a host shares a history with its command
registry. Domain editors also have their own `undo_*` / `redo_*` tools.

| Command | Use it to |
| --- | --- |
| `history.undo` | Revert the last change (one tool call or one atomic batch is one step). |
| `history.redo` | Re-apply the change you just undid. |
