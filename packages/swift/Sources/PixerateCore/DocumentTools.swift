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
    /**
     Saved documents: adds `save_<kind>_document`, `list_saved_<kind>_documents` and
     `open_saved_<kind>_document`. For documents with `assets` (paint) on a storage that lists keys,
     also `find_unreferenced_<kind>_assets` and `delete_unreferenced_<kind>_assets`.
     */
    public var store: EditorDocumentStore?
    /// Name `save_<kind>_document` uses when none is given (default "Untitled <noun>").
    public var name: (() -> String?)?
    /// `get_<kind>_document` refuses documents whose JSON is longer than this (default 200000 characters).
    public var maxChars: Int

    public init(id: String? = nil, namespace: String? = nil, title: String? = nil, skill: String? = nil, noun: String? = nil, history: Bool = true, store: EditorDocumentStore? = nil, name: (() -> String?)? = nil, maxChars: Int = 200_000) {
        self.id = id
        self.namespace = namespace
        self.title = title
        self.skill = skill
        self.noun = noun
        self.history = history
        self.store = store
        self.name = name
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
 `get_<kind>_document`, `load_<kind>_document`, `undo_<kind>`, `redo_<kind>` and, with a `store`,
 `save_<kind>_document`, `list_saved_<kind>_documents` and `open_saved_<kind>_document` (plus
 `find_unreferenced_<kind>_assets` / `delete_unreferenced_<kind>_assets` for documents with assets
 on storage that lists its keys). Loads are checked before anything changes and are one undo step
 where the editor supports it. A read-only document keeps its read tools; its write tools refuse
 with the reason.
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

    var tools = options.history ? [get, load, undo, redo] : [get, load]
    if let store = options.store {
        tools += documentStoreTools(doc, store, kind: kind, noun: noun, name: options.name, writable: writable)
        if store.canCollectAssetGarbage, doc.assets != nil {
            tools += documentAssetTools(doc, store, kind: kind, noun: noun, writable: writable)
        }
    }
    let id = options.id ?? "\(kind)-document"
    let title = options.title ?? (noun.prefix(1).uppercased() + noun.dropFirst() + " document")
    return AgentToolProvider(
        id: id, namespace: options.namespace, title: title,
        description: "Get, load\(options.history ? ", undo, redo" : "")\(options.store != nil ? ", save and open" : "") the whole \(noun).",
        skill: options.skill,
        tools: tools
    )
}

/// `save_<kind>_document`, `list_saved_<kind>_documents` and `open_saved_<kind>_document` (`storeTools`).
private func documentStoreTools(_ doc: EditorDocument, _ store: EditorDocumentStore, kind: String, noun: String, name defaultName: (() -> String?)?, writable: @escaping () throws -> Void) -> [AgentTool] {
    let saveTitle = "Save the \(noun)"
    let save = AgentTool(
        name: "save_\(kind)_document", title: saveTitle,
        description: "Saves the current \(noun) under a name in the host's document storage. Saving the same name again replaces that saved copy. Returns { key, name, savedAt, revision }; pass key to open_saved_\(kind)_document to load it again.",
        inputSchema: documentToolSchema([
            "name": [
                "type": "string", "minLength": 1, "maxLength": 200,
                "description": .string("Name to save under (default: the \(noun)'s current name, or \"Untitled \(noun)\")."),
            ],
        ]),
        annotations: documentToolAnnotations(saveTitle, read: false, destructive: true, idempotent: true)
    ) { args, _ in
        let name = args["name"]?.stringValue ?? defaultName?() ?? "Untitled \(noun)"
        let entry = try await store.save(doc, name: name)
        let out = JSONObject([("key", .string(entry.key)), ("name", .string(entry.name)), ("savedAt", .string(entry.savedAt)), ("revision", .number(Double(doc.revision)))])
        return .value(.object(out))
    }

    let listTitle = "List saved \(noun) documents"
    let list = AgentTool(
        name: "list_saved_\(kind)_documents", title: listTitle,
        description: "Lists the \(noun) documents in the host's document storage, newest first. Returns { documents: [{ key, name, savedAt, formatVersion }] }.",
        inputSchema: documentToolSchema([:]),
        annotations: documentToolAnnotations(listTitle, read: true, destructive: false, idempotent: true)
    ) { _, _ in
        let documents: [JSONValue] = try await store.list(kind: kind).map { (entry: SavedEditorDocument) -> JSONValue in
            // `({ key, name, savedAt, formatVersion }) => …`: fields an entry lacks are left out.
            var o = JSONObject()
            for field in ["key", "name", "savedAt", "formatVersion"] {
                if let value = entry.json[field] { o[field] = value }
            }
            return .object(o)
        }
        return .value(.object(["documents": .array(documents)]))
    }

    let openTitle = "Open a saved \(noun)"
    let open = AgentTool(
        name: "open_saved_\(kind)_document", title: openTitle,
        description: "Replaces the current \(noun) with a saved one. Unsaved changes stay reachable through undo_\(kind) when undoable is true. Returns { key, name, revision, undoable, migratedFrom?, problems?, unknownKeys? }.",
        inputSchema: documentToolSchema(["key": ["type": "string", "minLength": 1, "description": .string("A key from list_saved_\(kind)_documents or save_\(kind)_document.")]], ["key"]),
        annotations: documentToolAnnotations(openTitle, read: false, destructive: true, idempotent: false)
    ) { args, _ in
        try writable()
        let opened = try await store.open(doc, key: args["key"]?.stringValue ?? "", history: .record)
        var out = JSONObject()
        if let key = opened.entry.json["key"] { out["key"] = key }
        if let name = opened.entry.json["name"] { out["name"] = name }
        out["revision"] = .number(Double(doc.revision))
        out["undoable"] = .bool(doc.recordsLoads)
        for (k, v) in loadReportJSON(opened.report) { out[k] = v }
        return .value(.object(out))
    }
    return [save, list, open]
}

/// How many references `find_unreferenced_<kind>_assets` lists.
private let unreferencedListLimit = 100

/// `find_unreferenced_<kind>_assets` and `delete_unreferenced_<kind>_assets` (`assetTools`).
private func documentAssetTools(_ doc: EditorDocument, _ store: EditorDocumentStore, kind: String, noun: String, writable: @escaping () throws -> Void) -> [AgentTool] {
    let findTitle = "Find unreferenced \(noun) assets"
    let find = AgentTool(
        name: "find_unreferenced_\(kind)_assets", title: findTitle,
        description: "Finds the stored image data (layer pixels, masks and other assets of every image and paint document in the host's storage) that no saved document or autosave snapshot refers to any more, without deleting anything. The open \(noun)'s own assets always count as used. Returns { assets, referenced, kept, unreferenced, unreferencedChars, refs, more }: unreferenced is how many could be deleted, unreferencedChars the characters of data they hold, refs up to \(unreferencedListLimit) of their references for delete_unreferenced_\(kind)_assets, and more how many were left out of refs.",
        inputSchema: documentToolSchema([:]),
        annotations: documentToolAnnotations(findTitle, read: true, destructive: false, idempotent: true)
    ) { _, _ in
        let report = try await store.collectAssetGarbage(EditorAssetGarbageOptions(keep: [.value(doc.getDocument())], dryRun: true))
        let refs: [JSONValue] = report.unreferenced.prefix(unreferencedListLimit).map { JSONValue.string($0) }
        let out = JSONObject([
            ("assets", .number(Double(report.assets))), ("referenced", .number(Double(report.referenced))), ("kept", .number(Double(report.kept))),
            ("unreferenced", .number(Double(report.unreferenced.count))), ("unreferencedChars", .number(Double(report.unreferencedChars))),
            ("refs", .array(refs)), ("more", .number(Double(max(0, report.unreferenced.count - unreferencedListLimit)))),
        ])
        return .value(.object(out))
    }

    let deleteTitle = "Delete unreferenced \(noun) assets"
    let delete = AgentTool(
        name: "delete_unreferenced_\(kind)_assets", title: deleteTitle,
        description: "Deletes stored image data that no saved document or autosave snapshot refers to, to free browser storage. Saved documents and the open \(noun) are never affected, and a write in progress is waited for. Call find_unreferenced_\(kind)_assets first to see what would go, and do it when the user asks to free space or clean up storage. It cannot be undone, but nothing refers to the deleted data. Returns { removed, freedChars, kept, remaining }: how many assets were deleted, the characters of data freed, how many unreferenced ones were kept because a write was using them, and how many assets are left.",
        inputSchema: documentToolSchema([
            "refs": [
                "type": "array",
                "items": ["type": "string", "pattern": "^pixerate-asset:"],
                "minItems": 1,
                "uniqueItems": true,
                "description": .string("Delete only these references from find_unreferenced_\(kind)_assets (refs). Default: every unreferenced asset. If any is no longer unreferenced, nothing is deleted and the error names it."),
            ],
        ]),
        annotations: documentToolAnnotations(deleteTitle, read: false, destructive: true, idempotent: true)
    ) { args, _ in
        try writable()
        let only: [String]? = args["refs"]?.arrayValue.map { (refs: [JSONValue]) -> [String] in refs.compactMap { $0.stringValue } }
        let report = try await store.collectAssetGarbage(EditorAssetGarbageOptions(keep: [.value(doc.getDocument())], only: only))
        let out = JSONObject([
            ("removed", .number(Double(report.removed.count))), ("freedChars", .number(Double(report.freedChars))),
            ("kept", .number(Double(report.kept))), ("remaining", .number(Double(report.assets - report.removed.count))),
        ])
        return .value(.object(out))
    }
    return [find, delete]
}

/// An error a document tool throws; its message becomes the tool's error result.
public struct ToolHandlerError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}
