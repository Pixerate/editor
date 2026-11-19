import Foundation

// The text change feed (#890), a port of `createTextChangeFeed` (`tools/text-changes.ts`): what
// changed in a text and where, the selection, who made it (`user` or `agent:<id>`), word and
// line boundaries, and when a typing burst ends. It diffs snapshots, so it sees every change
// however it was made. Positions are UTF-16 offsets. `domains/text-proposals` in
// `@pixerate/conformance` checks it against the TS.

/// A selection: `from == to` is a caret.
public struct TextSelection: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public init(from: Int, to: Int) {
        self.from = from
        self.to = to
    }

    var json: JSONValue { ["from": .number(Double(from)), "to": .number(Double(to))] }
}

/// One replaced range: `from..<to` of the text before held `removed` and now holds `inserted`.
public struct TextChangeEdit: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public var removed: String
    public var inserted: String

    public var json: JSONValue {
        ["from": .number(Double(from)), "to": .number(Double(to)), "removed": .string(removed), "inserted": .string(inserted)]
    }
}

/// One change the feed reports (`TextChange`).
public struct TextChange: Sendable {
    /// Counts up from 1 for each change the feed reports.
    public var seq: Int
    /// `user`, or `agent:<id>` when an agent made the change.
    public var origin: String
    /// The history step behind the change, when there was one.
    public var commit: HistoryCommitEvent?
    /// What changed; nil when only the selection changed or a burst ended.
    public var edit: TextChangeEdit?
    /// Set when the selection changed.
    public var selection: (before: TextSelection?, after: TextSelection?)?
    /// The edit finished a word or a line.
    public var boundary: String?
    /// The person is typing: more changes of the same burst will follow.
    public var inGesture: Bool
    /// The typing burst earlier changes reported has ended.
    public var gestureEnded: Bool
    /// Length of the text after the change (UTF-16).
    public var length: Int
    /// Milliseconds since the epoch (the feed's `now`).
    public var at: Double

    /// The change as JSON, in the TS key order, with `commit` as its kind at the end (the contract's shape).
    public var json: JSONValue {
        var o = JSONObject([("seq", .number(Double(seq))), ("origin", .string(origin))])
        if let edit { o["edit"] = edit.json }
        if let selection { o["selection"] = .object(JSONObject([("before", selection.before?.json ?? .null), ("after", selection.after?.json ?? .null)])) }
        if let boundary { o["boundary"] = .string(boundary) }
        o["inGesture"] = .bool(inGesture)
        if gestureEnded { o["gestureEnded"] = .bool(true) }
        o["length"] = .number(Double(length))
        o["at"] = .number(at)
        if let commit { o["commit"] = .string(commit.kind.rawValue) }
        return .object(o)
    }
}

private func isHighSurrogate(_ c: UInt16) -> Bool { c >= 0xD800 && c <= 0xDBFF }
private func isLowSurrogate(_ c: UInt16) -> Bool { c >= 0xDC00 && c <= 0xDFFF }
private func string16(_ u: ArraySlice<UInt16>) -> String { String(decoding: Array(u), as: UTF16.self) }

/**
 * The single range that turns `before` into `after` (`diffText`). With the caret after the
 * change, an ambiguous edit (typing `a` into `aa`) is placed where the caret says.
 */
public func diffText(_ beforeText: String, _ afterText: String, caret: Int? = nil) -> TextChangeEdit? {
    if beforeText == afterText { return nil }
    let before = Array(beforeText.utf16)
    let after = Array(afterText.utf16)
    let delta = after.count - before.count
    var pre = 0
    var maxPre = min(before.count, after.count)
    if let caret { maxPre = min(maxPre, max(0, caret - max(0, delta))) }
    while pre < maxPre && before[pre] == after[pre] { pre += 1 }
    if pre > 0 && pre < before.count && isLowSurrogate(before[pre]) { pre -= 1 }
    var suf = 0
    let maxSuf = min(before.count, after.count) - pre
    while suf < maxSuf && before[before.count - 1 - suf] == after[after.count - 1 - suf] { suf += 1 }
    if suf > 0 && suf < before.count - pre && isHighSurrogate(before[before.count - suf - 1]) { suf -= 1 }
    return TextChangeEdit(from: pre, to: before.count - suf, removed: string16(before[pre ..< before.count - suf]), inserted: string16(after[pre ..< after.count - suf]))
}

/// `/[\p{L}\p{N}_]/u` on one code unit.
private func isWordUnit(_ c: UInt16?) -> Bool {
    guard let c else { return false }
    if c == 0x5F { return true }
    guard let s = Unicode.Scalar(c) else { return false }
    switch s.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
}

/// A replacement widened to whole words; typing and deleting stay as they are (`wholeWords`).
private func wholeWords(_ beforeText: String, _ afterText: String, _ edit: TextChangeEdit?) -> TextChangeEdit? {
    guard let edit, !edit.removed.isEmpty, !edit.inserted.isEmpty else { return edit }
    let before = Array(beforeText.utf16)
    let after = Array(afterText.utf16)
    var from = edit.from
    while from > 0 && isWordUnit(before[from - 1]) { from -= 1 }
    var tail = before.count - edit.to
    while tail > 0 && isWordUnit(before[before.count - tail]) { tail -= 1 }
    return TextChangeEdit(from: from, to: before.count - tail, removed: string16(before[from ..< before.count - tail]), inserted: string16(after[from ..< after.count - tail]))
}

private let WORD_END: Set<UInt16> = Set(" \t\u{0B}\u{0C}\u{A0}\u{FEFF}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}.,;:!?)]}\"'”’…".utf16).union(0x2000 ... 0x200A)

/// Whether an edit finished a word (`word`) or a line (`line`) (`textChangeBoundary`).
public func textChangeBoundary(_ edit: TextChangeEdit) -> String? {
    guard let last = edit.inserted.utf16.last else { return nil }
    if last == 0x0A || last == 0x0D { return "line" }
    return WORD_END.contains(last) ? "word" : nil
}

/// A change feed for a text (`createTextChangeFeed`). Call `check` after the text or selection changes.
public final class TextChangeFeed: @unchecked Sendable {
    private let getText: () -> String
    private let getSelection: (() -> TextSelection?)?
    private let burstMs: Double
    private let now: () -> Double
    private let schedule: (@escaping () -> Void, Double) -> () -> Void
    private var listeners: [(id: UUID, fn: (TextChange) -> Void)] = []
    private var text: String
    private var selection: TextSelection?
    private var seq = 0
    private var pendingCommit: HistoryCommitEvent?
    private var pendingOrigin: String?
    private var inBurst = false
    private var cancelTimer: (() -> Void)?
    private var offHistory: Cancellable?
    private var checkQueued = false

    /**
     * `history` gives each change its origin. `burstMs` is how long the person must stop typing
     * for a burst to end (default 1500; 0 turns bursts off). `schedule` runs a function after
     * a delay in ms and returns a cancel function (default: the main queue).
     */
    public init(getText: @escaping () -> String, getSelection: (() -> TextSelection?)? = nil, history: HistoryManager? = nil, burstMs: Double = 1500, now: (() -> Double)? = nil,
                schedule: ((@escaping () -> Void, Double) -> () -> Void)? = nil) {
        self.getText = getText
        self.getSelection = getSelection
        self.burstMs = burstMs
        self.now = now ?? { Date().timeIntervalSince1970 * 1000 }
        self.schedule = schedule ?? { fn, ms in
            let item = DispatchWorkItem(block: fn)
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000, execute: item)
            return { item.cancel() }
        }
        text = getText()
        selection = getSelection?()
        offHistory = history?.onCommit { [weak self] in self?.noteCommit($0) }
    }

    private func emit(origin: String, commit: HistoryCommitEvent? = nil, edit: TextChangeEdit? = nil, selection: (before: TextSelection?, after: TextSelection?)? = nil, boundary: String? = nil, gestureEnded: Bool = false) -> TextChange {
        seq += 1
        let change = TextChange(seq: seq, origin: origin, commit: commit, edit: edit, selection: selection, boundary: boundary, inGesture: inBurst, gestureEnded: gestureEnded, length: text.utf16.count, at: now())
        for l in listeners { l.fn(change) }
        return change
    }

    private func stopTimer() {
        cancelTimer?()
        cancelTimer = nil
    }

    /// Ends the current typing burst now, reporting `gestureEnded` (e.g. when the editor loses focus).
    @discardableResult
    public func endGesture() -> TextChange? {
        stopTimer()
        guard inBurst else { return nil }
        inBurst = false
        return emit(origin: "user", gestureEnded: true)
    }

    /// Compares the text and selection with the last snapshot and reports the change, if any.
    /// Pass `origin` when the host knows who made it.
    @discardableResult
    public func check(origin: String? = nil) -> TextChange? {
        let nextText = getText()
        let nextSelection = getSelection?()
        let selectionChanged = selection != nextSelection
        let edit = nextText == text ? nil : wholeWords(text, nextText, diffText(text, nextText, caret: nextSelection?.to))
        if edit == nil && !selectionChanged { return nil }
        let beforeSelection = selection
        text = nextText
        selection = nextSelection
        var who = origin
        var commit: HistoryCommitEvent?
        if edit != nil {
            commit = pendingCommit
            pendingCommit = nil
            if who == nil { who = pendingOrigin ?? (commit?.kind == .execute || commit?.kind == .merge ? commit!.origin : "user") }
            pendingOrigin = nil
        }
        let origin = who ?? "user"
        let typing = edit != nil && origin == "user" && burstMs > 0
        var gestureEnded = false
        if edit != nil && !typing && inBurst {
            inBurst = false
            stopTimer()
            gestureEnded = true
        }
        if typing {
            inBurst = true
            stopTimer()
            cancelTimer = schedule({ [weak self] in
                self?.cancelTimer = nil
                self?.endGesture()
            }, burstMs)
        }
        return emit(origin: origin, commit: commit, edit: edit, selection: selectionChanged ? (beforeSelection, nextSelection) : nil, boundary: edit.flatMap(textChangeBoundary), gestureEnded: gestureEnded)
    }

    /// Checks on the next turn of the main queue, coalescing calls: a history step reports its commit
    /// after changing the text, so a change heard from the text is checked once its origin is known.
    public func checkSoon() {
        if checkQueued { return }
        checkQueued = true
        DispatchQueue.main.async { [weak self] in
            self?.checkQueued = false
            self?.check()
        }
    }

    /// Hears each change.
    public func subscribe(_ listener: @escaping (TextChange) -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// Takes a new snapshot without reporting the difference (e.g. after loading a document).
    public func reset() {
        text = getText()
        selection = getSelection?()
        pendingCommit = nil
        pendingOrigin = nil
        inBurst = false
        stopTimer()
    }

    /// Tells the feed about a history step, for the next change's origin.
    public func noteCommit(_ event: HistoryCommitEvent) { pendingCommit = event }

    /// Makes `origin` the origin of the next change (for hosts with their own undo, like `NSUndoManager`).
    public func noteOrigin(_ origin: String) { pendingOrigin = origin }

    /// The last text the feed saw.
    public var currentText: String { text }

    /// Stops listening to the history and the burst timer.
    public func dispose() {
        offHistory?.cancel()
        offHistory = nil
        stopTimer()
        listeners.removeAll()
    }
}
