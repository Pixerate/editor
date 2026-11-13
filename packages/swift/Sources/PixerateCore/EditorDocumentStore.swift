import Foundation

/// One saved document as the index lists it (`SavedEditorDocument`; no document read needed).
public struct SavedEditorDocument: Equatable, Sendable {
    /// Storage key of the document, e.g. `"paint/sketch"`; pass it to `open`.
    public var key: String
    public var kind: String
    public var name: String
    public var formatVersion: Int
    /// ISO time of the last save.
    public var savedAt: String
    /**
     The index entry as stored, keys in the TS core's order. An entry another build wrote keeps
     what it had (missing or extra fields), so the tools report what is there.
     */
    public var json: JSONObject

    public init(key: String, kind: String, name: String, formatVersion: Int, savedAt: String) {
        self.key = key
        self.kind = kind
        self.name = name
        self.formatVersion = formatVersion
        self.savedAt = savedAt
        json = JSONObject([("key", .string(key)), ("kind", .string(kind)), ("name", .string(name)), ("formatVersion", .number(Double(formatVersion))), ("savedAt", .string(savedAt))])
    }

    /// An index entry read back from storage (it has a string `key` and `kind`).
    init(json: JSONObject, key: String, kind: String) {
        self.key = key
        self.kind = kind
        name = json["name"]?.stringValue ?? ""
        if case .number(let v)? = json["formatVersion"] { formatVersion = Int(v) } else { formatVersion = 0 }
        savedAt = json["savedAt"]?.stringValue ?? ""
        self.json = json
    }
}

/// A saved document opened into an editor: its entry and the load report (`open`'s result).
public struct OpenedEditorDocument {
    public var entry: SavedEditorDocument
    public var report: LoadReport
}

/// When a document store collects unreferenced assets after `remove` (`collectAssetGarbage` option).
public enum EditorDocumentStoreGarbage {
    /// Never (collect on demand with `collectAssetGarbage`).
    case off
    /// After every `remove`, keeping nothing extra (the default).
    case on
    /// After every `remove`, with these options (`dryRun` and `only` are ignored).
    case with(EditorAssetGarbageOptions)
}

/// Options of `createEditorDocumentStore` (`EditorDocumentStoreOptions`).
public struct EditorDocumentStoreOptions {
    public var storage: EditorStorage
    /// Prefix of every key this store writes (default `pixerate.documents`).
    public var namespace: String
    /// Wall clock for `savedAt`, in milliseconds since 1970 (default the system clock).
    public var now: () -> Double
    /**
     After `remove`, delete the stored assets nothing refers to any more (best effort; default on).
     Needs storage that lists its keys.
     */
    public var collectAssetGarbage: EditorDocumentStoreGarbage

    public init(storage: EditorStorage, namespace: String = "pixerate.documents", now: @escaping () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }, collectAssetGarbage: EditorDocumentStoreGarbage = .on) {
        self.storage = storage
        self.namespace = namespace
        self.now = now
        self.collectAssetGarbage = collectAssetGarbage
    }
}

/// Named documents of every editor kind (`EditorDocumentStore`).
public protocol EditorDocumentStore: AnyObject {
    /// Saves the current document under `name` (one document per kind and name: saving the same name again replaces it).
    func save(_ doc: EditorDocument, name: String) async throws -> SavedEditorDocument
    /// Saved documents, newest first; only one kind's with `kind`.
    func list(kind: String?) async throws -> [SavedEditorDocument]
    /// The saved file, or nil when nothing is stored under `key`.
    func read(_ key: String) async throws -> EditorDocumentFile?
    /// Loads a saved document into `doc` (see `EditorDocument.loadDocument`). Throws when `key` is unknown.
    func open(_ doc: EditorDocument, key: String, history: EditorDocumentLoadHistory) async throws -> OpenedEditorDocument
    /// Deletes a saved document; false when there was none. Then deletes the assets nothing refers to any more, unless collection is off.
    @discardableResult func remove(_ key: String) async throws -> Bool
    /// Whether `collectAssetGarbage` works: only when the storage can list its keys.
    var canCollectAssetGarbage: Bool { get }
    /// Deletes (or with `dryRun`, finds) the stored assets nothing refers to, queued after the store's other operations.
    func collectAssetGarbage(_ options: EditorAssetGarbageOptions) async throws -> EditorAssetGarbageReport
}

extension EditorDocumentStore {
    /// Every saved document, newest first.
    public func list() async throws -> [SavedEditorDocument] { try await list(kind: nil) }
    /// Opens a saved document with the history cleared.
    public func open(_ doc: EditorDocument, key: String) async throws -> OpenedEditorDocument { try await open(doc, key: key, history: .reset) }
    /// Deletes every stored asset nothing refers to.
    @discardableResult
    public func collectAssetGarbage() async throws -> EditorAssetGarbageReport { try await collectAssetGarbage(EditorAssetGarbageOptions()) }
}

/// `"Release flow v2"` → `"release-flow-v2"` (the key part of a saved name; `slugifyDocumentName`).
public func slugifyDocumentName(_ name: String) -> String {
    let lowered = name.decomposedStringWithCompatibilityMapping.jsLowercased
    var slug = ""
    var dash = false
    for s in lowered.unicodeScalars {
        if (s.value >= 0x61 && s.value <= 0x7A) || (s.value >= 0x30 && s.value <= 0x39) {
            slug.unicodeScalars.append(s)
            dash = false
        } else if !dash {
            slug += "-"
            dash = true
        }
    }
    // Trim the dashes at both ends, then keep 80 characters (all ASCII by now).
    while slug.hasPrefix("-") { slug.removeFirst() }
    while slug.hasSuffix("-") { slug.removeLast() }
    slug = String(slug.prefix(80))
    return slug.isEmpty ? "untitled" : slug
}

/// `new Date(ms).toISOString()` for times in years 0 to 9999.
public func jsISOString(_ ms: Double) -> String {
    let total = Int64(ms.rounded(.down))
    let msOfDay = ((total % 86_400_000) + 86_400_000) % 86_400_000
    let days = (total - msOfDay) / 86_400_000
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
    func pad(_ n: Int64, _ width: Int) -> String {
        let s = String(n)
        return String(repeating: "0", count: max(0, width - s.count)) + s
    }
    let time = "\(pad(msOfDay / 3_600_000, 2)):\(pad(msOfDay / 60000 % 60, 2)):\(pad(msOfDay / 1000 % 60, 2)).\(pad(msOfDay % 1000, 3))"
    return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))T\(time)Z"
}

/// Runs async operations one at a time, in the order they were queued (the TS store's promise chain).
final class AsyncSerialQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func run<T>(_ task: () async throws -> T) async throws -> T {
        await acquire()
        defer { release() }
        return try await task()
    }

    private func acquire() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in enter(c) }
    }

    /// Takes the queue now (resuming `c`) or waits in line for it.
    private func enter(_ c: CheckedContinuation<Void, Never>) {
        lock.lock()
        if busy {
            waiting.append(c)
            lock.unlock()
        } else {
            busy = true
            lock.unlock()
            c.resume()
        }
    }

    private func release() {
        lock.lock()
        if waiting.isEmpty {
            busy = false
            lock.unlock()
        } else {
            // The next task inherits the queue.
            let next = waiting.removeFirst()
            lock.unlock()
            next.resume()
        }
    }
}

/**
 Named documents on a key–value `EditorStorage`, for every editor kind (`createEditorDocumentStore`):
 each file under its own key plus one index entry for listing. Operations run one at a time, so
 concurrent saves do not lose index entries. The index is cached after the first read: use one
 store per storage namespace.
 */
public func createEditorDocumentStore(_ options: EditorDocumentStoreOptions) -> EditorDocumentStore {
    KeyValueEditorDocumentStore(options)
}

private final class KeyValueEditorDocumentStore: EditorDocumentStore {
    private let storage: EditorStorage
    private let ns: String
    private let now: () -> Double
    private let gc: EditorDocumentStoreGarbage
    private var index: [SavedEditorDocument]?
    private let queue = AsyncSerialQueue()

    init(_ options: EditorDocumentStoreOptions) {
        storage = options.storage
        ns = options.namespace
        now = options.now
        gc = options.collectAssetGarbage
    }

    private var indexKey: String { "\(ns):index" }
    private func fileKey(_ key: String) -> String { "\(ns):file:\(key)" }

    private func loadIndex() async throws -> [SavedEditorDocument] {
        if let index { return index }
        let raw = try await storage.get(indexKey)
        var items: [SavedEditorDocument] = []
        if let raw, let data = try? JSONValue.parse(raw), case .array(let list)? = data["items"] {
            items = list.compactMap { (item: JSONValue) -> SavedEditorDocument? in
                guard case .object(let o) = item, case .string(let key)? = o["key"], case .string(let kind)? = o["kind"] else { return nil }
                return SavedEditorDocument(json: o, key: key, kind: kind)
            }
        }
        index = items
        return items
    }

    private func saveIndex(_ items: [SavedEditorDocument]) async throws {
        let out: JSONValue = .object(JSONObject([("version", .number(1)), ("items", .array(items.map { JSONValue.object($0.json) }))]))
        try await storage.set(indexKey, out.stringified())
        index = items
    }

    /// Newest first (by `savedAt`, compared as strings), keeping the index order for equal times.
    private func newestFirst(_ items: [SavedEditorDocument]) -> [SavedEditorDocument] {
        let ordered: [(offset: Int, element: SavedEditorDocument)] = items.enumerated().sorted { (a, b) -> Bool in
            let x = a.element.json["savedAt"]?.stringValue
            let y = b.element.json["savedAt"]?.stringValue
            if let x, let y, x != y { return jsLess(y, x) }
            return a.offset < b.offset
        }
        return ordered.map(\.element)
    }

    private func readFile(_ key: String) async throws -> EditorDocumentFile? {
        guard let raw = try await storage.get(fileKey(key)) else { return nil }
        return try EditorDocumentFile.parse(raw)
    }

    func save(_ doc: EditorDocument, name: String) async throws -> SavedEditorDocument {
        try await queue.run {
            let trimmed = name.jsTrimmed.isEmpty ? "Untitled" : name.jsTrimmed
            let entry = SavedEditorDocument(key: "\(doc.kind)/\(slugifyDocumentName(trimmed))", kind: doc.kind, name: trimmed, formatVersion: doc.formatVersion, savedAt: jsISOString(now()))
            let text = doc.file(name: trimmed).serialized()
            // Assets, then the file, then the index: a crash in between leaves unlisted data, never a dangling entry.
            // `withEditorAssets` also keeps a concurrent asset collection away from them.
            let target: EditorStorage = doc.assets.map { withEditorAssets(storage, $0) } ?? storage
            try await target.set(fileKey(entry.key), text)
            let kept = try await loadIndex().filter { $0.key != entry.key }
            try await saveIndex(kept + [entry])
            return entry
        }
    }

    func list(kind: String? = nil) async throws -> [SavedEditorDocument] {
        try await queue.run {
            let items = try await loadIndex().filter { (item: SavedEditorDocument) -> Bool in kind == nil || kind == "" || item.kind == kind }
            return newestFirst(items)
        }
    }

    func read(_ key: String) async throws -> EditorDocumentFile? {
        try await queue.run { try await readFile(key) }
    }

    func open(_ doc: EditorDocument, key: String, history: EditorDocumentLoadHistory = .reset) async throws -> OpenedEditorDocument {
        try await queue.run {
            let entry = try await loadIndex().first { $0.key == key }
            var file: EditorDocumentFile?
            if entry != nil { file = try await readFile(key) }
            guard let entry, let file else {
                let keys = try await newestFirst(loadIndex().filter { $0.kind == doc.kind }).map(\.key)
                let saved = keys.isEmpty ? "No \(doc.kind) documents are saved yet." : "Saved \(doc.kind) documents: \(keys.joined(separator: ", "))."
                throw EditorDocumentLoadError("There is no saved document \"\(key)\". \(saved)")
            }
            if let assets = doc.assets {
                let missing = try await preloadEditorAssets(storage, assets, file.json)
                if !missing.isEmpty {
                    throw EditorDocumentLoadError("The saved document \"\(key)\" refers to \(missing.count) asset\(missing.count == 1 ? "" : "s") that storage no longer has, so it cannot be opened.")
                }
            }
            let report = try doc.loadDocument(file.json, history: history)
            return OpenedEditorDocument(entry: entry, report: report)
        }
    }

    func remove(_ key: String) async throws -> Bool {
        try await queue.run {
            let items = try await loadIndex()
            if !items.contains(where: { $0.key == key }) { return false }
            try await saveIndex(items.filter { $0.key != key })
            try await storage.remove(fileKey(key))
            let setting: EditorAssetGarbageOptions?
            switch gc {
            case .off: setting = nil
            case .on: setting = EditorAssetGarbageOptions()
            case .with(let options): setting = options
            }
            if var options = setting {
                options.dryRun = false
                options.only = nil
                await tryCollectEditorAssetGarbage(storage, options)
            }
            return true
        }
    }

    var canCollectAssetGarbage: Bool { storage.listsKeys }

    func collectAssetGarbage(_ options: EditorAssetGarbageOptions = EditorAssetGarbageOptions()) async throws -> EditorAssetGarbageReport {
        try await queue.run { try await collectEditorAssetGarbage(storage, options) }
    }
}

/// `a < b` as JavaScript compares strings (by UTF-16 code units).
func jsLess(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
}
