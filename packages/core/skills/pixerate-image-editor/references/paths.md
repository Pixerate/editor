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
5. **Hybrid vector masks**: a vector mask's segments can each have their own edge.
   `set_vector_mask_edge` makes a segment `feather` (a soft falloff of `radius` px) or `matte` (a
   corridor `inner` px inside to `outer` px outside, solved from the layer's colours, for hair and
   fur); the rest stay `hard`. In the editor, Alt+Shift-click a vector mask segment with Direct
   Selection to cycle hard → feather → matte. Edges are addressed by segment index, so after adding
   or deleting anchors on that subpath, check `get_vector_mask` `edges` and set them again.
