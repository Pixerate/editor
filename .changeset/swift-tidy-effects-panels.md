---
"@pixerate/swift": minor
---

The Swift paint editor's Effects and Layer styles panels are easier to read. Effect controls are labelled like the web panels ("Scale", not "UScale": `humanizeParameterId` and `effectControlLabel` are new in `PixeratePaint`), choices show readable names, and pickers keep their label on iPadOS. Effect paint has one "Follows" choice (canvas, stroke, path) in place of two switches, shows the effect's name, and no longer wraps its repeat menu. Layer styles show the "Show styles" switch only once a layer has styles. Both panels take `showsHeading: false` for hosts that title the panel themselves.
