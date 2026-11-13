import Foundation

/// Marker of a saved editor document file (`EditorDocumentFile.format`).
public let editorDocumentFormat = "pixerate.editor-document"

/// Thrown when a document file or input does not fit; nothing was changed.
public struct EditorDocumentLoadError: Error, LocalizedError, Equatable {
    public var message: String
    /// The `LoadReport` when the input was a file that could not be migrated.
    public var report: LoadReport?
    public init(_ message: String, report: LoadReport? = nil) {
        self.message = message
        self.report = report
    }
    public var errorDescription: String? { message }
}

/// A document as it is saved: names its editor and format version (the `pixerate.editor-document` envelope).
public struct EditorDocumentFile: Equatable {
    public var kind: String
    public var formatVersion: Int
    /// Display name, when it has one.
    public var name: String?
    public var document: JSONValue

    public init(kind: String, formatVersion: Int, name: String? = nil, document: JSONValue) {
        self.kind = kind
        self.formatVersion = formatVersion
        self.name = name
        self.document = document
    }

    /// The envelope as JSON, keys in the order the TS core writes them.
    public var json: JSONValue {
        var o: JSONObject = ["format": .string(editorDocumentFormat), "kind": .string(kind), "formatVersion": .number(Double(formatVersion))]
        if let name, !name.isEmpty { o["name"] = .string(name) }
        o["document"] = document
        return .object(o)
    }

    /// JSON text of the file, as `serializeEditorDocument` writes it.
    public func serialized(space: Int? = nil) -> String { json.stringified(space: space) }

    /// The file `value` holds, or `nil` when it is not one (as `isEditorDocumentFile`).
    public init?(_ value: JSONValue) {
        guard case .object(let o) = value, o["format"] == .string(editorDocumentFormat), case .string(let kind)? = o["kind"], case .number(let v)? = o["formatVersion"], let document = o["document"] else { return nil }
        self.init(kind: kind, formatVersion: Int(v), name: o["name"]?.stringValue, document: document)
    }

    /**
     Parses a file written by `serialized()` (or the TS `serializeEditorDocument`). With `kind`, a
     file of another editor is refused. Throws `EditorDocumentLoadError` saying what is wrong.
     */
    public static func parse(_ text: String, kind expected: String? = nil) throws -> EditorDocumentFile {
        let value: JSONValue
        do {
            value = stripPrototypeKeys(try JSONValue.parse(text))
        } catch {
            throw EditorDocumentLoadError("The file is not valid JSON: \(errorMessage(error))")
        }
        guard let file = EditorDocumentFile(value) else {
            throw EditorDocumentLoadError("The file is not a saved editor document (expected \"format\": \"\(editorDocumentFormat)\").")
        }
        if let expected, file.kind != expected {
            throw EditorDocumentLoadError("The file is a \(file.kind) document, not a \(expected) document.")
        }
        return file
    }
}

/// What can be undone and redone, as `EditorDocumentHistory.getState()` reports it.
public struct EditorDocumentHistoryState: Equatable, Sendable {
    public var canUndo: Bool
    public var canRedo: Bool
    /// The name of the step `undo` would undo, when it has one.
    public var undoName: String?
    /// The name of the step `redo` would redo, when it has one.
    public var redoName: String?
    public init(canUndo: Bool, canRedo: Bool, undoName: String? = nil, redoName: String? = nil) {
        self.canUndo = canUndo
        self.canRedo = canRedo
        self.undoName = undoName
        self.redoName = redoName
    }
}

/// Undo / redo of an editor, as `EditorDocumentHistory`.
public protocol EditorDocumentHistory: AnyObject {
    /// `false` when there was nothing to undo.
    @discardableResult func undo() -> Bool
    /// `false` when there was nothing to redo.
    @discardableResult func redo() -> Bool
    /// What can be undone and redone now (`getState()`).
    func documentHistoryState() -> EditorDocumentHistoryState
}

extension HistoryManager: EditorDocumentHistory {
    public func documentHistoryState() -> EditorDocumentHistoryState {
        let s = state
        return EditorDocumentHistoryState(canUndo: s.canUndo, canRedo: s.canRedo, undoName: s.undoName.isEmpty ? nil : s.undoName, redoName: s.redoName.isEmpty ? nil : s.redoName)
    }
}

/// How `loadDocument` treats the undo history: `reset` (default) clears it, `record` makes the load one undo step.
public enum EditorDocumentLoadHistory: String, Sendable {
    case reset
    case record
}

/// What an editor supplies to `EditorDocument` (as `EditorDocumentSpec`).
public struct EditorDocumentSpec {
    /// Editor domain, e.g. `"paint"` (`[a-z][a-z0-9_]*`).
    public var kind: String
    /// The format version `get()` writes (default 1); older files are migrated on load.
    public var formatVersion: Int
    /// Whether `load(…, .record)` is one undo step (default true).
    public var recordsLoads: Bool
    public var get: () -> JSONValue
    /// Replaces the document; throw before changing anything when it does not fit. Returns repaired sections.
    public var load: (JSONValue, EditorDocumentLoadHistory) throws -> [SectionProblem]
    /// `migrations[v]` turns a version `v` document into version `v + 1`.
    public var migrations: [Int: (JSONValue) throws -> JSONValue]
    public var history: EditorDocumentHistory
    /// Why the document cannot be changed (a sentence), or `nil`.
    public var readOnly: () -> String?
    /**
     Calls its listener after each document change (not selection or view changes), until the
     returned handle is cancelled. Without it, the editor calls `EditorDocument.changed()` itself.
     */
    public var subscribe: ((@escaping () -> Void) -> Cancellable)?
    /**
     Keeps inline binary data (PNG data URLs, long base64) out of the document: `get` results are
     externalized into it, and `load` receives the data back in place of the references.
     */
    public var assets: EditorAssetRegistry?

    public init(kind: String, formatVersion: Int = 1, recordsLoads: Bool = true, get: @escaping () -> JSONValue, load: @escaping (JSONValue, EditorDocumentLoadHistory) throws -> [SectionProblem], migrations: [Int: (JSONValue) throws -> JSONValue] = [:], history: EditorDocumentHistory, readOnly: @escaping () -> String? = { nil }, subscribe: ((@escaping () -> Void) -> Cancellable)? = nil, assets: EditorAssetRegistry? = nil) {
        self.kind = kind
        self.formatVersion = formatVersion
        self.recordsLoads = recordsLoads
        self.get = get
        self.load = load
        self.migrations = migrations
        self.history = history
        self.readOnly = readOnly
        self.subscribe = subscribe
        self.assets = assets
    }
}

/**
 The save / load / undo contract of an editor (as `defineEditorDocument` builds it): counts
 revisions, unwraps and migrates files, and turns load failures into `EditorDocumentLoadError`.
 The editor calls `changed()` after every document change, or the spec's `subscribe` does.
 */
public final class EditorDocument {
    public let kind: String
    public let formatVersion: Int
    public var recordsLoads: Bool { spec.recordsLoads }
    public var history: EditorDocumentHistory { spec.history }
    /// Where the document's binary data lives: `getDocument()` holds references instead of it.
    public var assets: EditorAssetRegistry? { spec.assets }
    private let spec: EditorDocumentSpec
    private var listeners: [UUID: () -> Void] = [:]
    private var connection: Cancellable?
    private var connected = false
    private var counted = 0

    public init(_ spec: EditorDocumentSpec) throws {
        guard spec.kind.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil else {
            throw EditorDocumentLoadError("Editor document kind \"\(spec.kind)\" must match /^[a-z][a-z0-9_]*$/.")
        }
        self.spec = spec
        kind = spec.kind
        formatVersion = spec.formatVersion
        connect()
    }

    /// Listens to the editor through the spec's `subscribe`, when it has one.
    private func connect() {
        guard connection == nil, let subscribe = spec.subscribe else { return }
        // Changes made while disconnected were not counted, so a reconnect is a new revision.
        if connected { counted += 1 }
        connected = true
        connection = subscribe { [weak self] in self?.changed() }
    }

    /// Bumped on every document change, including undo, redo and load (not on selection).
    public var revision: Int {
        connect()
        return counted
    }

    /// Stops listening to the editor; `subscribe` or `revision` reconnects.
    public func destroy() {
        connection?.cancel()
        connection = nil
    }

    /// Plain JSON snapshot of the whole document; `loadDocument(getDocument())` changes nothing.
    /// With `assets`, inline binary data is replaced by references kept there.
    public func getDocument() -> JSONValue {
        let document = spec.get()
        guard let assets = spec.assets else { return document }
        return externalizeAssets(document, assets)
    }

    /// The current document as a file.
    public func file(name: String? = nil) -> EditorDocumentFile {
        EditorDocumentFile(kind: kind, formatVersion: formatVersion, name: name, document: getDocument())
    }

    /// Why the document cannot be changed, or `nil`.
    public func readOnly() -> String? { spec.readOnly() }

    /// The editor's change signal: bumps the revision and tells listeners.
    public func changed() {
        counted += 1
        for listener in Array(listeners.values) { listener() }
    }

    /// Calls `listener` after every document change.
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        connect()
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }

    /// The document inside `input` (a file is unwrapped and migrated) and its report.
    func unwrap(_ input: JSONValue) throws -> (document: JSONValue, report: LoadReport) {
        guard let file = EditorDocumentFile(input) else { return (input, LoadReport(version: formatVersion)) }
        if file.kind != kind { throw EditorDocumentLoadError("This is a \(file.kind) document; it cannot be opened in the \(kind) editor.") }
        var steps: [Int: MigrationStep] = [:]
        for (v, step) in spec.migrations {
            steps[v] = { w in
                var next = w
                next["document"] = try step(w["document"] ?? .null)
                return next
            }
        }
        let (doc, report) = migrateDocument(.value(["formatVersion": .number(Double(file.formatVersion)), "document": file.document]), MigrateOptions(currentVersion: formatVersion, steps: steps, versionKey: "formatVersion"))
        if let readOnly = report.readOnly { throw EditorDocumentLoadError("Cannot open the \(kind) document: \(readOnly.message).", report: report) }
        return (doc["document"] ?? .null, report)
    }

    /**
     Replaces the document with a raw document or a file. Validates and migrates first: throws
     `EditorDocumentLoadError` and changes nothing when the input does not fit.
     */
    @discardableResult
    public func loadDocument(_ input: JSONValue, history: EditorDocumentLoadHistory = .reset) throws -> LoadReport {
        var (document, report) = try unwrap(input)
        if document == .null { throw EditorDocumentLoadError("No \(kind) document was given.") }
        do {
            // Asset references are read back first: one that is not loaded refuses the load.
            let input = try spec.assets.map { try internalizeAssets(document, $0) } ?? document
            report.problems += try spec.load(input, history)
        } catch let error as EditorDocumentLoadError {
            throw error
        } catch {
            throw EditorDocumentLoadError(errorMessage(error))
        }
        return report
    }
}

/// A subscription or registration; `cancel()` ends it (as calling the unsubscribe function the TS
/// core returns). Releasing it does not cancel: the listener stays until `cancel()`.
public final class Cancellable {
    private var action: (() -> Void)?
    public init(_ action: @escaping () -> Void) { self.action = action }
    public func cancel() {
        action?()
        action = nil
    }
}
