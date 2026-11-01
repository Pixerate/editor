---
name: pixerate-canvas-design-system-components
description: The design system components workflow in the Pixerate canvas - turning repeated design into main components, placing instances instead of copies, combining versions into a component set with named variant properties and values, adding variants, keeping instances linked, swapping, resetting and pushing overrides, and keeping the library tidy and named. Use when asked to build or tidy a design system, component library or UI kit, make a component, instance, variant or component set, add a state (hover, disabled) or size, rename variant properties, or replace copies with instances, or when create_component, combine_as_variants, add_variant or create_instance are available. Load with pixerate-canvas, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-canvas
---

# Building design system components

A design system replaces copies with components. A main component holds the design; instances
show it elsewhere and update when it changes, with per-instance overrides where they differ.
Versions of one thing (styles, states, sizes) become variants in a component set, described by
properties ("Style=Primary, State=Disabled") a person or agent can switch between. Names and
properties are the interface: keep them clear and consistent.

This skill is the method. `pixerate-canvas` has the full tool reference.

## Goal and quality bar

- Anything used more than once is a main component; its uses are linked instances
  (`inspect_instance` `status: "linked"`), not copies.
- Versions of one element are variants in one component set, with named properties (Style,
  State, Size) and named values (Primary, Disabled, Large), never "Property 1" and "Variant2".
- Every combination of property values is unique; the default variant is the most common one.
- Instances keep their link; detach only when one must diverge for good.
- Components are named by what they are ("Button", "Card"), sets list their options clearly.

## Inputs to confirm

- **What becomes a component**, and which existing copies should become its instances.
- **Properties and values** for variants (Style: Primary / Secondary; State: Default / Hover /
  Disabled; Size: Small / Medium / Large).
- **Naming conventions** of the team's library.

## Working method

1. **Read.** `list_components` (components, sets, their variants and options) and
   `get_canvas_document` for the nodes.
   **Check:** you know which nodes are already components and which are copies.
2. **Make components.** `create_component` with the frame's id(s).
   **Check:** `list_components` lists it with its name.
3. **Replace copies with instances.** `create_instance` with `componentId`, `x`, `y`; remove the
   copies once instances stand in their place.
   **Check:** `get_canvas_document` shows instance nodes where the copies were.
4. **Combine versions into variants.** `create_component` each version, then
   `combine_as_variants` with their ids; the set gets generic names ("Property 1", "Default",
   "Variant2"). Rename at once: `rename_variant_property` (`name`, `newName`, `setId`) and
   `rename_variant_value` (`property`, `value`, `newValue`, `setId`).
   **Check:** `list_components` `sets[].options` shows the real names; each variant's `variant`
   map is right.
5. **Add variants.** `add_variant` with `setId` and the new `variant` values (it duplicates the
   default, or `from`); `set_variant_properties` to change a variant's values.
   **Check:** the set lists every combination once.
6. **Maintain instances.** `swap_instance` to another component or variant, `reset_overrides` to
   go back to the main, `push_overrides` to promote an instance's change to the main,
   `go_to_main_component` to edit the source.

## Decision table

| Situation | Tool |
| --- | --- |
| The same element appears several times | `create_component`, then `create_instance` for each use |
| Versions of one element (styles, states, sizes) | `combine_as_variants`, then rename properties and values |
| A new state or size | `add_variant` with `variant` values |
| An instance should look like another variant | `set_instance_properties` or `swap_instance` |
| An instance's change belongs in the main | `push_overrides` |
| An instance drifted by accident | `reset_overrides` |
| One copy must diverge permanently | `detach_instance` (last resort) |

## Recipes

**Card component with two instances.** `create_component` `{ ids: ["card"] }` →
`create_instance` `{ componentId: "card", x: 0, y: 150 }` and `{ componentId: "card", x: 240,
y: 150 }`.

**Primary and Secondary variants.** `create_component` each button → `combine_as_variants`
`{ ids }` → `rename_variant_property` `{ name: "Property 1", newName: "Style", setId }` →
`rename_variant_value` `Default` → `Primary`, `Variant2` → `Secondary`.

**A Disabled variant.** `add_variant` `{ setId, variant: { Style: "Disabled" } }`.

## Pitfalls

- **Copies instead of instances** drift apart and cannot be updated together.
- **Generic variant names** ("Property 1", "Variant2") left after combining make the set unusable;
  rename right away.
- **The rename and add tools need the set** (`setId` from `list_components`) when nothing is
  selected.
- **Duplicate combinations** are refused; every variant needs a unique set of values.
- **Detaching to make a small change** loses future updates; override instead.
- **Combining unrelated components** into one set; a set is one element's versions.

## Tools used

- `list_components`, `inspect_instance`: components, sets, variants and instance status
- `get_canvas_document`: the nodes, to check placement
- `create_component`, `create_instance`: components and their instances
- `combine_as_variants`, `add_variant`, `remove_variant`, `set_variant_properties`: component sets
- `rename_variant_property`, `rename_variant_value`: clear property and value names
- `set_instance_properties`, `swap_instance`, `reset_overrides`, `push_overrides`: instances and overrides
- `detach_instance`, `go_to_main_component`, `restore_main_component`: break links, edit or restore mains
- `undo_canvas`: take back a step
