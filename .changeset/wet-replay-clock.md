---
"@pixerate/editor": patch
"@pixerate/swift": patch
"@pixerate/conformance": patch
---

Paint editor: replays of wet paint keep to the wet clock it was painted at, across pen-up, saves and sessions (#720), so the other colour scheme of a reopened wet painting matches painting it fresh in that scheme.

- A wet stroke whose pen lifted after the simulation ran on past its last point records the clock its end was applied at (`RecordedStroke.endStep`, saved only then). The colour-scheme replay (live and after a reload), `renderHighRes` and the time-lapse step to it before ending the stroke.
- Paint that flowed on after the last logged stroke or event is replayed after a reload: saves write the wet clock (`wet.clock`) when it is past the latest clock the saved log records, inline and through the asset store. `renderHighRes` and the time-lapse of the live painting let the paint flow on to the editor's clock too.
- The wet clock no longer starts again at 0 when a document is reopened (or when the simulation is made again after a resize or a new canvas): it goes on from the saved clock (else the log's latest), so strokes of a later session come after those of an earlier one. Before, the scheme view of a document painted across sessions never got ready (its replay rolled back for ever). The opened log ends with a `dry` of every layer at that clock (the save dried the paint there), which a save of the unchanged document doesn't write.
- Documents saved before this, painted across sessions (clocks that start again at 0), are put in order when opened: a `dry` at each session break, and the later session's clocks moved to go on from the next multiple of the wet free interval. Documents without these cases keep their pixels and saved files.
- Swift: the same recording, saving, opening and replays. Conformance: new `color-scheme-wet-clock` scenario.
