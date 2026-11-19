// Text proposals and the text change feed for a Markdown text (#890): `TextProposals` and
// `TextChangeFeed` (PixerateCore) over a `MarkdownTextHost`, so Swash's writing partner and
// jazz suggest edits the person takes or leaves, and follow what the person writes.

import Foundation
import PixerateCore

/**
 * Text proposals on a Markdown host: an accepted proposal is one `host.apply` step named by its
 * title, with `origin` set to the proposer (`agent:<id>`), the selection kept in place. Accepting
 * is refused while the host is read-only. Call `sync()` (or let the feed do it, see
 * `createMarkdownTextChangeFeed`) after the text changes, so proposals follow it.
 */
public func createMarkdownTextProposals(_ host: MarkdownTextHost, origin: String = "agent:anonymous", idGenerator: (() -> String)? = nil, now: (() -> Double)? = nil) -> TextProposals {
    TextProposals(
        getText: { host.markdown },
        applyEdit: { edit, name, origin in
            let e = MarkdownTextEdit(range: NSRange(location: edit.from, length: edit.to - edit.from), replacement: edit.replacement)
            try host.apply(MarkdownTextChange(edits: [e], selection: mapRange(host.selectedRange, through: [e]), actionName: name, origin: origin))
        },
        readOnly: { host.readOnlyReason.map { $0.isEmpty ? "The text is read-only, so the proposal cannot be accepted." : $0 } },
        origin: origin,
        idGenerator: idGenerator,
        now: now
    )
}

/**
 * The change feed of a Markdown host. The host calls `check(origin:)` after each change (with
 * the origin when it knows it, e.g. the `MarkdownTextChange.origin` it just applied) or
 * `checkSoon()` from a text-storage callback. `proposals`, when given, are synced on every change.
 */
public func createMarkdownTextChangeFeed(_ host: MarkdownTextHost, proposals: TextProposals? = nil, history: HistoryManager? = nil, burstMs: Double = 1500, now: (() -> Double)? = nil) -> TextChangeFeed {
    let feed = TextChangeFeed(
        getText: { host.markdown },
        getSelection: { let r = host.selectedRange; return TextSelection(from: r.location, to: NSMaxRange(r)) },
        history: history,
        burstMs: burstMs,
        now: now
    )
    if let proposals { _ = feed.subscribe { change in if change.edit != nil { proposals.sync() } } }
    return feed
}
