---
name: pixerate-canvas
description: How to build and edit a Pixerate design canvas or node graph through its agent tools - drawing freehand pen, highlighter and dry-brush strokes (canvas.drawFreehand), adding, connecting, updating and laying out nodes (canvas_add_node, canvas_layout), reading state with get_editor_state and looking at it with view_editor, reusable components with variants, instances and overrides (create_component, add_variant, set_instance_properties), align, distribute, lock and layer order, shape boolean operations (unite, subtract, offset path, outline stroke), auto layout frames, and keyframe animation with easing and CSS export. Use when working on a canvas, whiteboard, flow chart, node graph, frame, design system, component library, button variants, layout, alignment, z-order or a canvas animation in a Pixerate editor.
---

# Pixerate canvas

The canvas is an xyflow (React Flow / SvelteFlow) graph: an array of **nodes** and **edges**.
A node is `{ id, type, position: { x, y }, width?, height?, parentId?, zIndex?, data }`; edges are
`{ id, source, target, label? }`. Everything a design feature knows lives in `node.data`, so it
survives copy, paste and JSON:

- `data.label` / `data.name`: text content and layer name. `data.shape`: a shape node
  (`{ kind: rect | ellipse | polygon | star | path, fill, stroke, strokeWidth, ... }`).
- `data.layout`: an auto layout frame (`mode` horizontal / vertical / grid, `gap`, `padding`,
  `alignMain`, `alignCross`, `sizing`); its children are the nodes whose `parentId` is the frame,
  in node-array order. `data.childLayout`: a child's sizing (fixed / hug / fill) and constraints.
- `data.component` (a main component), `data.componentSet` (a set of variants),
  `data.instance` (`{ componentId, properties }`) and `data.componentOverrides`.
- `data.locked`, `data.animation` (keyframe tracks), `data.tokenBindings` (design tokens).

Positions are in canvas (flow) units; a child's position is relative to its parent. Node ids come
from `get_editor_state`; component and set ids from `list_components`. Tools that take `ids` or
`id` default to the current selection when you leave them out, so pass ids explicitly unless you
just selected with `canvas_select`. See `pixerate-agent-tools` for namespacing, `run_commands`
batching and error codes.

## Working method

1. **Read.** `get_editor_state` with `includeDocument: false` returns `canvas.nodes` and
   `canvas.edges`. For a design system also call `list_components`, and `inspect_instance` before
   changing an instance.
2. **Plan the structure first**: which frames, which reusable components and variants, what
   spacing scale. Build the main component once, then place instances; do not copy nodes by hand.
3. **Write.** Use the dedicated tools for graph edits (`canvas_add_node`, `canvas_connect`,
   `canvas_update_node`) and components (`create_component`, `create_instance`, ...). Use
   `run_commands` with `atomic: true` for arrange, shape and animation commands, and whenever
   several steps should be one undo step (a param `"$0.ids[0]"` uses an id an earlier step returned).
4. **Tidy.** `canvas_layout` for graphs; `canvas.align*` / `canvas.distribute*` for designs;
   layer order with `canvas.bringToFront` and friends; lock finished backgrounds with `canvas.lock`.
5. **Look.** `view_editor` (default viewport, JPEG, 1024 px) once a batch is done; use
   `scope: "canvas"` for the whole drawing. Fix overlaps, misalignment and clipped text, then show
   the user with `canvas_select` or `canvas_highlight`.

## Best practices

- **Design-system thinking.** Anything that appears twice should be a component: build one main,
  `combine_as_variants` for states and sizes (`State=Default`, `State=Hover`, `Size=Small`), then
  `create_instance` everywhere. Change the main to change every instance; use overrides only for
  per-use content (label text, an icon swap). Name variant properties and values consistently
  (Title Case property, short values) and keep combinations unique.
- **Name layers that must survive a variant switch** with a stable `data.name`. Matching falls
  back to `data.label`, which for text is its content and differs between variants.
- **Use component properties, not detaching.** Switch variants and set text or boolean
  properties with `set_instance_properties`; `swap_instance` for another component. Detach only
  when the instance must stop following its main.
- **Spacing scale.** Pick a base unit (4 or 8) and use multiples for gaps and padding. Put rows
  and stacks in auto layout frames (`data.layout`) instead of positioning children by hand, so
  they reflow when content changes.
- **Alignment and distribution.** Align to a shared edge or centre, then distribute with equal
  gaps; a design reads as ordered when edges line up. Lock a node you want as the anchor: locked
  nodes never move but still count towards the selection bounds.
- **Layering.** Backgrounds at the back, content above, overlays on top. Use the restack
  commands; they set `zIndex` per sibling group and never reorder the array.
- **Graph layout.** Lay flows out in one direction (`LR` for pipelines, `TB` for hierarchies),
  keep edges short, label edges only when the relationship is not obvious.
- **Motion.** Use ease-out (or `ease-out-back` for a little overshoot) for things arriving,
  ease-in for things leaving, ease-in-out for moves between two resting places, and `linear` only
  for continuous motion such as rotation. Keep UI transitions around 150 to 400 ms and entrances
  under about 600 ms; stagger related elements by 30 to 80 ms with `delay` rather than moving
  everything at once. Animate `opacity`, `x`, `y`, `scale` and `rotation`; colour tweens
  interpolate in OKLab.

- **Brushed strokes.** Use a brush when the user wants a hand-drawn look (sketching, ink,
  pencil, marker); keep plain strokes for diagrams and UI. Send points every 2 to 8 canvas units
  along a curve, and shape the line with a short `pressure` profile (tapered ends:
  `[0.2, 0.9, 1, 0.9, 0.2]`) rather than many points of different widths. Leave `width` out to
  use the preset's own size (`canvas.listBrushes` gives it); pass it only to make the mark finer
  or bolder.
- **Brush character.** Each preset draws with its own character: charcoal and pastel are broad and
  grainy (they catch the paper's tooth), pencil is fine and slightly grainy, ink, marker and brush
  pen are clean, the airbrush is a soft spray. The grain and jitter are seeded per stroke, so a
  stroke always looks the same, and neighbouring strokes share one sheet of paper. Pick the brush
  for the look, then the colour; for a sketch, use one or two brushes rather than all of them.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_editor_state` | Read the canvas graph (`canvas.nodes`, `canvas.edges`) and, by default, the prompt document too. Pass `includeDocument: false` on a canvas-only task to keep the result small, `includeCanvas: false` for only the prompt. Call it first and again after edits made by the user. |
| `view_editor` | Get an image of the editor: `scope` `viewport` (default) or `canvas` (the whole drawing's bounds), `format` `jpeg` (default) or `png`, `maxEdge` in pixels (default 1024). Use it after a batch to judge overlap, balance and legibility; agent cursors are left out. |
| `capture_view` | Screenshot part of the canvas to check a result: `region` `viewport` (default, as on screen), `content` (every node), `selection`, `nodes` (with `ids` from `get_editor_state`) or `rect` (canvas units); `padding` (default 16), `maxEdge` (default 1024), `format` `png` (default) or `jpeg`. The result gives the captured `rect` and `scale`, so image pixel (px, py) is canvas point (rect.x + px / scale, rect.y + py / scale). Prefer `nodes` to inspect what you just added at full detail. Selection boxes and agent cursors are left out unless `includeOverlays`. |
| `list_components` | List main components (id, name, variant values, instance count) and component sets with their variant options. Call it before `create_instance`, `swap_instance` or any variant tool to get ids and the exact property names and values. |
| `inspect_instance` | Describe one instance (or a layer inside it; default the first selected node): its main, variant, component property values with types, and per-layer overrides. Call it before `set_instance_properties` or `reset_overrides` so you use the right property names and override groups. |

### Write: graph

| Tool | Use it to |
| --- | --- |
| `canvas_add_node` | Add a node: `node` (`id` optional and must be unused, `type` registered by the host, `data`, `position`, `width`, `height`, `parentId` for a frame). Leave `position` out to auto-place it without overlaps beside `nearNodeId` on `side` (default `right`), which also connects an edge from that node, or beside the last node. Returns the new node id and edge id. |
| `canvas_connect` | Add an edge from `source` to `target` (two different existing nodes), with an optional `label`. Returns the edge id. |
| `canvas_update_node` | Merge fields into a node's `data` (for example `{ "label": "Checkout" }`). Treat the merge as shallow: pass nested objects such as `shape` or `layout` whole. It does not move or resize nodes. |
| `canvas_remove_nodes` | Delete nodes and their edges; every id must exist. Destructive: confirm with the user before removing content they made. |
| `canvas_layout` | Arrange the graph automatically: `direction` `LR` (default), `TB`, `RL` or `BT`. `incremental` (default true) keeps nodes that already have a position; pass `false` to re-lay everything. Nodes at exactly (0, 0) count as unplaced. |
| `canvas_select` | Replace the selection (an empty list clears it). Use it to show the user a result and to target commands that act on the selection. |
| `canvas_highlight` | Flash nodes to point the user at them: `color` (default `#3b82f6`), `durationMs` (default 2000, max 60000). Changes nothing. |

### Write: components

These are strict-schema tools. Each returns `{ ids }` of what it created or changed, or fails with
the reason (for example a variant combination that already exists, or a cycle).

| Tool | Use it to |
| --- | --- |
| `create_component` | Turn one frame-like node (`ids`) into a main component, or wrap several sibling layers in a new component frame. Returns the component id. |
| `combine_as_variants` | Wrap sibling components in a component set. Names already in `Property=Value` form become variant values; others get `Property 1=Default`, `Variant2`, ... Rename afterwards with `rename_variant_property` / `rename_variant_value`. |
| `create_instance` | Place an instance of `componentId` (a component, or a set's default variant), optionally inside frame `parentId`, at `x` / `y` (canvas coordinates, or relative to the parent), with `properties` (variant and component property values). Returns the instance id. |
| `set_instance_properties` | Set property values on instances (`ids`): a variant property switches the variant (compatible overrides kept), a boolean toggles a layer, a text property sets text, an instance-swap property takes a component id. Get names from `inspect_instance`. |
| `swap_instance` | Make instances show another component (`componentId`), keeping overrides on layers whose names match. |
| `reset_overrides` | Reset overrides of a whole instance (default), of one layer (pass the layer as `id`), or one `group` such as `data.label` or `shape.fill`. Destructive. |
| `push_overrides` | Copy an instance's overrides to its main component, and so to every other instance. Destructive for other instances' look: use it only when the user wants the change everywhere. |
| `detach_instance` | Turn instances into plain frames that keep their look and stop following the main. Destructive; prefer properties or `swap_instance`. |
| `go_to_main_component` | Select an instance's main component and get its id, to edit the main itself. |
| `restore_main_component` | Recreate a deleted main component from one of its instances (its old id comes back, so other instances re-link). |
| `add_variant` | Add a variant to set `setId` by duplicating `from` (default the set's default variant) with new `variant` values such as `{ "State": "Hover" }`; unnamed properties keep the source's values, a new property name is added to every variant as `Default`. `x` / `y` are optional (default next to the source). Without values the next `VariantN` is used. |
| `remove_variant` | Remove variant `id` from its set (never the last one); its instances switch to the closest remaining variant, keeping overrides. Destructive. |
| `set_variant_properties` | Merge `values` into variant `id`'s property values. A combination another variant has is refused. |
| `rename_variant_property` | Rename property `name` to `newName` across a set; instances keep their variant. |
| `rename_variant_value` | Rename `value` of `property` to `newValue` across a set; instances keep their variant. |

## Commands

Run these through `run_command` / `run_commands`. Each takes `ids` (default: the selection) unless
noted, is one undo step, and reports in `list_commands` why it cannot run.

### Arrange

| Command | Use it to |
| --- | --- |
| `canvas.alignLeft` | Align the left edges of two or more nodes to the selection bounds. |
| `canvas.alignCenter` | Align horizontal centres (a vertical centre line). |
| `canvas.alignRight` | Align right edges. |
| `canvas.alignTop` | Align top edges. |
| `canvas.alignMiddle` | Align vertical centres (a horizontal centre line). |
| `canvas.alignBottom` | Align bottom edges. |
| `canvas.distributeHorizontal` | Give three or more nodes equal horizontal gaps; the outermost stay put. |
| `canvas.distributeVertical` | Give three or more nodes equal vertical gaps. |
| `canvas.lock` | Lock nodes: they cannot be moved, resized, restacked, deleted or combined, but stay selectable and act as alignment anchors. |
| `canvas.unlock` | Unlock nodes, restoring their previous drag and delete flags. |
| `canvas.bringForward` | Move nodes one step up among their siblings (past the next overlapping sibling). |
| `canvas.sendBackward` | Move nodes one step down among their siblings. |
| `canvas.bringToFront` | Put nodes on top of their siblings. |
| `canvas.sendToBack` | Put nodes below their siblings (backgrounds). |

### Shapes

These act on shape nodes (`data.shape`) and replace their inputs with a new `path` shape (curves
are kept exactly). They need unlocked shapes; other selected nodes are ignored.

| Command | Use it to |
| --- | --- |
| `canvas.unite` | Merge two or more shapes into one outline. |
| `canvas.intersect` | Keep only the area all shapes share; refused when they do not overlap. |
| `canvas.subtract` | Cut every other shape out of the back-most one (stacking order decides which is the base). |
| `canvas.exclude` | Keep the areas covered an odd number of times (XOR). |
| `canvas.divide` | Split overlapping shapes into one shape per region, each painted like the top shape covering it. |
| `canvas.offsetPath` | Grow (`distance` > 0) or shrink (< 0) shapes by `distance` canvas units (default 10), with `join` `miter` (default), `round` or `bevel` and `miterLimit` (default 4). |
| `canvas.outlineStroke` | Turn shapes' strokes into filled shapes: `join` (default miter), `cap` `butt` (default), `round` or `square`, `miterLimit` (default 4). The fill stays as a separate shape below. |

### Draw

Freehand strokes are `path` shape nodes, so they select, move, group, erase and export like any
shape. A stroke with `data.shape.brush` is painted with a dry paint brush instead of an SVG stroke
(the path stays the data; the paint is rendered from it); `brush.paint` gives it gradient paint, sampled dab by dab
along the path, instead of the stroke colour). New brushed strokes store a `brush.seed` (their
character: seeded jitter and the paper grain they catch) and, when a width was chosen, `brush.size`.

| Command | Use it to |
| --- | --- |
| `canvas.drawFreehand` | Draw a pen or highlighter stroke through `points` (`[x, y]` pairs in canvas units, in drawing order; one undo step). `tool` picks the defaults (`pen`: blue, width 3; `highlighter`: yellow, width 24, opacity 0.35); `color`, `width`, `opacity` override them (with a `brush`, `width` is the brush diameter and defaults to the preset's own size). Pass `brush` (a preset id from `canvas.listBrushes`, or tip settings) to paint it with a dry brush, plus `pressure` / `tiltX` / `tiltY` profiles spread along its length (`[0.2, 1, 0.3]` swells in the middle). Add `paint` (only with `brush`) for gradient paint that changes colour along the stroke: `{ "type": "gradient", "stops": [...], "map": { "by": "distance", "length": 200 } }` (length in canvas units), or `by` `pressure`, `tilt`, `direction`, `across-tip`, `random`. Returns the node `id`, its `bounds` and the stored `brush` (with `paint` normalised: defaults filled in, colours lowercased). |
| `canvas.listBrushes` | Read-only: the dry paint presets `canvas.drawFreehand` accepts as `brush` (`id`, `name`, `category`, the preset's own `size`, which a stroke uses unless you pass `width`). Call it before the first brushed stroke instead of guessing ids. |

### Components (command form)

The same operations as the component tools, for command palettes and `run_commands` batches.
Prefer the dedicated tool for a single operation: its schema is strict and its errors precise. Use
the command when you need it inside an atomic batch with arrange or animation steps, or when the
host registered only commands.

| Command | Use it to |
| --- | --- |
| `canvas.listComponents` | Read-only; same result as `list_components`. |
| `canvas.inspectInstance` | Read-only; same as `inspect_instance` (`id`). |
| `canvas.createComponent` | Same as `create_component` (`ids`). |
| `canvas.combineAsVariants` | Same as `combine_as_variants` (`ids`). |
| `canvas.createInstance` | Same as `create_instance` (`componentId`, `parentId`, `x`, `y`, `properties`). |
| `canvas.setInstanceProperties` | Same as `set_instance_properties` (`properties`, `ids`). |
| `canvas.swapInstance` | Same as `swap_instance` (`componentId`, `ids`). |
| `canvas.resetOverrides` | Same as `reset_overrides` (`id`, `group`). |
| `canvas.pushOverrides` | Same as `push_overrides` (`id`). |
| `canvas.detachInstance` | Same as `detach_instance` (`ids`). |
| `canvas.goToMainComponent` | Same as `go_to_main_component` (`id`). |
| `canvas.restoreMainComponent` | Same as `restore_main_component` (`id`). |
| `canvas.addVariant` | Same as `add_variant` (`setId`, `from`, `variant`, `x`, `y`). |
| `canvas.removeVariant` | Same as `remove_variant` (`id`). |
| `canvas.setVariantProperties` | Same as `set_variant_properties` (`values`, `id`). |
| `canvas.renameVariantProperty` | Same as `rename_variant_property` (`name`, `newName`, `setId`). |
| `canvas.renameVariantValue` | Same as `rename_variant_value` (`property`, `value`, `newValue`, `setId`). |

### Animation

A node's animation is a set of property tracks of keyframes `{ time (ms), value, easing }`; the
easing applies to the segment leaving a keyframe. Animatable properties: `x`, `y`, `width`,
`height`, `rotation` (degrees), `scale`, `opacity` (0 to 1), `fill`, `stroke`, `strokeWidth`,
`cornerRadius`, `motionPath` (0 to 1). Easings: `linear`, `ease`, `ease-in`, `ease-out`,
`ease-in-out`, `ease-in-back`, `ease-out-back`, `spring`, `hold`, or `cubic-bezier(x1, y1, x2, y2)`.

| Command | Use it to |
| --- | --- |
| `canvas.animation.animateNode` | The main authoring command: animate `nodeId` from `from` (default: its current values) to `to` over `duration` ms (default 1000), starting at `delay` ms (default 0), with `easing`. Stagger several nodes with increasing `delay` in one atomic `run_commands`. |
| `canvas.animation.addKeyframe` | Key nodes (`ids`, default selected) at `time` ms (default the playhead): the listed `properties`, else their animated ones, else `x` and `y`. Set the node's values first, then key. |
| `canvas.animation.setEasing` | Set `easing` on the segments leaving the selected keyframes. Needs a keyframe selection. |
| `canvas.animation.deleteKeyframes` | Delete the selected keyframes. Needs a keyframe selection. |
| `canvas.animation.seek` | Move the playhead to `time` ms (required). Returns the time. |
| `canvas.animation.play` | Start playback (refused when already playing). |
| `canvas.animation.pause` | Pause playback (refused when not playing). |
| `canvas.animation.togglePlay` | Play or pause; returns `playing` and `time`. |
| `canvas.animation.stop` | Stop and return to the start. |
| `canvas.animation.toggleRecord` | Toggle record mode, in which changing any property at the playhead keys it. Returns `recording`; turn it off when done. |
| `canvas.animation.nextKeyframe` | Jump the playhead to the next keyframe. |
| `canvas.animation.previousKeyframe` | Jump the playhead to the previous keyframe. |
| `canvas.animation.exportCss` | Read-only: CSS `@keyframes` for `nodeId`'s animation, as `{ css, exact }`. `exact: false` means some tracks were sampled (OKLab colour tweens, `x` / `y` with different timing, motion paths). |

### Provider effects

These tools come from `createCanvasEffectsToolProvider`. They work once the host registers an
effects provider (for example Flair); without one the read tools say so and the write tools refuse.

| Tool | Use it to |
| --- | --- |
| `search_effects` | Find effects: use `generator` for fills, `overlay`, `title` or `interactive` for overlays, and `transition` for scene transitions. |
| `describe_effect` | Read an effect's controls, ranges, defaults and presets before applying it. |
| `list_applied_effects` | List the shape nodes that carry effects, with each effect's role (fill or overlay), opacity and values. |
| `apply_effect` | Put an effect on a shape node: a generator fills the shape (clipped to its outline), anything else draws over its box. This replaces any effect already there. Returns the effect. |
| `update_effect` | Change a node's effect (`effect` is "effect"): `values` (`null` resets a control), `opacity`, and `enabled` (false holds the first frame). |
| `remove_effect` | Take the effect off a node. |
| `set_canvas_effect_mode` | Switch a node's effect between `fill` and `overlay`. |
| `list_scene_transitions` | List the Scenes in order, each with the transition played when moving to it. |
| `set_scene_transition` | Set (or with `effect` null, remove) the transition effect played when moving to a scene, with its `duration` in ms. |

## Pitfalls

- **A shape node holds one effect.** `apply_effect` replaces the effect that is there. Effects draw on shape nodes only (nodes with `data.shape`).

- **Brushes are dry only.** Wet presets (watercolour, gouache, wet oils), mixer, blender, smudge and
  eraser presets are refused: wet paint needs an area to flow in, and the others need paint under
  them. `pressure` and tilt without a `brush` are refused too.
- **Gradient paint needs a brush, and no timing.** `paint` without `brush` is refused; use
  `color` for a plain stroke. Canvas strokes record no timing, so `velocity` and `time` mappings
  are refused: use `distance` for colour that changes along the stroke. The stroke `color` still
  sets the alpha and fills `"paint"` stops (`"secondary"` is white). A distance `length` shorter
  than the stroke with `repeat: "mirror"` (the default) runs back and forth; use `clamp` and a
  length near the stroke's to go from one end to the other once.
- A canvas gradient in `color` does not reach the brush: a brushed stroke with a gradient
  `color` and no `paint` uses its first stop. Pass `paint` instead.
- **Shape operations drop the brush.** Unite, subtract, offset path and outline stroke turn
  brushed strokes into plain filled or stroked paths.
- `canvas_*` tools validate ids against the current state; an "Unknown node id" error means call
  `get_editor_state` again, not guess.
- `canvas_add_node` with `nearNodeId` also adds an edge from that node. Pass an explicit
  `position` (and no `nearNodeId`) for a free-standing design element.
- `canvas_update_node` changes `data` only. Move nodes with layout, align or distribute commands,
  or by the host's own means; do not expect `position` inside `data` to move anything.
- Align needs at least two nodes and distribute at least three; locked nodes never move. Shape
  booleans refuse locked shapes and empty results, and edges attached to consumed shapes are left
  dangling: reconnect or remove them.
- Subtract uses stacking order (back-most is the base), not selection order; restack first.
- Instances never gain or lose layers. Deleting a layer inside an instance hides it; nodes added
  inside an instance move out of it. Edit the main to change structure.
- `push_overrides`, `detach_instance`, `remove_variant` and `reset_overrides` change other
  instances or discard work; ask before using them on the user's design.
- Variant edits refuse a combination another variant already has, empty names, and names
  containing `,` or `=`.
- An instance cannot be placed inside a component it contains (cycle); place it outside.
- Animation times are milliseconds; `rotation` is degrees and `opacity` 0 to 1 (token bindings use
  percent for opacity, animation does not).
