---
"@pixerate/editor": minor
---

Add image editor toolbar descriptors: `IMAGE_TOOL_GROUPS` and `imageToolGroup()` (Photoshop-style tool groups), `imageToolLabel()`, `IMAGE_TOOL_SHORTCUTS` and `imageToolForShortcut()`, and `imageToolCanvasMode()`, `imageToolPanel()` and `imagePanelTool()`, which link each tool to the canvas mode it draws in and the `layerPanels` panel holding its options. Hosts can build a toolbar where picking a tool opens its panel.
