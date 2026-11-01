---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor tools grouped by intent. `IMAGE_TOOL_GROUPS` is now Move, Select, Crop, Draw (Brush, Pencil, Mixer), Erase (Eraser, History Brush), Retouch (with `sections` Fix, Tone and Detail), Shape, Paths (Pen, Path Selection, Direct Selection), Type and Eyedropper. The `line`, `arrow`, `rect` and `circle` annotations leave the toolbar (the Shape tool's live shapes cover them) but still draw for API callers, and `pen` is labelled Pencil.

- `imageToolVariants(tool)`: the selection tools (`SELECTION_TOOLS`) and shape kinds a toolbar can offer as tools of their own.
- `imageToolPanels(tool, layer, options)`: the panels for the active tool and layer, the tool's own first. Brush Options only show with a paint tool, Selection and Channels with Select, Composition Size with Crop and Paths with the path tools. `imageToolPanelIds` and `imagePanelTool` also cover Channels.
- `imageToolUsesColor(tool)`: whether a tool puts down a colour the host chooses.
- New `eyedropper` tool (shortcut I, canvas mode `sample`). `controller.sampleColor(point, { size, setForeground })` reads the composite colour, the `sample_color` agent tool calls it, and `ImageEditorCanvas` picks colours in `sample` mode (`onsample` in Svelte, `onSample` in React).
- `layerPanels` lists a `color` panel ("Color Adjustments") for pixel and smart layers. Svelte's `LayerPanel` renders it with the histogram and colour adjustment sliders, without Add Adjustment Layer.
- Svelte `LayerPanel` takes bindable `selectionOptions`, `shapeOptions` and `typeOptions`, so a host can share them with the canvas. Before this, options picked in the Selection or Shape panel never reached the host's canvas.
- `PresenceLayer` takes a `cursor` snippet (Svelte) or `renderCursor` (React) to draw a host's own agent cursor, and `ImageEditorCanvas` passes one through (`presenceCursor` / `renderPresenceCursor`).
- The `margin` fit keeps a gutter of at least `MARGIN_FIT_MIN_GUTTER` (36 px), so the Free Transform rotate handle stays inside a small view.
