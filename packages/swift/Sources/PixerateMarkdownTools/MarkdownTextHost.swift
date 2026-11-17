// The Markdown text an agent edits (#609): the source, the selection and a way to apply edits as
// one undo step. A text view (Swash's `SwashTextView`) or a plain buffer implements it, and the
// tool providers in this target read and write through it. Every position is a UTF-16 offset into
// the Markdown source, as `NSString` and JavaScript strings count them.

import Foundation
import PixerateCore

/// One replacement in the text: `range` (in the text before the change) becomes `replacement`.
public struct MarkdownTextEdit: Equatable, Sendable {
    public var range: NSRange
    public var replacement: String

    public init(range: NSRange, replacement: String) {
        self.range = range
        self.replacement = replacement
    }
}

/// A change an agent tool makes: edits applied together as one undo step.
public struct MarkdownTextChange: Equatable, Sendable {
    /// Non-overlapping edits in ascending order, with ranges in the text as it was before the change.
    public var edits: [MarkdownTextEdit]
    /// The selection after the change (UTF-16 offsets into the new text).
    public var selection: NSRange
    /// The undo step's name (`Format Text`, `Replace Text`…).
    public var actionName: String

    public init(edits: [MarkdownTextEdit], selection: NSRange, actionName: String) {
        self.edits = edits
        self.selection = selection
        self.actionName = actionName
    }

    /// The text after the change.
    public func applied(to text: String) -> String {
        let out = NSMutableString(string: text)
        for edit in edits.reversed() { out.replaceCharacters(in: edit.range, with: edit.replacement) }
        return out as String
    }
}

/// The Markdown text the agent tools work on.
public protocol MarkdownTextHost: AnyObject {
    /// The Markdown source as it is now.
    var markdown: String { get }
    /// The user's selection (a caret when its length is 0).
    var selectedRange: NSRange { get }
    /// Moves the selection (`set_selection`).
    func setSelectedRange(_ range: NSRange)
    /**
     Applies `change` as one undo step named `change.actionName`, then sets its selection. Throw to
     refuse it (the error's description becomes the tool error). A text view applies each edit
     through its text storage, so undo, attributes and the change feed see ordinary edits.
     */
    func apply(_ change: MarkdownTextChange) throws
    /// Why the text can't be edited now (a read-only document), or nil when it can.
    var readOnlyReason: String? { get }
    /// Calls `listener` when `readOnlyReason` changes, so the tool list is announced again. Nil when it never changes.
    func observeEditability(_ listener: @escaping () -> Void) -> Cancellable?
}

extension MarkdownTextHost {
    public var readOnlyReason: String? { nil }
    public func observeEditability(_ listener: @escaping () -> Void) -> Cancellable? { nil }
}

/// A Markdown text in memory with undo and redo: for headless agents, tests and as a reference host.
public final class MarkdownTextBuffer: MarkdownTextHost {
    public private(set) var markdown: String
    public private(set) var selectedRange: NSRange
    /// Set to make the text read-only, with the reason the tools report.
    public var readOnlyReason: String? {
        didSet { if oldValue != readOnlyReason { listeners.values.forEach { $0() } } }
    }
    /// The names of the undo steps, oldest first.
    public var undoActionNames: [String] { undoStack.map(\.name) }
    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    private struct Step {
        var name: String
        var text: String
        var selection: NSRange
    }

    private var undoStack: [Step] = []
    private var redoStack: [Step] = []
    private var listeners: [UUID: () -> Void] = [:]

    public init(_ markdown: String = "", selection: NSRange? = nil, readOnlyReason: String? = nil) {
        self.markdown = markdown
        let length = (markdown as NSString).length
        selectedRange = selection ?? NSRange(location: length, length: 0)
        self.readOnlyReason = readOnlyReason
    }

    public func setSelectedRange(_ range: NSRange) { selectedRange = range }

    public func apply(_ change: MarkdownTextChange) throws {
        if let reason = readOnlyReason { throw MarkdownToolError(reason) }
        undoStack.append(Step(name: change.actionName, text: markdown, selection: selectedRange))
        redoStack.removeAll()
        markdown = change.applied(to: markdown)
        selectedRange = change.selection
    }

    /// Takes back the last change. Returns its name, or nil when there is nothing to undo.
    @discardableResult
    public func undo() -> String? {
        guard let step = undoStack.popLast() else { return nil }
        redoStack.append(Step(name: step.name, text: markdown, selection: selectedRange))
        markdown = step.text
        selectedRange = step.selection
        return step.name
    }

    /// Makes the last undone change again. Returns its name, or nil when there is nothing to redo.
    @discardableResult
    public func redo() -> String? {
        guard let step = redoStack.popLast() else { return nil }
        undoStack.append(Step(name: step.name, text: markdown, selection: selectedRange))
        markdown = step.text
        selectedRange = step.selection
        return step.name
    }

    public func observeEditability(_ listener: @escaping () -> Void) -> Cancellable? {
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }
}

/// A tool error with a sentence the model can act on.
public struct MarkdownToolError: Error, LocalizedError, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

// MARK: - Positions

extension MarkdownTextEdit {
    /// The smallest single edit that turns `old` into `new` (common prefix and suffix removed,
    /// never splitting a surrogate pair), or nil when they are equal.
    public static func minimal(from old: String, to new: String) -> MarkdownTextEdit? {
        let a = old as NSString, b = new as NSString
        if a.isEqual(to: new as String) { return nil }
        let limit = min(a.length, b.length)
        var prefix = 0
        while prefix < limit, a.character(at: prefix) == b.character(at: prefix) { prefix += 1 }
        if prefix > 0, prefix < a.length, UTF16.isTrailSurrogate(a.character(at: prefix)) { prefix -= 1 }
        var suffix = 0
        while suffix < limit - prefix, a.character(at: a.length - 1 - suffix) == b.character(at: b.length - 1 - suffix) { suffix += 1 }
        if suffix > 0, a.length - suffix > prefix, UTF16.isTrailSurrogate(a.character(at: a.length - suffix)) { suffix -= 1 }
        return MarkdownTextEdit(range: NSRange(location: prefix, length: a.length - suffix - prefix),
                                replacement: b.substring(with: NSRange(location: prefix, length: b.length - suffix - prefix)))
    }
}

/// Where `position` ends up after `edits` (ascending, non-overlapping, in the old text). A position
/// inside a replaced range moves to its start (`assoc` < 0) or to the end of the replacement.
func mapPosition(_ position: Int, through edits: [MarkdownTextEdit], assoc: Int = 1) -> Int {
    var shift = 0
    for edit in edits {
        let start = edit.range.location, end = NSMaxRange(edit.range)
        let inserted = (edit.replacement as NSString).length
        if position < start { return position + shift }
        if edit.range.length == 0 {
            // An insertion at the position: before it (assoc < 0) or after it.
            if position == start { return start + shift + (assoc < 0 ? 0 : inserted) }
            shift += inserted
            continue
        }
        if position == start { return start + shift }
        if position >= end {
            shift += inserted - edit.range.length
            continue
        }
        // Inside the replaced text.
        return start + shift + (assoc < 0 ? 0 : inserted)
    }
    return position + shift
}

/// `range` after `edits`: its start sticks to text before it and its end to text after it.
func mapRange(_ range: NSRange, through edits: [MarkdownTextEdit]) -> NSRange {
    let from = mapPosition(range.location, through: edits, assoc: -1)
    let to = max(from, mapPosition(NSMaxRange(range), through: edits, assoc: 1))
    return NSRange(location: from, length: range.length == 0 ? 0 : to - from)
}
