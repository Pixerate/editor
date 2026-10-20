---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Live vector symmetry groups.

- **Modes:** mirror (vertical, horizontal, four quarters or diagonal) or radial, with an optional kaleidoscope mirror. Copies follow every edit.
- **Draw inside:** new pen, pencil, shape and text art goes into the group and is mirrored as it is drawn.
- **Release or Expand:** stop repeating, or keep the copies as real objects.
- **New agent commands:** `vector.makeSymmetry`, `vector.setSymmetry`, `vector.releaseSymmetry`, `vector.enterSymmetry` and `vector.exitSymmetry`.
- `vector.addShape` and `vector.addPath` take a `parentId`.
- **New components:** `VectorSymmetryPanel` for React and Svelte.
