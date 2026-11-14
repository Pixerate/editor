import Foundation

// Plays agents' text edits out in a host (#878), as `typeAgentText` does in rich text: the agent's
// caret selects what it replaces, types the new text in frames, and the edit lands as ONE undo
// step. The frames are previews outside the undo history; before the commit the original text is
// put back, so undo sees a single replacement. If the person edits inside the range being typed,
// the original text is put back and the call fails with a sentence; nothing partial is left.

/// The text an agent edits: a Swift editor, an AppKit or UIKit text view, a model.
@MainActor
public protocol AgentTextTarget: AnyObject {
    /// The text as it is now. Positions are UTF-16 offsets into it.
    var agentText: String { get }
    /// Why agents can't write now (a read-only document), or nil.
    var agentReadOnlyReason: String? { get }
    /// Whether frames of typing can be shown in the text. If not, the edit is selected, then lands.
    var canPreviewAgentTyping: Bool { get }
    /// Replaces `range` with `text` as typing in progress: outside the undo history, never saved on
    /// its own. Also called to put the original text back before the commit or when a call stops.
    func previewAgentTyping(in range: NSRange, with text: String)
    /// Applies the edit as one undo step named `actionName`.
    func commitAgentEdit(in range: NSRange, with text: String, actionName: String)
}

extension AgentTextTarget {
    public var agentReadOnlyReason: String? { nil }
    public var canPreviewAgentTyping: Bool { true }
}

public enum AgentTextDirectorError: Error, LocalizedError, Equatable {
    case readOnly(String)
    case outOfRange(String)
    case textChanged
    case cancelled
    case targetGone

    public var errorDescription: String? {
        switch self {
        case .readOnly(let reason): return reason
        case .outOfRange(let message): return message
        case .textChanged: return "The text changed where the agent was typing; it is as it was before the agent's edit."
        case .cancelled: return "Typing was cancelled; the document is unchanged."
        case .targetGone: return "The editor was closed while the agent was typing."
        }
    }
}

@MainActor
public final class AgentTextDirector {
    /// The agents' carets, for the host's overlay.
    public let carets: AgentCaretStore
    public var options: AgentTypingOptions
    /// How long an agent's caret and its changed-text tint stay after its last call, in ms (0 keeps them).
    public var linger: Double

    private weak var target: AgentTextTarget?
    private let clock: PresenceClock
    /// The last call queued for each agent: calls run one after another per agent.
    private var tails: [String: Task<Void, Never>] = [:]
    private var calls = 0
    /// What the director expects the text and the range being typed into to be, per running call.
    private var running: [Int: Run] = [:]

    private struct Run {
        var expected: String
        var span: NSRange
        var conflict = false
    }

    public init(
        target: AgentTextTarget,
        carets: AgentCaretStore = AgentCaretStore(),
        clock: PresenceClock = RealPresenceClock(),
        options: AgentTypingOptions = AgentTypingOptions(),
        linger: Double = 1500
    ) {
        self.target = target
        self.carets = carets
        self.clock = clock
        self.options = options
        self.linger = linger
    }

    /// Plays `edit` out for `agent` and returns where the new text landed (UTF-16 range). Calls by
    /// the same agent run one after another. Validated before anything moves: a read-only target
    /// or a range outside the text throws at once.
    @discardableResult
    public func perform(
        _ edit: AgentTextEdit,
        by agent: AgentCaretInfo,
        actionName: String = "Agent Edit",
        options: AgentTypingOptions? = nil
    ) async throws -> NSRange {
        guard let target else { throw AgentTextDirectorError.targetGone }
        if let reason = target.agentReadOnlyReason { throw AgentTextDirectorError.readOnly(reason) }
        let length = (target.agentText as NSString).length
        guard edit.from >= 0, edit.from <= edit.to, edit.to <= length else {
            throw AgentTextDirectorError.outOfRange("The range \(edit.from)..\(edit.to) is outside the text (0..\(length)).")
        }

        calls += 1
        let call = calls
        let previous = tails[agent.id]
        let work = Task { @MainActor [weak self] () -> Result<NSRange, Error> in
            await previous?.value
            guard let self else { return .failure(AgentTextDirectorError.targetGone) }
            do {
                return .success(try await self.play(edit, by: agent, actionName: actionName, options: options ?? self.options, call: call))
            } catch {
                return .failure(error)
            }
        }
        let tail = Task { @MainActor in _ = await work.value }
        tails[agent.id] = tail
        let result = await withTaskCancellationHandler {
            await work.value
        } onCancel: {
            work.cancel()
        }
        let range = try result.get()
        scheduleLinger(for: agent.id, after: tail)
        return range
    }

    /// Tell the director about an edit someone else made while agents may be typing: `range` (UTF-16,
    /// in the text before the edit) became `replacement`. Edits before a typed range move it; an
    /// edit inside it stops that call (see `AgentTextDirectorError.textChanged`).
    public func noteEdit(in range: NSRange, replacement: String) {
        let length = (replacement as NSString).length
        for (call, var run) in running {
            let ns = run.expected as NSString
            guard NSMaxRange(range) <= ns.length else { run.conflict = true; running[call] = run; continue }
            run.expected = ns.replacingCharacters(in: range, with: replacement)
            if NSMaxRange(range) <= run.span.location {
                run.span.location += length - range.length
            } else if range.location < NSMaxRange(run.span) {
                run.conflict = true // overlaps the range being typed into
            }
            running[call] = run
        }
        carets.mapThroughEdit(range: range, length: length)
    }

    // MARK: Playing a call

    private func play(_ edit: AgentTextEdit, by agent: AgentCaretInfo, actionName: String, options: AgentTypingOptions, call: Int) async throws -> NSRange {
        guard let target else { throw AgentTextDirectorError.targetGone }
        if let reason = target.agentReadOnlyReason { throw AgentTextDirectorError.readOnly(reason) }
        let text = target.agentText as NSString
        guard edit.to <= text.length else {
            throw AgentTextDirectorError.outOfRange("The range \(edit.from)..\(edit.to) is outside the text (0..\(text.length)).")
        }
        let original = text.substring(with: NSRange(location: edit.from, length: edit.to - edit.from))
        var plan = planAgentTyping(edit, options: options)
        if !target.canPreviewAgentTyping {
            plan = plan.filter { if case .type = $0 { return false } else { return true } }
        }
        running[call] = Run(expected: target.agentText, span: NSRange(location: edit.from, length: edit.to - edit.from))
        defer { running[call] = nil }
        var previewed = false

        /// Puts the original text back if frames were shown and nobody changed the range.
        func restore() {
            guard previewed, let target = self.target, let run = running[call], !run.conflict,
                  target.agentText == run.expected else { return }
            target.previewAgentTyping(in: run.span, with: original)
            running[call]?.expected = (run.expected as NSString).replacingCharacters(in: run.span, with: original)
            running[call]?.span.length = (original as NSString).length
            previewed = false
        }

        /// The text is as the director left it: still safe to write.
        func check() throws {
            guard let target = self.target else { throw AgentTextDirectorError.targetGone }
            guard let run = running[call], !run.conflict, target.agentText == run.expected else {
                throw AgentTextDirectorError.textChanged
            }
            if Task.isCancelled { throw AgentTextDirectorError.cancelled }
        }

        do {
            for step in plan {
                switch step {
                case .select(_, _, let ms):
                    let span = running[call]!.span
                    carets.set(agent, anchor: span.location, head: NSMaxRange(span))
                    try await wait(ms)
                case .type(_, let typed, let ms):
                    try check()
                    let span = running[call]!.span
                    target.previewAgentTyping(in: span, with: typed)
                    previewed = true
                    let typedLength = (typed as NSString).length
                    running[call]!.expected = (running[call]!.expected as NSString).replacingCharacters(in: span, with: typed)
                    running[call]!.span.length = typedLength
                    carets.set(agent, anchor: span.location + typedLength)
                    if ms > 0 { try await wait(ms) }
                case .commit:
                    try check()
                    restore()
                    try check()
                    let span = running[call]!.span
                    target.commitAgentEdit(in: span, with: edit.text, actionName: actionName)
                    let inserted = NSRange(location: span.location, length: (edit.text as NSString).length)
                    carets.set(agent, anchor: NSMaxRange(inserted))
                    carets.markChanges(agent.id, inserted.length > 0 ? [inserted] : [])
                    return inserted
                }
            }
        } catch {
            restore()
            if error is CancellationError { throw AgentTextDirectorError.cancelled }
            throw error
        }
        throw AgentTextDirectorError.cancelled
    }

    private func wait(_ ms: Double) async throws {
        do {
            try await clock.wait(ms)
        } catch is CancellationError {
            throw AgentTextDirectorError.cancelled
        }
    }

    /// Clears an agent's caret and tint `linger` ms after its last call, unless another followed.
    private func scheduleLinger(for id: String, after tail: Task<Void, Never>) {
        guard linger > 0 else { return }
        let delay = linger
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await self.clock.wait(delay)
            guard self.tails[id] == tail else { return }
            self.carets.clear(id)
            self.tails[id] = nil
        }
    }
}
