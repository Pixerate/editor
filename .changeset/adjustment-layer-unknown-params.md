---
"@pixerate/editor": patch
---

`add_adjustment_layer` and `apply_selection_as_mask` now refuse `params` that would be dropped, naming each unknown or mistyped key and listing the accepted shape. An agent that passed `{ "master.gamma": 1.18 }` used to get a Levels layer that changed nothing and no error.
