---
"@pixerate/swift": minor
---

**Swift vector editor: frames, pages, connectors, snapping options and perspective grids (#624).**

- Frames (`Frames.swift`): `vectorFrameDrawn` (a frame as its clip group of fill, master art and children), `sanitizeVectorFrame`, `sanitizeVectorResizing`, `vectorBoundsInside`, `vectorFrameDocument`; frames now draw, bound and mask through it in appearance, masks, render data (a clip mask in render data) and SVG export (a `<g data-vector-frame>` with its clip path) and import.
- Pages and master pages (`Pages.swift`): `vectorPages`, `vectorMasterPages`, `vectorMasterArt` (laid out by resizing constraints, `{page}` / `{pages}` filled in) and `resolveVectorMasterPages`, run after every edit and stripped from saved documents.
- Connectors (`Connectors.swift`): connection sites, straight / elbow / curved routes, `routeVectorConnector` and `rerouteVectorConnectors` after every edit (after the constraint solve), glue to deleted objects dropped; `data-vector-connector` and `data-vector-resizing` in the SVG round trip.
- Perspective grids (`Perspective.swift`): planes, plane maps, flat-to-plane and back, projected paths, grid lines and presets; `vectorPolarAngles` (`Snap.swift`) and the TS snap defaults.
- The controller has `addFrame`, `frameSelection`, `setFrame`, `setResizing`, `getFrames`, `frameToSvg`, `addPage`, `addMasterPage`, `setPageMaster`, `movePage`, `goToPage`, `getPages`, `addConnector`, `setConnector`, `getConnectors`, `getConnectionSites`, `setConnectorRoute`, `setSnap`, `setPerspective`, `setPerspectivePlane`, `attachToPerspective`, and a `viewport` that `goToPage`, `setViewport` and `zoomToFit` move. The 23 frame, page, connector, snapping and perspective commands run, and the `frames-pages-connectors` scenario passes (12 of 15 vector scenarios).
