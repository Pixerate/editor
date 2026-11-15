import Foundation

// How an agent's text edit is played out (#878): a port of `planAgentTyping`
// (packages/core/src/tools/agent-typing.ts). It turns an edit into timed steps — select what it
// replaces, type the new text in frames, commit it as one undo step — and knows nothing about any
// editor. `@pixerate/conformance` (`domains/agent-text/typing-plans.json`) holds the TypeScript
// planner's plans, which this one must reproduce exactly.

/// Timing of an agent's typing.
public struct AgentTypingOptions: Sendable, Equatable {
    /// Typing speed in characters per second (default 60). `.infinity` or 0 commits at once.
    public var charsPerSecond: Double
    /// Longest a single edit takes to type, in ms; longer text types faster (default 1500).
    public var maxDurationMs: Double
    /// How long a replaced range stays highlighted before typing starts, in ms (default 250).
    public var selectMs: Double
    /// False when there's nothing to watch (no window, Reduce Motion): the edit commits at once.
    public var animate: Bool

    public static let defaultCharsPerSecond: Double = 60
    public static let defaultMaxDurationMs: Double = 1500
    public static let defaultSelectMs: Double = 250
    /// Typing is drawn at about 30 frames a second.
    public static let frameMs: Double = 1000.0 / 30.0

    public init(
        charsPerSecond: Double = AgentTypingOptions.defaultCharsPerSecond,
        maxDurationMs: Double = AgentTypingOptions.defaultMaxDurationMs,
        selectMs: Double = AgentTypingOptions.defaultSelectMs,
        animate: Bool = true
    ) {
        self.charsPerSecond = charsPerSecond
        self.maxDurationMs = maxDurationMs
        self.selectMs = selectMs
        self.animate = animate
    }
}

/// An edit: replace `from..<to` (positions in the host's own units; UTF-16 offsets for a String)
/// with `text`.
public struct AgentTextEdit: Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var text: String

    public init(from: Int, to: Int, text: String) {
        self.from = from
        self.to = to
        self.text = text
    }
}

public enum AgentTypingStep: Sendable, Equatable {
    /// Show the agent's selection over `from..<to` (what it replaces), then wait `ms`.
    case select(from: Int, to: Int, ms: Double)
    /// Show the first `chars` characters of the text typed into the edit's range, then wait `ms`.
    case type(chars: Int, text: String, ms: Double)
    /// Apply the whole edit as one undo step, with the caret after the new text.
    case commit

    /// How long the step waits, in ms.
    public var ms: Double {
        switch self {
        case .select(_, _, let ms), .type(_, _, let ms): return ms
        case .commit: return 0
        }
    }
}

/// The steps that play `edit` out. Without animation, at an infinite or zero speed, or with no text
/// to type, it is a single commit. Characters are Unicode scalars (as JavaScript's `Array.from`
/// counts code points), so a frame never splits one. The last frame doesn't wait.
public func planAgentTyping(_ edit: AgentTextEdit, options: AgentTypingOptions = AgentTypingOptions()) -> [AgentTypingStep] {
    let scalars = Array(edit.text.unicodeScalars)
    let cps = options.charsPerSecond
    guard options.animate, cps.isFinite, cps > 0, !scalars.isEmpty else { return [.commit] }

    let count = Double(scalars.count)
    let duration = min(options.maxDurationMs, (count / cps) * 1000)
    let frames = max(1, min(scalars.count, Int(jsRound(duration / AgentTypingOptions.frameMs))))
    var steps: [AgentTypingStep] = []
    if edit.from < edit.to { steps.append(.select(from: edit.from, to: edit.to, ms: options.selectMs)) }
    for i in 1...frames {
        let typed = Int(jsRound((count * Double(i)) / Double(frames)))
        var text = String.UnicodeScalarView()
        text.append(contentsOf: scalars[0..<typed])
        steps.append(.type(chars: typed, text: String(text), ms: i < frames ? duration / Double(frames) : 0))
    }
    steps.append(.commit)
    return steps
}

/// How long a plan takes to play, in ms.
public func agentTypingDuration(_ steps: [AgentTypingStep]) -> Double {
    steps.reduce(0) { $0 + $1.ms }
}
