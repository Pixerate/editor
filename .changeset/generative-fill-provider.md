---
'@pixerate/editor': minor
'@pixerate/editor-svelte': minor
'@pixerate/editor-react': minor
---

Image editor: Generative Fill. Hosts set a `GenerativeFillProvider` (`generativeFill` option or `setGenerativeFillProvider`); `controller.generativeFill(prompt)` sends the layer composite, the selection as a mask and its bounds to it and puts the result on a new layer limited to the selection, as one undo step. Agents get the `generative_fill` tool, and the Selection panel (`<SelectionOptionsBar>`) shows a prompt field and Generative Fill button when a provider is set.
