---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Document paths and a Paths panel for the image editor. Paths are vector outlines kept with the document but on no layer: the Work Path, which Make Work Path traces from the selection and replaces each time until it's saved, and saved paths.

- **What you can do with one:** load it as a selection (Shift adds, Alt subtracts), fill or stroke it on a pixel layer without touching the selection, turn it into a vector mask, rename it (renaming saves the Work Path), duplicate or delete it.
- **Saved with the document:** paths are in undo history, `toJSON` and PSD files, as image resources 2000–2997 for saved paths and 1025 for the Work Path.
- **UI:** `<PathsPanel>` in React and Svelte shows outline thumbnails, under Channels.
- **Agent tools:** `list_paths`, `get_path`, `make_work_path`, `add_path`, `set_path_geometry`, `rename_path`, `duplicate_path`, `delete_path`, `fill_path` and `stroke_path`. `path_to_selection` and `add_vector_mask` take a `pathId`.
- **Controller:** `getPaths`, `getPath`, `setActivePath`, `makeWorkPath`, `addPath`, `setPathGeometry`, `renamePath`, `duplicatePath`, `deletePath`, `loadPathAsSelection`, `fillPath`, `strokePath` and `addVectorMaskFromPath`.
- **Other new exports:** `DocumentPath`, `pathSvgData`, `pathBounds`, `readPaths`, `serializePaths` and `readShapeComponents`.
