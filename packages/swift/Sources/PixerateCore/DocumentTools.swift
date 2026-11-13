import Foundation

/// Options of `createDocumentToolProvider` (`DocumentToolProviderOptions` in `persistence/documentTools.ts`).
public struct DocumentToolProviderOptions {
    /// Provider id (default `<kind>-document`).
    public var id: String?
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the id, `""` for bare names.
    public var namespace: String?
    /// Toolset title (default "<Noun> document").
    public var title: String?
    /// The skill that documents the editor's tools, e.g. `pixerate-paint-editor`.
    public var skill: String?
    /// What the document is called in descriptions (default the kind with spaces).
    public var noun: String?
    /// Add `undo_<kind>` / `redo_<kind>` (default true). Pass false for editors whose own provider has them.
    public var history: Bool
    /// `get_<kind>_document` refuses documents whose JSON is longer than this (default 200000 characters).
    public var maxChars: Int

    public init(id: String? = nil, namespace: String? = nil, title: String? = nil, skill: String? = nil, noun: String? = nil, history: Bool = true, maxChars: Int = 200_000) {
        self.id = id
        self.namespace = namespace
        self.title = title
        self.skill = skill
        self.noun = noun
        self.history = history
        self.maxChars = maxChars
    }
}

private func documentToolSchema(_ properties: JSONObject, _ required: [String] = []) -> JSONValue {
    var o: JSONObject = ["type": "object", "properties": .object(properties)]
    if !required.isEmpty { o["required"] = .array(required.map { .string($0) }) }
    o["additionalProperties"] = false
    return .object(o)
}

private func documentToolAnnotations(_ title: String, read: Bool, destructive: Bool, idempotent: Bool) -> ToolAnnotations {
    ToolAnnotations(title: title, readOnlyHint: read, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false)
}

/// What a load reported, as the tools return it: `migratedFrom`, `problems` and `unknownKeys` when set.
private func loadReportJSON(_ report: LoadReport) -> JSONObject {
    var o = JSONObject()
    if let from = report.migratedFrom { o["migratedFrom"] = .number(Double(from)) }
    if !report.problems.isEmpty {
        o["problems"] = .array(report.problems.map { (p: SectionProblem) -> JSONValue in ["section": .string(p.section), "message": .string(p.message)] })
    }
    if !report.unknownKeys.isEmpty { o["unknownKeys"] = .array(report.unknownKeys.map { .string($0) }) }
    return o
}

/**
 The same document tools for every editor, named after `doc.kind` (`createDocumentToolProvider`):
 `get_<kind>_document`, `load_<kind>_document`, `undo_<kind>` and `redo_<kind>`. Loads are checked
 before anything changes and are one undo step where the editor supports it. A read-only document
 keeps its read tools; its write tools refuse with the reason. (The TS provider's saved-document
 tools, which need a document store, are not ported.)
 */
public func createDocumentToolProvider(_ doc: EditorDocument, _ options: DocumentToolProviderOptions = DocumentToolProviderOptions()) -> AgentToolProvider {
    let kind = doc.kind
    let noun = options.noun ?? kind.replacingOccurrences(of: "_", with: " ")
    let maxChars = options.maxChars
    func writable() throws {
        if let reason = doc.readOnly() { throw ToolHandlerError("\(reason) Read tools still work; write tools are refused.") }
    }
    func historyOut() -> JSONObject {
        let h = doc.history.documentHistoryState()
        var o: JSONObject = ["revision": .number(Double(doc.revision)), "canUndo": .bool(h.canUndo), "canRedo": .bool(h.canRedo)]
        if let name = h.undoName, !name.isEmpty { o["undoName"] = .string(name) }
        if let name = h.redoName, !name.isEmpty { o["redoName"] = .string(name) }
        return o
    }

    let getTitle = "Get the \(noun) document"
    let get = AgentTool(
        name: "get_\(kind)_document", title: getTitle,
        description: "Returns the whole \(noun) as plain JSON: { kind, formatVersion, revision, document }. Use it to keep a copy, compare versions or pass the document to load_\(kind)_document later. For reading or editing parts of the \(noun), prefer the editor's own read tools: this result can be large.",
        inputSchema: documentToolSchema([:]),
        annotations: documentToolAnnotations(getTitle, read: true, destructive: false, idempotent: true)
    ) { _, _ in
        let document = doc.getDocument()
        let size = document.stringified().utf16.count
        if size > maxChars {
            throw ToolHandlerError("The \(noun) document is \(size) characters of JSON, over the \(maxChars) limit for this tool. Use the editor's read tools to look at parts of it.")
        }
        let out: JSONObject = ["kind": .string(kind), "formatVersion": .number(Double(doc.formatVersion)), "revision": .number(Double(doc.revision)), "document": document]
        return .value(.object(out))
    }

    let loadTitle = "Load a \(noun) document"
    let load = AgentTool(
        name: "load_\(kind)_document", title: loadTitle,
        description: "Replaces the whole \(noun) with a document from get_\(kind)_document (its \"document\" value, or the whole result as a saved file). The document is checked first: when it does not fit, nothing changes and the error says why. Returns { revision, undoable, migratedFrom?, problems?, unknownKeys? }; undoable: true means undo_\(kind) brings the previous \(noun) back.",
        inputSchema: documentToolSchema([
            "document": ["type": "object", "description": .string("The \(noun) document: the \"document\" value from get_\(kind)_document, or a saved file ({ format, kind, formatVersion, document }).")],
        ], ["document"]),
        annotations: documentToolAnnotations(loadTitle, read: false, destructive: true, idempotent: false)
    ) { args, _ in
        try writable()
        let report = try doc.loadDocument(args["document"] ?? .null, history: .record)
        var out: JSONObject = ["revision": .number(Double(doc.revision)), "undoable": .bool(doc.recordsLoads)]
        for (k, v) in loadReportJSON(report) { out[k] = v }
        return .value(.object(out))
    }

    let undoTitle = "Undo a \(noun) edit"
    let undo = AgentTool(
        name: "undo_\(kind)", title: undoTitle,
        description: "Undoes the last \(noun) edit (one tool call or one user gesture). Returns { undone, revision, canUndo, canRedo, undoName?, redoName? }; undone is the name of the step that was undone.",
        inputSchema: documentToolSchema([:]),
        annotations: documentToolAnnotations(undoTitle, read: false, destructive: false, idempotent: false)
    ) { _, _ in
        try writable()
        let name = doc.history.documentHistoryState().undoName
        if !doc.history.documentHistoryState().canUndo || !doc.history.undo() { throw ToolHandlerError("Nothing to undo.") }
        var out: JSONObject = ["undone": name.map { JSONValue.string($0) } ?? .bool(true)]
        for (k, v) in historyOut() { out[k] = v }
        return .value(.object(out))
    }

    let redoTitle = "Redo a \(noun) edit"
    let redo = AgentTool(
        name: "redo_\(kind)", title: redoTitle,
        description: "Redoes the last undone \(noun) edit. Returns { redone, revision, canUndo, canRedo, undoName?, redoName? }; redone is the name of the step that was redone.",
        inputSchema: documentToolSchema([:]),
        annotations: documentToolAnnotations(redoTitle, read: false, destructive: false, idempotent: false)
    ) { _, _ in
        try writable()
        let name = doc.history.documentHistoryState().redoName
        if !doc.history.documentHistoryState().canRedo || !doc.history.redo() { throw ToolHandlerError("Nothing to redo.") }
        var out: JSONObject = ["redone": name.map { JSONValue.string($0) } ?? .bool(true)]
        for (k, v) in historyOut() { out[k] = v }
        return .value(.object(out))
    }

    let id = options.id ?? "\(kind)-document"
    let title = options.title ?? (noun.prefix(1).uppercased() + noun.dropFirst() + " document")
    return AgentToolProvider(
        id: id, namespace: options.namespace, title: title,
        description: "Get, load\(options.history ? ", undo, redo" : "") the whole \(noun).",
        skill: options.skill,
        tools: options.history ? [get, load, undo, redo] : [get, load]
    )
}

/// An error a document tool throws; its message becomes the tool's error result.
public struct ToolHandlerError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}
