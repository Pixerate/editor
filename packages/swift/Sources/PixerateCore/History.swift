// Portions ported from filmcraft-main/crates/engine/src/lib.rs, soundcraft-main/crates/engine/src/lib.rs
// and photocraft-main/crates/ops/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors) by
// way of packages/core/src/history/HistoryManager.ts. See THIRD_PARTY_NOTICES.md.

import Foundation

/// The origin of changes no one has claimed: the person at the keyboard.
public let userOrigin = "user"

/// The origin of an agent's changes: `agent:<id>`.
public func agentOrigin(_ agentId: String) -> String { "agent:\(agentId)" }

/// The agent id of an `agent:<id>` origin, or `nil` for any other origin.
public func originAgentId(_ origin: String?) -> String? {
    guard let origin, origin.hasPrefix("agent:") else { return nil }
    let id = String(origin.dropFirst("agent:".count))
    return id.isEmpty ? nil : id
}

/// One undoable change.
public struct Command {
    public var name: String
    public var execute: () -> Void
    public var undo: () -> Void
    /// Default: `execute` again.
    public var redo: (() -> Void)?
    public var tag: String?
    /// Milliseconds since 1970 (default: now).
    public var timestamp: Double?
    /// Approximate memory held by this command, in bytes (for `maxBytes`).
    public var byteSize: Int?
    /// Who made the change: `user` or `agent:<id>`. Falls back to the origin set with `withOrigin`, then `user`.
    public var origin: String?

    public init(name: String, tag: String? = nil, origin: String? = nil, byteSize: Int? = nil, timestamp: Double? = nil, execute: @escaping () -> Void, undo: @escaping () -> Void, redo: (() -> Void)? = nil) {
        self.name = name
        self.execute = execute
        self.undo = undo
        self.redo = redo
        self.tag = tag
        self.timestamp = timestamp
        self.byteSize = byteSize
        self.origin = origin
    }
}

public struct HistoryState: Equatable, Sendable {
    public var canUndo: Bool
    public var canRedo: Bool
    public var undoName: String
    public var redoName: String
    public var undoCount: Int
    public var redoCount: Int
}

/// One row of a History panel (see `HistoryManager.entries`).
public struct HistoryEntry: Equatable, Sendable {
    /// Stable id of the step (unchanged while a gesture merges into it).
    public var id: Int
    /// The step's command name.
    public var label: String
    /// Position in the timeline: undo steps first (oldest = 0), then redo steps.
    public var index: Int
    /// The step that produced the current state (the top of the undo stack).
    public var current: Bool
    /// On the redo stack (undone, can be redone).
    public var undone: Bool
    /// Who made the step: `user` or `agent:<id>`.
    public var origin: String
}

/// What an `onCommit` listener hears.
public enum HistoryCommitKind: String, Sendable {
    case execute, merge, undo, redo, revert, clear
}

public struct HistoryCommitEvent: Equatable, Sendable {
    public var kind: HistoryCommitKind
    /// The step recorded, merged into, undone or redone. `nil` for `revert` and `clear`.
    public var entry: HistoryEntry?
    /// The step's origin for `execute` / `merge`, else the origin in effect.
    public var origin: String
    /// `revision` after the change.
    public var revision: Int
}

/// A point in the undo history, from `mark()`, for `revertTo`. Treat it as opaque.
public struct HistoryMark: Equatable, Sendable {
    let topId: Int?
    let nextId: Int
    let epoch: Int
    let dropped: Int
}

/// One reversible piece of a step. A gesture step holds one part per distinct command.
private struct Part {
    var undo: () -> Void
    var redo: () -> Void
    var tag: String?
    var bytes: Int
}

/// One undo step.
private struct Entry {
    var id: Int
    var name: String
    var tag: String?
    var timestamp: Double
    var parts: [Part]
    var bytes: Int
    var origin: String
}

private func undoParts(_ parts: [Part]) { for p in parts.reversed() { p.undo() } }
private func redoParts(_ parts: [Part]) { for p in parts { p.redo() } }

/**
 UI-agnostic undo / redo, a port of `HistoryManager` in `history/HistoryManager.ts`: command
 closures, transaction batching, coalescing of high-frequency changes, keyed gestures, undo marks,
 a memory budget, a History-panel listing, and the origin of every step (`user` or `agent:<id>`)
 with commit events, so an agent's edits can be told apart from the user's.
 */
public final class HistoryManager {
    private var undoStack: [Entry] = []
    private var redoStack: [Entry] = []
    private let maxDepth: Int
    private let maxBytes: Int
    private let sizeOf: ((Command) -> Int)?
    private let now: () -> Double
    private var isApplying = false
    private var batchDepth = 0
    private var currentBatch: [Command]?
    private var listeners: [UUID: (HistoryState) -> Void] = [:]
    private var commitListeners: [(id: UUID, fn: (HistoryCommitEvent) -> Void)] = []
    /// Origins set by `withOrigin`, innermost last.
    private var origins: [String] = []
    private var cachedEntries: [HistoryEntry]?
    public private(set) var state: HistoryState
    private var nextId = 1
    /// Bumped on every history change (execute, merge, undo, redo, revert, clear).
    public private(set) var revision = 0
    private var epoch = 0
    private var dropped = 0
    private var gestureKey: String?
    private var gestureEntryId: Int?
    private var heldKey: String?

    /**
     - Parameters:
       - maxDepth: undo steps kept (default 50).
       - maxBytes: memory budget for both stacks (0: unlimited); the newest undo step is always kept.
       - sizeOf: measures a command for `maxBytes` (default `byteSize ?? 0`).
       - now: the clock in ms (default the wall clock), for coalescing windows.
     */
    public init(maxDepth: Int = 50, maxBytes: Int = 0, sizeOf: ((Command) -> Int)? = nil, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.maxDepth = maxDepth
        self.maxBytes = max(0, maxBytes)
        self.sizeOf = sizeOf
        self.now = now
        state = HistoryState(canUndo: false, canRedo: false, undoName: "", redoName: "", undoCount: 0, redoCount: 0)
    }

    private func computeState() -> HistoryState {
        HistoryState(canUndo: !undoStack.isEmpty, canRedo: !redoStack.isEmpty, undoName: undoStack.last?.name ?? "", redoName: redoStack.last?.name ?? "", undoCount: undoStack.count, redoCount: redoStack.count)
    }

    private func notify() {
        revision += 1
        state = computeState()
        cachedEntries = nil
        for l in listeners.values { l(state) }
    }

    private func measure(_ c: Command) -> Int {
        let n = sizeOf?(c) ?? c.byteSize ?? 0
        return n > 0 ? n : 0
    }

    private func makeEntry(_ c: Command, _ timestamp: Double) -> Entry {
        let part = Part(undo: c.undo, redo: c.redo ?? c.execute, tag: c.tag, bytes: measure(c))
        defer { nextId += 1 }
        return Entry(id: nextId, name: c.name, tag: c.tag, timestamp: timestamp, parts: [part], bytes: part.bytes, origin: c.origin ?? origin)
    }

    private func record(_ entry: Entry) {
        undoStack.append(entry)
        while undoStack.count > maxDepth {
            undoStack.removeFirst()
            dropped += 1
        }
        redoStack = []
        trim()
    }

    private func trim() {
        guard maxBytes > 0, undoStack.count > 1 else { return }
        var total = byteSize
        while total > maxBytes && undoStack.count > 1 {
            total -= undoStack.removeFirst().bytes
            dropped += 1
        }
    }

    /// Approximate bytes held by the undo and redo stacks (see `maxBytes`).
    public var byteSize: Int { undoStack.reduce(0) { $0 + $1.bytes } + redoStack.reduce(0) { $0 + $1.bytes } }

    private func resetGesture() {
        gestureKey = nil
        gestureEntryId = nil
    }

    /// Executes a command and records it as a step. Clears redo and ends the current gesture.
    public func execute(_ command: Command) {
        if isApplying {
            command.execute()
            return
        }
        if batchDepth > 0, currentBatch != nil {
            command.execute()
            var c = command
            c.timestamp = c.timestamp ?? now()
            c.origin = c.origin ?? origin
            currentBatch!.append(c)
            return
        }
        command.execute()
        let entry = makeEntry(command, command.timestamp ?? now())
        record(entry)
        resetGesture()
        notify()
        emit(.execute, entry.id, entry.origin)
    }

    /**
     Executes a command as part of a continuous interaction (a slider scrub, a drag). With `key`
     (or while a gesture is held), consecutive merged executes with the same key fold into one
     step; without, it coalesces with the previous step of the same `tag` within `windowMs`
     (default 300). A change from another origin never folds in: it starts a new step.
     */
    public func executeMerged(_ command: Command, key optionKey: String? = nil, windowMs: Double = 300) {
        let t = now()
        let key = heldKey ?? optionKey
        let origin = command.origin ?? self.origin
        var command = command
        command.origin = origin

        if let key {
            if isApplying || batchDepth > 0 {
                command.timestamp = t
                execute(command)
                return
            }
            if var top = undoStack.last, gestureKey == key, gestureEntryId == top.id, top.origin == origin {
                command.execute()
                let redo = command.redo ?? command.execute
                let bytes = measure(command)
                let last = top.parts[top.parts.count - 1]
                if let tag = last.tag, tag == command.tag {
                    // The same (absolute) command again: keep the pre-gesture undo, take the new redo.
                    top.parts[top.parts.count - 1] = Part(undo: last.undo, redo: redo, tag: tag, bytes: bytes)
                } else {
                    top.parts.append(Part(undo: command.undo, redo: redo, tag: command.tag, bytes: bytes))
                }
                top.bytes = top.parts.reduce(0) { $0 + $1.bytes }
                top.timestamp = t
                undoStack[undoStack.count - 1] = top
                redoStack = []
                trim()
                notify()
                emit(.merge, top.id, origin)
                return
            }
            command.timestamp = t
            execute(command)
            if let pushed = undoStack.last {
                gestureKey = key
                gestureEntryId = pushed.id
            }
            return
        }

        if let tag = command.tag, let top = undoStack.last, batchDepth == 0, !isApplying {
            let elapsed = t - top.timestamp
            if top.tag == tag, elapsed <= windowMs, top.origin == origin {
                command.execute()
                let initialParts = top.parts
                let bytes = measure(command)
                undoStack[undoStack.count - 1] = Entry(
                    id: top.id, name: command.name, tag: tag, timestamp: t,
                    parts: [Part(undo: { undoParts(initialParts) }, redo: command.redo ?? command.execute, tag: tag, bytes: bytes)],
                    bytes: bytes, origin: origin)
                redoStack = []
                resetGesture()
                trim()
                notify()
                emit(.merge, top.id, origin)
                return
            }
        }
        command.timestamp = t
        execute(command)
    }

    /// Holds a gesture: until `endGesture()`, every `executeMerged` call joins one step.
    public func beginGesture(_ key: String) {
        if heldKey == key { return }
        heldKey = key
        resetGesture()
    }

    /// Ends the current (keyed or held) gesture; the next merged execute starts a new step.
    public func endGesture() {
        heldKey = nil
        resetGesture()
    }

    /// The key of the gesture merging into the top step, if any.
    public var currentGestureKey: String? { heldKey ?? gestureKey }

    /// Batches the commands executed in `body` into one step (the origin of its first command).
    /// When `body` throws, the commands it executed are undone and the error is rethrown.
    public func batch(_ name: String, _ body: () throws -> Void) rethrows {
        if isApplying || batchDepth > 0 {
            try body()
            return
        }
        batchDepth += 1
        currentBatch = []
        do {
            try body()
        } catch {
            let executed = currentBatch ?? []
            batchDepth -= 1
            currentBatch = nil
            rollback(executed)
            throw error
        }
        batchDepth -= 1
        let commands = currentBatch ?? []
        currentBatch = nil
        guard !commands.isEmpty else { return }
        let bytes = commands.reduce(0) { $0 + measure($1) }
        let id = nextId
        nextId += 1
        let origin = commands[0].origin ?? self.origin
        record(Entry(id: id, name: name, tag: nil, timestamp: now(),
                     parts: [Part(undo: { for c in commands.reversed() { c.undo() } }, redo: { for c in commands { (c.redo ?? c.execute)() } }, tag: nil, bytes: bytes)],
                     bytes: bytes, origin: origin))
        resetGesture()
        notify()
        emit(.execute, id, origin)
    }

    private func rollback(_ commands: [Command]) {
        let was = isApplying
        isApplying = true
        defer { isApplying = was }
        for c in commands.reversed() { c.undo() }
    }

    private func undoOne() -> Int {
        let entry = undoStack.removeLast()
        undoParts(entry.parts)
        redoStack.append(entry)
        return entry.id
    }

    private func redoOne() -> Int {
        let entry = redoStack.removeLast()
        redoParts(entry.parts)
        undoStack.append(entry)
        return entry.id
    }

    /// Takes back the top step. `false` when there was nothing to undo.
    @discardableResult
    public func undo() -> Bool {
        guard !undoStack.isEmpty, !isApplying, batchDepth == 0 else { return false }
        isApplying = true
        resetGesture()
        let id = undoOne()
        isApplying = false
        notify()
        emit(.undo, id)
        return true
    }

    /// Re-applies the most recently undone step. `false` when there was nothing to redo.
    @discardableResult
    public func redo() -> Bool {
        guard !redoStack.isEmpty, !isApplying, batchDepth == 0 else { return false }
        isApplying = true
        resetGesture()
        let id = redoOne()
        isApplying = false
        notify()
        emit(.redo, id)
        return true
    }

    /// The current point in the history (its top step), for `revertTo`.
    public func mark() -> HistoryMark {
        HistoryMark(topId: undoStack.last?.id, nextId: nextId, epoch: epoch, dropped: dropped)
    }

    /// Whether `mark` still points into the undo history.
    public func isMarkValid(_ mark: HistoryMark) -> Bool {
        if mark.epoch != epoch { return false }
        guard let top = mark.topId else { return mark.dropped == dropped }
        return undoStack.contains { $0.id == top }
    }

    /// Takes back every step made since `mark` for good (neither undo nor redo keeps them).
    /// Does nothing when `mark` has left the history. Returns how many steps were taken back.
    @discardableResult
    public func revertTo(_ mark: HistoryMark) -> Int {
        guard !isApplying, batchDepth == 0, isMarkValid(mark) else { return 0 }
        let redoBefore = redoStack.count
        var n = 0
        isApplying = true
        resetGesture()
        while let top = undoStack.last, top.id != mark.topId {
            undoParts(top.parts)
            undoStack.removeLast()
            n += 1
        }
        isApplying = false
        // Steps made after the mark are gone for good, including undone ones.
        redoStack = n > 0 ? [] : redoStack.filter { $0.id < mark.nextId }
        if n > 0 || redoStack.count != redoBefore {
            notify()
            emit(.revert)
        }
        return n
    }

    /// The steps for a History panel: undo steps oldest first, then redo steps (the next redo first).
    public var entries: [HistoryEntry] {
        if let cachedEntries { return cachedEntries }
        let u = undoStack.count
        var list = undoStack.enumerated().map { HistoryEntry(id: $1.id, label: $1.name, index: $0, current: $0 == u - 1, undone: false, origin: $1.origin) }
        for e in redoStack.reversed() {
            list.append(HistoryEntry(id: e.id, label: e.name, index: list.count, current: false, undone: true, origin: e.origin))
        }
        cachedEntries = list
        return list
    }

    /// Undoes or redoes until the step at `index` (from `entries`) is current; `-1` undoes
    /// everything. Reports one commit event per step. Returns how many steps were applied.
    @discardableResult
    public func goTo(_ index: Int) -> Int {
        guard !isApplying, batchDepth == 0 else { return 0 }
        let total = undoStack.count + redoStack.count
        let target = max(0, min(total, index + 1))
        if target == undoStack.count { return 0 }
        var steps: [(HistoryCommitKind, Int)] = []
        isApplying = true
        resetGesture()
        while undoStack.count > target { steps.append((.undo, undoOne())) }
        while undoStack.count < target { steps.append((.redo, redoOne())) }
        isApplying = false
        notify()
        for (kind, id) in steps { emit(kind, id) }
        return steps.count
    }

    /// Empties both stacks.
    public func clear() {
        undoStack = []
        redoStack = []
        epoch += 1
        resetGesture()
        notify()
        emit(.clear)
    }

    /// Listens to state changes; the listener is called at once with the current state.
    public func subscribe(_ listener: @escaping (HistoryState) -> Void) -> Cancellable {
        let id = UUID()
        listeners[id] = listener
        listener(state)
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }

    /**
     Listens to each change as it lands: `execute`, `merge`, `undo`, `redo`, `revert`, `clear`,
     with the step and who made it. Not called at subscribe time, and it hears every step of a
     `goTo`.
     */
    public func onCommit(_ listener: @escaping (HistoryCommitEvent) -> Void) -> Cancellable {
        let id = UUID()
        commitListeners.append((id, listener))
        return Cancellable { [weak self] in self?.commitListeners.removeAll { $0.id == id } }
    }

    private func emit(_ kind: HistoryCommitKind, _ entryId: Int? = nil, _ eventOrigin: String? = nil) {
        guard !commitListeners.isEmpty else { return }
        let entry = entryId.flatMap { id in entries.first { $0.id == id } }
        let event = HistoryCommitEvent(kind: kind, entry: entry, origin: eventOrigin ?? origin, revision: revision)
        for l in commitListeners { l.fn(event) }
    }

    /// The origin a change is recorded with when its command names none (see `withOrigin`).
    public var origin: String { origins.last ?? userOrigin }

    private func popOrigin(_ origin: String) {
        if let i = origins.lastIndex(of: origin) { origins.remove(at: i) }
    }

    /// Records the changes `body` makes as made by `origin` (`agent:<id>` for an agent), unless a
    /// command names its own. The outer origin comes back afterwards, also when `body` throws.
    public func withOrigin<T>(_ origin: String, _ body: () throws -> T) rethrows -> T {
        origins.append(origin)
        defer { popOrigin(origin) }
        return try body()
    }

    /// The async form: the origin holds until `body` returns, so anything else recorded on this
    /// history meanwhile is stamped with it too (give those commands an explicit `origin`).
    nonisolated(nonsending)
    public func withOrigin<T>(_ origin: String, _ body: () async throws -> T) async rethrows -> T {
        origins.append(origin)
        defer { popOrigin(origin) }
        return try await body()
    }

    /// A command from before / after snapshots of some state.
    public static func snapshotCommand<T>(name: String, tag: String? = nil, before: T, after: T, apply: @escaping (T) -> Void) -> Command {
        Command(name: name, tag: tag, execute: { apply(after) }, undo: { apply(before) }, redo: { apply(after) })
    }
}
