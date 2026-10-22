---
"@pixerate/editor": minor
---

`canvas_add_node` places new nodes by their own size (not the 200×60 default) and accepts a `visibleRect` planner option (a rect or a getter, passed through `createEditorMcpToolProvider`'s `plannerOptions`): unanchored nodes then land in free space at the centre of the user's view instead of beside the last node. New `placeInView` layout helper. The cursor plan uses the same placement, so playback still lands where the node does.
