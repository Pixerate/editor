import Foundation
import PixerateCore

/// What happened to the paint history (`PaintCommitEvent.kind` in `controller.ts`).
public enum PaintCommitKind: String, Sendable {
    /// A new undo step.
    case execute
    /// Folded into the last step (the later values of one slider drag).
    case merge
    case undo
    case redo
}

/// One change to the paint history, for hosts and change feeds (`onCommit`).
public struct PaintCommitEvent: Equatable, Sendable {
    public var kind: PaintCommitKind
    /// The step's name.
    public var label: String
    /// Who made the step: `user`, or `agent:<id>` (see `withOrigin`). For undo and redo, who undid or redid it.
    public var origin: String

    public init(kind: PaintCommitKind, label: String, origin: String) {
        self.kind = kind
        self.label = label
        self.origin = origin
    }
}

extension PaintEditorController {
    // MARK: - History origin

    /// A stroke is being painted from pointer input (`beginStroke`): more of the same gesture will follow (`stroking` in `controller.ts`).
    public var stroking: Bool { liveStroke != nil }

    /// The origin steps are recorded with now: the innermost `withOrigin`, else `user` (`getOrigin`).
    public var currentOrigin: String { origins.last ?? "user" }

    /**
     * Hears each undo step recorded, undone or redone, with who made it, before `subscribe`'s
     * listeners hear the change. Not called while `previewPaint` paints. Returns the handle that stops it.
     */
    public func onCommit(_ listener: @escaping (PaintCommitEvent) -> Void) -> Cancellable {
        let id = UUID()
        commitListeners.append((id, listener))
        return Cancellable { [weak self] in self?.commitListeners.removeAll { $0.id == id } }
    }

    func notifyCommit(_ event: PaintCommitEvent) {
        if previewing { return }
        for l in commitListeners { l.fn(event) }
    }

    /// Records the steps `body` makes as made by `origin` (`agent:<id>` for an agent). The outer
    /// origin comes back afterwards, also when `body` throws.
    public func withOrigin<T>(_ origin: String, _ body: () throws -> T) rethrows -> T {
        origins.append(origin)
        defer { popOrigin(origin) }
        return try body()
    }

    /// The async form: the origin holds until `body` returns, so anything else recorded meanwhile
    /// (the user's strokes included) is stamped with it too.
    nonisolated(nonsending)
    public func withOrigin<T>(_ origin: String, _ body: () async throws -> T) async rethrows -> T {
        origins.append(origin)
        defer { popOrigin(origin) }
        return try await body()
    }

    private func popOrigin(_ origin: String) {
        if let i = origins.lastIndex(of: origin) { origins.remove(at: i) }
    }

    /// Runs `body` with `emit` held, so a change made of several assignments is announced once, by
    /// the caller, after its commit event. Returns whether anything tried to emit meanwhile.
    @discardableResult
    func holdingEmits(_ body: () -> Void) -> Bool {
        let outer = emitHeld
        emitHeld = false
        emitHold += 1
        body()
        emitHold -= 1
        let held = emitHeld
        emitHeld = outer || (emitHold > 0 && held)
        return held
    }
}
