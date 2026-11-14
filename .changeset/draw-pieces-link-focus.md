---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

Data-visual motion and interaction (closes #812).

- **Draw-on in pieces** (`/animation`): `drawPieces(pieces, { total, at, span, ease })` plans one visual line drawn as several paths (a thin lead-in then a thick span, a strand's back and front runs). Each piece is `{ from, to }` along a shared length; `drawAt(p)` gives every piece's visible length, `stroke-dasharray` and whether it shows, so the pieces draw on as one continuous stroke. Frame-pure: `p = 1` is exactly the line at rest. Any animation easing (springs stay inside the line) or a function. `windows` says where each piece starts and ends in the progress, and `drawPiecesToFlair` turns the plan into Flair draw-ons.
- **Linked focus** (`/tools`): `createLinkFocus({ marks, links, order, labels, dim })` is a headless model. Each mark has keys (`[item]`, `[tag]`, `[item, tag]`); focusing a key lights the marks whose keys are all the key or linked to it (many-to-many), and dims the rest. Arrow keys walk the keys like a chart, Home / End jump, Escape clears, and `describe()` gives a screen-reader sentence. `linkFocusLit` is the pure version.
- React `useLinkFocus` and Svelte `linkFocusOf`: hover, focus-within and Escape bindings with per-mark opacity and a live description.
- Page kit 1.1.0: `drawPieces`, `linkFocus` and `linkFocusLit` in `window.pixerateKit`, with guide rows.
- Swift: `DrawPieces`, `drawPiecesToFlair`, `LinkFocusModel` and `linkFocusLit` in PixerateCore, checked against fixtures recorded from the TypeScript.
- Demo: a Linked focus view on the Page kit tab (projects and skills, hover and arrow keys, draw-on).
