---
"@pixerate/editor": minor
---

House style: saving and removing style skills, a document layer, and an authoring skill (#777).

- `StyleStore` gains optional `save(name, files, { replace })` and `remove(name)`; `memoryStyleStore` implements both and `toJSON()`, so a document can carry its own style layer (`memoryStyleStore(json.files, json.state)` restores it).
- `saveStyleSkill(styles, name, files, { layer, replace })` checks the skill exactly as the resolver will load it and writes nothing unless it loads cleanly (or when an earlier locked layer holds the name); files merge over the layer's copy unless `replace`. `removeStyleSkill` deletes a layer's copy and says which layer still provides one. `StyleResolver.limits` exposes the limits in force.
- Agent tools `save_style` and `remove_style`, offered only when a layer can be written.
- New workflow skill `pixerate-style-authoring` (write, fix and save a house style with the user, choose a look) with three evals, and a `style` eval fixture (`StyleEvalFixture`).
