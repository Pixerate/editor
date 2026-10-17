---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent edits to Mermaid diagrams can now be acted out by a cursor (ported from Ursula's remote control): `DiagramDirector` moves, clicks, drags, connects and types on the canvas, draws a whole-diagram write statement by statement (`draftFrames`), and commits each call as one undo step (rolled back if the diagram changed underneath). Pass it to `createDiagramToolProvider({ director })`. The presence store, clock, cursor tween and per-actor queue (`PresenceStore`, `PerformanceQueue`, `createInstantPresenceClock`) move to `@pixerate/editor/animation` and are shared with `ChartDirector`, which now hides cursors after `linger` as documented. React adds `useDiagramDirector` and `<DiagramPresenceLayer>`; Svelte adds `createDiagramDirector` and `<DiagramPresenceLayer>`.
