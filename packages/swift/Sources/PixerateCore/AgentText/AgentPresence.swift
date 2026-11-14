import Foundation

// Where agents are in a text, for an overlay to draw (#878): a port of the parts of
// `tools/presence.ts` and `extensions/agent-caret.ts` that aren't about a particular editor.
// Positions are the host's text offsets (UTF-16 for a String); the host maps them to rectangles
// and draws the caret, its name tag, the selection and the tint on what the agent just changed.

/// Time for performances: real time, or an instant clock for tests and recordings.
public protocol PresenceClock: AnyObject {
    /// Milliseconds since some fixed point.
    func now() -> Double
    /// Waits `ms` milliseconds. Throws `CancellationError` when the task is cancelled.
    func wait(_ ms: Double) async throws
}

/// Real time (`ContinuousClock`).
public final class RealPresenceClock: PresenceClock, @unchecked Sendable {
    private let start = ContinuousClock.now

    public init() {}

    public func now() -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
    }

    public func wait(_ ms: Double) async throws {
        guard ms > 0 else { try Task.checkCancellation(); return }
        try await Task.sleep(for: .milliseconds(ms))
    }
}

/// A clock whose waits finish at once while its time still advances (repeatable performances).
public final class InstantPresenceClock: PresenceClock, @unchecked Sendable {
    private var time: Double
    private let start: Double

    public init(start: Double = 0) {
        self.time = start
        self.start = start
    }

    public func now() -> Double { time }

    public func wait(_ ms: Double) async throws {
        try Task.checkCancellation()
        time += max(0, ms)
    }

    /// Time that has passed since the clock was made, in ms.
    public var elapsed: Double { time - start }
}

public let defaultAgentCaretColor = "#8b5cf6"
public let defaultAgentCaretName = "Agent"

/// An agent's caret in a text: where it is, what it has selected and what it just changed.
public struct AgentCaret: Sendable, Equatable, Identifiable {
    /// Stable id of the agent (one caret per id).
    public var id: String
    /// Name on the caret's tag.
    public var name: String
    /// CSS colour of the caret, tag and highlights (`#rrggbb`).
    public var color: String
    /// Selection anchor.
    public var anchor: Int
    /// Selection head, where the caret is drawn.
    public var head: Int
    /// Ranges the agent just changed, tinted until cleared.
    public var changed: [NSRange]

    public init(id: String, name: String = defaultAgentCaretName, color: String = defaultAgentCaretColor,
                anchor: Int, head: Int? = nil, changed: [NSRange] = []) {
        self.id = id
        self.name = name
        self.color = color
        self.anchor = anchor
        self.head = head ?? anchor
        self.changed = changed
    }

    /// The selected range (empty at the caret).
    public var selection: NSRange {
        NSRange(location: min(anchor, head), length: abs(head - anchor))
    }
}

/// Who an agent is, for its caret.
public struct AgentCaretInfo: Sendable, Equatable {
    public var id: String
    public var name: String
    public var color: String

    public init(id: String, name: String = defaultAgentCaretName, color: String = defaultAgentCaretColor) {
        self.id = id
        self.name = name
        self.color = color
    }
}

/// The agents' carets in one text, for an overlay. Listeners hear every change, on the main actor.
@MainActor
public final class AgentCaretStore {
    public private(set) var carets: [AgentCaret] = []
    private var listeners: [UUID: ([AgentCaret]) -> Void] = [:]

    public init() {}

    public func caret(_ id: String) -> AgentCaret? { carets.first { $0.id == id } }

    /// Shows or moves an agent's caret; `anchor != head` also highlights its selection. Its changed
    /// ranges are kept.
    public func set(_ agent: AgentCaretInfo, anchor: Int, head: Int? = nil) {
        if let index = carets.firstIndex(where: { $0.id == agent.id }) {
            carets[index].name = agent.name
            carets[index].color = agent.color
            carets[index].anchor = anchor
            carets[index].head = head ?? anchor
        } else {
            carets.append(AgentCaret(id: agent.id, name: agent.name, color: agent.color, anchor: anchor, head: head))
        }
        notify()
    }

    /// Tints ranges an agent just changed, replacing its previous ones; `[]` clears them.
    public func markChanges(_ id: String, _ ranges: [NSRange]) {
        guard let index = carets.firstIndex(where: { $0.id == id }) else { return }
        carets[index].changed = ranges
        notify()
    }

    /// Removes one agent's caret, or every caret when `id` is nil.
    public func clear(_ id: String? = nil) {
        let before = carets.count
        carets.removeAll { id == nil || $0.id == id }
        if carets.count != before { notify() }
    }

    /// Moves every caret and changed range through an edit someone made: `range` (UTF-16) became
    /// `length` long. Positions inside the replaced range go to its end.
    public func mapThroughEdit(range: NSRange, length: Int) {
        guard !carets.isEmpty else { return }
        let delta = length - range.length
        let map = { (position: Int) -> Int in
            if position <= range.location { return position }
            if position >= NSMaxRange(range) { return position + delta }
            return range.location + length
        }
        for index in carets.indices {
            carets[index].anchor = map(carets[index].anchor)
            carets[index].head = map(carets[index].head)
            carets[index].changed = carets[index].changed.map {
                let start = map($0.location)
                return NSRange(location: start, length: max(0, map(NSMaxRange($0)) - start))
            }
        }
        notify()
    }

    /// Calls `listener` with the carets after every change. Keep the token; `unsubscribe` with it.
    @discardableResult
    public func subscribe(_ listener: @escaping ([AgentCaret]) -> Void) -> UUID {
        let token = UUID()
        listeners[token] = listener
        return token
    }

    public func unsubscribe(_ token: UUID) { listeners[token] = nil }

    private func notify() {
        let carets = self.carets
        for listener in listeners.values { listener(carets) }
    }
}
