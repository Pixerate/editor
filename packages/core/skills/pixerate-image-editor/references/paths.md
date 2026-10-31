# Paths

Document paths are vector outlines kept with the document but on no layer (Photoshop's Paths
panel). The Work Path is the scratch path; saved paths stay until deleted.

1. **Keep outlines as paths**: `make_work_path` turns the selection into the Work Path (the next
   one replaces it; `rename_path` saves it), `add_path` adds one from geometry.
2. **Use them**: `path_to_selection` / `add_vector_mask` with `pathId`, `fill_path`, `stroke_path`.
3. **Edit anchors** as the Pen and Direct Selection tools do: `get_path` → change anchors and
   handles → `set_path_geometry` (one undo step); shapes `set_shape_component`, vector masks
   `set_vector_mask_path`.
4. **Read first**: `list_paths` for ids, names and bounds; `get_path` for the `components` to edit.
