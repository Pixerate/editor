---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Live selections, a prototype of #392 item B. A selection now keeps its recipe, the steps that made it, beside its bitmap. The bitmap is still what every other command uses.

**Recording:** each of these commands records a JSON step when it changes the selection:
- marquees and polygons
- the magic wand
- Color Range and its presets
- Select All and Inverse
- modify
- a plain colour refine

A replacing shape starts a new recipe. Any other change drops the recipe, leaving the selection frozen: quick, object, subject, sky and focus selections, Quick Mask painting, loaded masks and channels, or refining with edits.

**Editing:** `get_selection_recipe`, `edit_selection_step`, `insert_selection_step`, `remove_selection_step` and `freeze_selection` (plus the matching controller methods and `setSelectionRecipe`) change a step and replay the recipe from scratch as one undo step. Steps are checked first and nothing changes on an error.

**Saving:** recipes are part of undo history and saved in documents.

**Core:** `readRecipeStep`, `replaySelectionRecipe`, `describeRecipeStep` and `recipeStepSetting`.

**React and Svelte:** `SelectionRecipePanel` (Selection steps in the Selection panel) lists the steps, edits each one's mode and main setting, removes steps and freezes.
