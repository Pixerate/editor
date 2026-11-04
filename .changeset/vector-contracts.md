---
"@pixerate/editor": minor
---

**Vector:** the vector editor's contracts are now exported to `@pixerate/conformance` (`domains/vector`), the first step of its Swift port (#619). They cover:

- **Commands:** all 148 commands with their params schemas.
- **Tools:** the command, effect and generation tools.
- **UI tables:** the tool bar, menus, control specs and labels.
- **Documents:** a JSON Schema of a saved drawing.

New exports:

- **`vectorContracts()`:** the contract files.
- **`createVectorConformanceHost()`:** an editor for replaying recorded scenarios, with counter node ids and the metric text shaper.
- **`FAKE_VECTOR_ART_MODELS` / `fakeVectorArtGenerator`:** offline generation for contracts and tests.
