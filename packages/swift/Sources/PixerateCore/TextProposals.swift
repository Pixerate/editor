import Foundation

// Text proposals (#890), a port of `createTextProposals` (`tools/text-proposals.ts`):
// replacements an agent suggests for a range of a text, shown without changing it until they are
// accepted (one undo step made by the proposer, `agent:<id>`) or dismissed. They follow the text
// as it changes, and every proposal ends with an outcome (`accepted`, `rejected`, `stale`,
// `cleared`). Positions are UTF-16 offsets.

/// A replacement of `from..<to` with `replacement`.
public struct TextProposalEdit: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public var replacement: String
}

public struct TextProposal: Equatable, Sendable {
    public var id: String
    /// The range it replaces, kept current as the text changes.
    public var from: Int
    public var to: Int
    /// The text at `from..<to` now.
    public var original: String
    public var replacement: String
    public var title: String
    public var rationale: String?
    public var check: String?
    public var origin: String
    /// Milliseconds since the epoch (the store's `now`).
    public var createdAt: Double

    /// The proposal as the store holds it, in the TS key order.
    public var json: JSONValue {
        var o = JSONObject([("id", .string(id)), ("from", .number(Double(from))), ("to", .number(Double(to))), ("original", .string(original)), ("replacement", .string(replacement)), ("title", .string(title))])
        if let rationale { o["rationale"] = .string(rationale) }
        if let check { o["check"] = .string(check) }
        o["origin"] = .string(origin)
        o["createdAt"] = .number(createdAt)
        return .object(o)
    }
}

/// How a proposal ended.
public enum TextProposalOutcome: String, Sendable {
    case accepted, rejected, stale, cleared
}

public struct TextProposalOutcomeEvent: Sendable {
    public var proposal: TextProposal
    public var outcome: TextProposalOutcome
    public var at: Double
}

/// What accepting a proposal changed.
public struct TextProposalAcceptResult: Sendable {
    public var proposalId: String
    /// The range the replacement now occupies.
    public var from: Int
    public var to: Int
    public var text: String
    /// The name of the undo step it became.
    public var historyLabel: String
    public var origin: String

    public var json: JSONValue {
        .object(JSONObject([("proposalId", .string(proposalId)), ("from", .number(Double(from))), ("to", .number(Double(to))), ("text", .string(text)), ("historyLabel", .string(historyLabel)), ("origin", .string(origin))]))
    }
}

private func clip(_ text: String, _ max: Int = 40) -> String {
    let u = Array(text.utf16)
    return u.count > max ? String(decoding: u.prefix(max - 1), as: UTF16.self) + "…" : text
}

/// The default title of a proposal (`textProposalTitle`).
public func textProposalTitle(_ original: String, _ replacement: String) -> String {
    if original.isEmpty { return "Insert \"\(clip(replacement))\"" }
    if replacement.isEmpty { return "Delete \"\(clip(original))\"" }
    return "Replace \"\(clip(original))\" with \"\(clip(replacement))\""
}

private func slice(_ u: [UInt16], _ from: Int, _ to: Int) -> String { String(decoding: u[from ..< to], as: UTF16.self) }

/// `text.indexOf(needle, from)` by UTF-16 unit.
private func indexOf(_ text: [UInt16], _ needle: [UInt16], from: Int) -> Int {
    guard needle.count <= text.count else { return -1 }
    var i = max(0, from)
    while i + needle.count <= text.count {
        if text[i ..< i + needle.count].elementsEqual(needle) { return i }
        i += 1
    }
    return -1
}

/// A store of agent-suggested text replacements (`createTextProposals`).
public final class TextProposals {
    private let getText: () -> String
    private let applyEdit: (TextProposalEdit, _ name: String, _ origin: String) throws -> Void
    private let readOnly: () -> String?
    private let defaultOrigin: String
    private let makeId: () -> String
    private let now: () -> Double
    private var known: String
    private var listeners: [(id: UUID, fn: ([TextProposal]) -> Void)] = []
    private var outcomeListeners: [(id: UUID, fn: (TextProposalOutcomeEvent) -> Void)] = []

    /// Pending proposals, in the order they were made.
    public private(set) var proposals: [TextProposal] = []

    /**
     * `applyEdit` applies an accepted proposal as one undo step named `name`, made by `origin`.
     * `readOnly` says why accepting is refused, or nil. `origin` is for proposals that name none.
     */
    public init(getText: @escaping () -> String, applyEdit: @escaping (TextProposalEdit, _ name: String, _ origin: String) throws -> Void, readOnly: @escaping () -> String? = { nil },
                origin: String = "agent:anonymous", idGenerator: (() -> String)? = nil, now: (() -> Double)? = nil) {
        self.getText = getText
        self.applyEdit = applyEdit
        self.readOnly = readOnly
        defaultOrigin = origin
        makeId = idGenerator ?? { "text-proposal-\(UUID().uuidString.prefix(8).lowercased())" }
        self.now = now ?? { Date().timeIntervalSince1970 * 1000 }
        known = getText()
    }

    private func set(_ next: [TextProposal]) {
        proposals = next
        for l in listeners { l.fn(next) }
    }

    private func report(_ proposal: TextProposal, _ outcome: TextProposalOutcome) {
        let event = TextProposalOutcomeEvent(proposal: proposal, outcome: outcome, at: now())
        for l in outcomeListeners { l.fn(event) }
    }

    /// Hears the pending proposals whenever they change.
    public func subscribe(_ listener: @escaping ([TextProposal]) -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// Hears how each proposal ends.
    public func onOutcome(_ listener: @escaping (TextProposalOutcomeEvent) -> Void) -> Cancellable {
        let id = UUID()
        outcomeListeners.append((id, listener))
        return Cancellable { [weak self] in self?.outcomeListeners.removeAll { $0.id == id } }
    }

    public func get(_ id: String) -> TextProposal? { proposals.first { $0.id == id } }

    /// Brings the proposals up to date with the text. Returns the ids dropped as stale.
    @discardableResult
    public func sync() -> [String] {
        let textString = getText()
        if textString == known { return [] }
        let edit = diffText(known, textString)
        known = textString
        guard let edit, !proposals.isEmpty else { return [] }
        let text = Array(textString.utf16)
        let delta = edit.inserted.utf16.count - edit.removed.utf16.count
        let changedTo = edit.from + edit.inserted.utf16.count
        var kept: [TextProposal] = []
        var stale: [TextProposal] = []
        for p in proposals {
            if p.to < edit.from || (p.to == edit.from && (p.from < p.to || edit.to > edit.from)) {
                kept.append(p)
                continue
            }
            if p.from >= edit.to && !(p.from == edit.to && p.from == p.to && edit.from == edit.to) {
                var moved = p
                moved.from += delta
                moved.to += delta
                kept.append(moved)
                continue
            }
            let original = Array(p.original.utf16)
            let at = original.count >= 3 ? indexOf(text, original, from: max(0, edit.from - original.count)) : -1
            if at >= 0 && at <= changedTo && indexOf(text, original, from: at + 1) < 0 {
                var moved = p
                moved.from = at
                moved.to = at + original.count
                kept.append(moved)
            } else {
                stale.append(p)
            }
        }
        set(kept)
        stale.forEach { report($0, .stale) }
        return stale.map(\.id)
    }

    private func find(_ id: String) throws -> TextProposal {
        guard let p = get(id) else {
            let ids = proposals.map(\.id)
            throw ToolHandlerError("No text proposal \"\(id)\". \(ids.isEmpty ? "There are no pending proposals." : "Pending proposals: \(ids.joined(separator: ", ")).") Call list_text_proposals for ids; a proposal is dropped when the text it would replace is edited.")
        }
        return p
    }

    /// Stages a proposal. Throws, changing nothing, when the range is out of bounds, the text there
    /// is not `expected`, or it changes nothing.
    @discardableResult
    public func propose(from: Int, to: Int, replacement: String, expected: String? = nil, title: String? = nil, rationale: String? = nil, check: String? = nil, origin: String? = nil) throws -> TextProposal {
        sync()
        let text = Array(known.utf16)
        guard from >= 0, to >= from, to <= text.count else {
            throw ToolHandlerError("The range \(from)–\(to) is not in the text, which is \(text.count) UTF-16 code units long; from and to must be whole numbers with 0 ≤ from ≤ to ≤ \(text.count).")
        }
        let original = slice(text, from, to)
        if let expected, expected != original {
            throw ToolHandlerError("The text at \(from)–\(to) is \"\(clip(original, 80))\", not \"\(clip(expected, 80))\": it changed since you read it. Read the text again and propose with the new range.")
        }
        if original == replacement { throw ToolHandlerError("The replacement is the text already at \(from)–\(to), so the proposal would change nothing.") }
        let trimmed = title?.jsTrimmed ?? ""
        var id = makeId()
        while get(id) != nil { id = makeId() }
        let proposal = TextProposal(
            id: id, from: from, to: to, original: original, replacement: replacement,
            title: trimmed.isEmpty ? textProposalTitle(original, replacement) : trimmed,
            rationale: rationale?.isEmpty == false ? rationale : nil,
            check: check?.isEmpty == false ? check : nil,
            origin: origin ?? defaultOrigin,
            createdAt: now()
        )
        set(proposals + [proposal])
        return proposal
    }

    /// Applies the proposal as one undo step by its origin and drops it.
    @discardableResult
    public func accept(_ id: String) throws -> TextProposalAcceptResult {
        sync()
        let proposal = try find(id)
        if let reason = readOnly() { throw ToolHandlerError(reason) }
        let text = Array(known.utf16)
        if proposal.to > text.count || slice(text, proposal.from, proposal.to) != proposal.original {
            set(proposals.filter { $0.id != id })
            report(proposal, .stale)
            throw ToolHandlerError("The text proposal \"\(id)\" would replace text that has changed, so it was dropped. Propose again from the current text.")
        }
        set(proposals.filter { $0.id != id })
        try applyEdit(TextProposalEdit(from: proposal.from, to: proposal.to, replacement: proposal.replacement), proposal.title, proposal.origin)
        sync()
        report(proposal, .accepted)
        return TextProposalAcceptResult(proposalId: id, from: proposal.from, to: proposal.from + proposal.replacement.utf16.count, text: proposal.replacement, historyLabel: proposal.title, origin: proposal.origin)
    }

    /// Drops the proposal without changing the text.
    @discardableResult
    public func reject(_ id: String) throws -> TextProposal {
        sync()
        let proposal = try find(id)
        set(proposals.filter { $0.id != id })
        report(proposal, .rejected)
        return proposal
    }

    /// Drops every proposal (or those of one origin). Returns the ids dropped.
    @discardableResult
    public func clear(origin: String? = nil) -> [String] {
        let dropped = proposals.filter { origin == nil || $0.origin == origin }
        if !dropped.isEmpty {
            let ids = Set(dropped.map(\.id))
            set(proposals.filter { !ids.contains($0.id) })
            dropped.forEach { report($0, .cleared) }
        }
        return dropped.map(\.id)
    }
}
