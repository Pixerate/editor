---
name: pixerate-canvas-layout
description: The layout workflow in the Pixerate canvas - tidying a board or screen by aligning edges and centres, distributing elements evenly, keeping consistent spacing on a grid, ordering layers so the right things are on top, grouping related elements, locking backgrounds and guides, and checking the result. Use when asked to align, line up, centre, distribute, space evenly, tidy, clean up or lay out elements on a canvas, board, screen, slide or wireframe, bring something to the front or send it back, or lock a layer, or when canvas.alignLeft, canvas.distributeHorizontal, canvas.bringToFront or canvas.lock are available. Load with pixerate-canvas, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-canvas
---

# Laying out a canvas

A tidy layout comes from a few relations applied deliberately: shared edges and centres,
equal gaps, a consistent spacing scale, and a stacking order where what matters is on top.
Use the arrange commands rather than moving nodes by hand: they act on exact geometry, keep
other axes untouched, and are one undo step each.

This skill is the method. `pixerate-canvas` has the full tool reference; run the `canvas.*`
commands with `run_command` (`params: { ids }`) or several in one `run_commands` batch.

## Goal and quality bar

- Elements in a row share a top, centre or bottom; elements in a column share a left, centre or
  right edge.
- Gaps between repeated elements are equal, on the spacing scale (multiples of 4 or 8).
- The stacking order matches meaning: backgrounds at the back, content above, badges, overlays
  and annotations on top.
- Backgrounds, guides and finished areas are locked so they cannot be moved by accident.
- Only the intended axis changes: aligning tops does not move anything sideways.

## Inputs to confirm

- **Which elements** belong together (a row of cards, a form column) and the anchor (the first
  element, the container, the canvas).
- **Spacing:** equal distribution between fixed ends, or a set gap.
- **What must stay put**, and what to lock.

## Working method

1. **Read.** `get_canvas_document` for node ids, positions, sizes, parents and z-order.
   **Check:** you know the rows, columns and stacking you want.
2. **Align** rows and columns: `canvas.alignTop`, `canvas.alignMiddle`, `canvas.alignBottom`,
   `canvas.alignLeft`, `canvas.alignCenter`, `canvas.alignRight` with the group's `ids`.
   **Check:** the shared coordinate is equal; the other axis is unchanged.
3. **Distribute** repeated elements: `canvas.distributeHorizontal` or `canvas.distributeVertical`
   (the outer elements stay, the gaps between them become equal).
   **Check:** the gaps are equal within a pixel.
4. **Order layers.** `canvas.bringToFront`, `canvas.bringForward`, `canvas.sendBackward`,
   `canvas.sendToBack`; order is by `zIndex`, then document order.
   **Check:** what must be on top has the highest effective order.
5. **Lock** backgrounds and finished parts: `canvas.lock` (`canvas.unlock` to edit again).
   **Check:** locked nodes are no longer draggable in `get_canvas_document`.
6. **Look** with the host's view (`capture_view`, `view_editor`) when available.

## Decision table

| Want | Command |
| --- | --- |
| A row lined up | `canvas.alignTop` (or `canvas.alignMiddle` for mixed heights) |
| A column lined up | `canvas.alignLeft` (or `canvas.alignCenter`) |
| Even gaps between fixed ends | `canvas.distributeHorizontal` / `canvas.distributeVertical` |
| Something hidden behind | `canvas.bringToFront` |
| A background covering content | `canvas.sendToBack` |
| One step up or down | `canvas.bringForward` / `canvas.sendBackward` |
| Protect a background or guide | `canvas.lock` |

## Recipes

**Line up a row of cards.** `run_command` `{ id: "canvas.alignTop", params: { ids: ["a", "b",
"c"] } }`.

**Even spacing.** `run_command` `{ id: "canvas.distributeHorizontal", params: { ids } }`; the
leftmost and rightmost stay where they are.

**Badge on top, background locked.** `run_commands` with `canvas.bringToFront` `{ ids: ["badge"]
}` and `canvas.lock` `{ ids: ["backdrop"] }`.

## Pitfalls

- **Moving by hand** with rounded numbers drifts; align and distribute act on exact geometry.
- **Distributing two elements** does nothing; it needs at least three.
- **Aligning across different parents** aligns in each parent's own space; group or reparent
  first.
- **Stacking by array order only**: `zIndex` wins over order; read the effective order.
- **Locked nodes** refuse moves; unlock, change, lock again.
- **Aligning everything to one edge** of the canvas when the group should align to itself.

## Tools used

- `get_canvas_document`: node positions, sizes, parents, z-order and locks
- `canvas.alignLeft`, `canvas.alignCenter`, `canvas.alignRight`: column alignment
- `canvas.alignTop`, `canvas.alignMiddle`, `canvas.alignBottom`: row alignment
- `canvas.distributeHorizontal`, `canvas.distributeVertical`: even gaps
- `canvas.bringToFront`, `canvas.bringForward`, `canvas.sendBackward`, `canvas.sendToBack`: stacking order
- `canvas.lock`, `canvas.unlock`: protect backgrounds and finished parts
- `capture_view`, `view_editor`: look at the result
- `undo_canvas`: take back a step
