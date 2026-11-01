---
'@pixerate/editor': minor
'@pixerate/editor-svelte': minor
---

Hosts that build their own image editor sidebar from `layerPanels` now get every selection and masking panel the editor's own `ImageEditor` shows, and agents find workflow skills from discovery.

- **Panels:** `layerPanels` adds `channels` and `paths` after `selection` for every layer and with none, and shows `mask` ("Mask & Edges") for a layer with a painted or a vector mask. Svelte's `LayerPanel` renders them: `selection` now includes Refine Edge (Check Edge, Show Last Change, Separate Subject, only uncertain areas), `channels` the Channels panel, `paths` the Paths panel, and `mask` the vector mask's soft edges and the layer's Edge Colour. Before, `mask` rendered a placeholder.
- **Tool panels:** `imageToolPanel` maps the Pen, Path Selection and Direct Selection tools to `paths`.
- **Playback:** `compare_selections`, the selection recipe tools, `freeze_selection` and `separate_subject` play in the Select panel, and `set_edge_*` in Layers. A test now fails when a new write tool has no playback panel.
- **Workflow skills in discovery:** `listSkills` reads `metadata.kind` and `metadata.reference` (`SkillInfo.kind`, `SkillInfo.reference`; `parseSkillFrontmatter` returns `metadata`). `list_toolsets` lists each toolset's workflow skills as `workflows`, and `get_skill` and `pixerate-agent-tools` say to read the one that matches the job.
- **Skill evals for agent harnesses:** the workflow skill eval runner is exported from `@pixerate/editor/tools`: `listSkillEvals`, `imageEvalFixturePixels`, `callEvalTool`, `failedEvalChecks`, `matchesEvalExpectation` and the `SkillEval` types. An app runs the same `evals/*.json` with its own agent in place of the known-good solution.
