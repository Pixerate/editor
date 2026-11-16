---
"@pixerate/editor": patch
---

Diagram UI components keep their labels readable in any brand colours (#819). The mind map's root now fills with the `ink` role (labelled in `surface`) instead of `border`, which design systems keep as a faint hairline. Timeline periods and mind-map branches label their boxes in the scene's palette text colour, so a palette colour too close to it (a near-black brand primary as `accent`, say) is lightened or darkened, keeping its hue, until the label meets WCAG AA, on the period's box and on its events' washed boxes alike. New `diagramReadableFill`; timeline events' wash is `TIMELINE_EVENT_WASH`. `timeline` and `mindmap` render versions are 2.
