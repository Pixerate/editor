import Foundation

/**
 Inline binary data kept out of an editor document (`persistence/assets.ts`): PNG data URLs and
 long base64 strings (layer pixels, masks, thick-paint channels…) are replaced by short,
 content-addressed references (`pixerate-asset:<length>-<hash>`), and the data lives in an
 `EditorAssetRegistry`. `persistEditorAssets` / `preloadEditorAssets` move the data to and from
 an `EditorStorage` around a save or an open.
 */

/// Prefix of an asset reference in a document (`pixerate-asset:<length>-<hash>`).
public let editorAssetPrefix = "pixerate-asset:"

private let assetRefPattern = try! NSRegularExpression(pattern: "pixerate-asset:[0-9a-z]+-[0-9a-z]+(?:~[0-9]+)?")

/// cyrb53: a fast, well-mixed 53-bit string hash over UTF-16 code units (content addressing, not security).
public func hash53(_ text: String) -> UInt64 {
    @inline(__always) func imul(_ a: UInt32, _ b: UInt32) -> UInt32 { a &* b }
    var h1: UInt32 = 0xDEAD_BEEF
    var h2: UInt32 = 0x41C6_CE57
    for c in text.utf16 {
        h1 = imul(h1 ^ UInt32(c), 2_654_435_761)
        h2 = imul(h2 ^ UInt32(c), 1_597_334_677)
    }
    h1 = imul(h1 ^ (h1 >> 16), 2_246_822_507) ^ imul(h2 ^ (h2 >> 13), 3_266_489_909)
    h2 = imul(h2 ^ (h2 >> 16), 2_246_822_507) ^ imul(h1 ^ (h1 >> 13), 3_266_489_909)
    let high: UInt64 = 4_294_967_296 * UInt64(2_097_151 & h2)
    return high + UInt64(h1)
}

/// Whether a string is inline binary data worth keeping out of the document (`isInlineAsset`).
public func isInlineAsset(_ value: String) -> Bool {
    if value.hasPrefix("data:") { return value.utf16.count >= 512 }
    return value.utf16.count >= 4096 && value.range(of: "^[A-Za-z0-9+/=\\r\\n]+$", options: .regularExpression) != nil
}

/**
 Where an editor document's inline binary data lives (`createEditorAssetRegistry`): `put` stores a
 string once per content and returns its reference; `get` gives it back. Share one registry
 between `createPaintEditorDocument` calls (or between saving and opening) so a document's
 references stay readable.
 */
public final class EditorAssetRegistry {
    private var byRef: [String: String] = [:]
    private var byData: [String: String] = [:]
    private var order: [String] = []

    public init() {}

    /// Stores `data` (once per content) and returns its reference.
    public func put(_ data: String) -> String {
        if let known = byData[data] { return known }
        let base = "\(editorAssetPrefix)\(String(data.utf16.count, radix: 36))-\(String(hash53(data), radix: 36))"
        var ref = base
        var n = 1
        // Two different contents with the same hash get numbered references.
        while let existing = byRef[ref], existing != data {
            ref = "\(base)~\(n)"
            n += 1
        }
        set(ref, data)
        return ref
    }

    /// The data for `ref`, or nil when it is not loaded.
    public func get(_ ref: String) -> String? { byRef[ref] }

    public func has(_ ref: String) -> Bool { byRef[ref] != nil }

    /// Puts data read back from storage under its reference.
    public func set(_ ref: String, _ data: String) {
        if byRef.updateValue(data, forKey: ref) == nil { order.append(ref) }
        byData[data] = ref
    }

    public var size: Int { byRef.count }

    /// Every reference the registry holds, in the order they were added.
    public func refs() -> [String] { order }
}

/// A copy of `value` with every inline asset string replaced by its reference (`externalizeAssets`).
public func externalizeAssets(_ value: JSONValue, _ registry: EditorAssetRegistry) -> JSONValue {
    switch value {
    case .string(let s): return isInlineAsset(s) ? .string(registry.put(s)) : value
    case .array(let a): return .array(a.map { (v: JSONValue) -> JSONValue in externalizeAssets(v, registry) })
    case .object(let o):
        var out = JSONObject()
        for (k, v) in o { out[k] = externalizeAssets(v, registry) }
        return .object(out)
    default: return value
    }
}

/// Every asset reference in a document (`collectAssetRefs`), once each, in the order of its JSON text.
public func collectAssetRefs(_ value: JSONValue) -> [String] {
    collectAssetRefs(text: value.stringified())
}

/// Every asset reference in a document's JSON text, once each, in order.
public func collectAssetRefs(text: String) -> [String] {
    let ns = text as NSString
    var out: [String] = []
    var seen = Set<String>()
    for m in assetRefPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        let ref = ns.substring(with: m.range)
        if seen.insert(ref).inserted { out.append(ref) }
    }
    return out
}

/// Thrown by `internalizeAssets` when a document refers to assets that are not loaded.
public struct EditorAssetsNotLoadedError: Error, LocalizedError, CustomStringConvertible {
    public let missing: [String]
    public var message: String {
        let n = missing.count
        let shown = missing.prefix(3).joined(separator: ", ") + (n > 3 ? ", …" : "")
        return "The document refers to \(n) asset\(n == 1 ? "" : "s") that \(n == 1 ? "is" : "are") not loaded (\(shown)). Pass a document from get_*_document in this session, or open it from storage so its assets are read first."
    }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/**
 A copy of `value` with every asset reference replaced by its data (`internalizeAssets`). Throws
 `EditorAssetsNotLoadedError` naming the references that are not loaded (and changes nothing).
 */
public func internalizeAssets(_ value: JSONValue, _ registry: EditorAssetRegistry) throws -> JSONValue {
    let missing = collectAssetRefs(value).filter { !registry.has($0) }
    if !missing.isEmpty { throw EditorAssetsNotLoadedError(missing: missing) }
    func walk(_ v: JSONValue) -> JSONValue {
        switch v {
        case .string(let s):
            if s.hasPrefix(editorAssetPrefix), let data = registry.get(s) { return .string(data) }
            return v
        case .array(let a): return .array(a.map(walk))
        case .object(let o):
            var out = JSONObject()
            for (k, x) in o { out[k] = walk(x) }
            return .object(out)
        default: return v
        }
    }
    return walk(value)
}

// MARK: - Storage

/**
 Key–value storage of strings (the TS `StorageAdapter`): a file folder, a database, a server.
 `get` returns nil for a key it does not hold. Storage that can list its keys (`listsKeys`, as
 `MemoryEditorStorage` and `DirectoryEditorStorage` can) also supports asset garbage collection
 (`collectEditorAssetGarbage`).
 */
public protocol EditorStorage: AnyObject {
    /// Short backend name, e.g. `"memory"` or `"directory"`.
    var kind: String { get }
    func get(_ key: String) async throws -> String?
    func set(_ key: String, _ value: String) async throws
    func remove(_ key: String) async throws
    /// Whether `keys(_:)` works (the TS adapter's optional `keys` method). Default false.
    var listsKeys: Bool { get }
    /// Every stored key that starts with `prefix` (`""`: every key), in no particular order.
    func keys(_ prefix: String) async throws -> [String]
}

extension EditorStorage {
    public var kind: String { "custom" }
    public var listsKeys: Bool { false }
    public func keys(_ prefix: String) async throws -> [String] {
        throw EditorStorageError("This \(kind) storage cannot list its keys.")
    }
}

/// An error a storage operation throws; its message says what failed.
public struct EditorStorageError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/**
 An `EditorStorage` in memory (`createMemoryStorage`), for tests, previews and session-only
 storage. Keys are listed in the order they were first set, as the TS `Map` lists them (initial
 values in key order).
 */
public final class MemoryEditorStorage: EditorStorage {
    private var order: [String] = []
    private var stored: [String: String] = [:]
    public init(_ values: [String: String] = [:]) {
        for key in values.keys.sorted() {
            stored[key] = values[key]
            order.append(key)
        }
    }
    public var kind: String { "memory" }
    public var listsKeys: Bool { true }
    /// The stored values (inspect them in tests).
    public var values: [String: String] { stored }
    /// The stored keys in the order they were first set (the TS `entries.keys()`).
    public var orderedKeys: [String] { order }
    public func get(_ key: String) async throws -> String? { stored[key] }
    public func set(_ key: String, _ value: String) async throws {
        if stored.updateValue(value, forKey: key) == nil { order.append(key) }
    }
    public func remove(_ key: String) async throws {
        if stored.removeValue(forKey: key) != nil { order.removeAll { $0 == key } }
    }
    public func keys(_ prefix: String) async throws -> [String] { order.filter { $0.jsStartsWith(prefix) } }
}

/**
 An `EditorStorage` over a folder (the TS OPFS adapter's job in the Swift editors): one file per
 key, named by the key with every character outside `[A-Za-z0-9._-]` percent-encoded, written
 atomically. Lists its keys, so asset garbage collection works on it.
 */
public final class DirectoryEditorStorage: EditorStorage {
    public let directory: URL
    /// Storage in `directory` (made when the first value is written).
    public init(directory: URL) { self.directory = directory }
    public var kind: String { "directory" }
    public var listsKeys: Bool { true }

    private static let plain = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    private func url(_ key: String) -> URL {
        // "." is encoded too, so no name is hidden or clashes with a temporary file.
        let name = key.addingPercentEncoding(withAllowedCharacters: Self.plain) ?? key
        return directory.appendingPathComponent(name.isEmpty ? "%" : name, isDirectory: false)
    }

    public func get(_ key: String) async throws -> String? {
        let file = url(key)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try String(contentsOf: file, encoding: .utf8)
    }

    public func set(_ key: String, _ value: String) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(value.utf8).write(to: url(key), options: .atomic)
    }

    public func remove(_ key: String) async throws {
        let file = url(key)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }

    public func keys(_ prefix: String) async throws -> [String] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        let keys: [String] = names.compactMap { (name: String) -> String? in
            // Our names never hold a "." (it is encoded): skip .DS_Store and unfinished atomic writes.
            if name.contains(".") { return nil }
            if name == "%" { return "" }
            return name.removingPercentEncoding
        }
        return keys.filter { $0.jsStartsWith(prefix) }.sorted()
    }
}

/// Values kept per object for as long as it lives (a JavaScript `WeakMap`).
public final class WeakObjectMap<Value>: @unchecked Sendable {
    private final class Box {
        var value: Value
        init(_ value: Value) { self.value = value }
    }
    private let lock = NSLock()
    private let table = NSMapTable<AnyObject, Box>.weakToStrongObjects()

    public init() {}

    /// Runs `body` on the value kept for `key` (made by `make` the first time).
    public func with<R>(_ key: AnyObject, default make: () -> Value, _ body: (inout Value) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        let box: Box
        if let found = table.object(forKey: key) {
            box = found
        } else {
            box = Box(make())
            table.setObject(box, forKey: key)
        }
        return try body(&box.value)
    }
}

/// Key prefix of stored assets (default `pixerate.assets:`); one shared pool, as assets are content-addressed.
public struct EditorAssetStorageOptions: Sendable {
    public var prefix: String
    public init(prefix: String = "pixerate.assets:") { self.prefix = prefix }
}

/// Whether the collection marker was read (and what it was): JavaScript's `undefined`, `null` or a string.
private enum Marker: Equatable {
    case unread
    case value(String?)
}

/// Asset keys each storage already holds (written in this session), valid while its collection marker is unchanged.
private let persisted = WeakObjectMap<(marker: Marker, keys: Set<String>)>()

func assetKey(_ ref: String, _ options: EditorAssetStorageOptions) -> String {
    options.prefix + String(ref.dropFirst(editorAssetPrefix.count))
}

/**
 Writes the assets `document` refers to into `storage` (`persistEditorAssets`), skipping those this
 storage already has. Call before writing the document, so it never points at missing data.
 */
public func persistEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, _ document: JSONValue, options: EditorAssetStorageOptions = EditorAssetStorageOptions()) async throws {
    try await persistEditorAssets(storage, registry, refs: collectAssetRefs(document), options: options)
}

/// `persistEditorAssets` for a document's JSON text.
public func persistEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, text: String, options: EditorAssetStorageOptions = EditorAssetStorageOptions()) async throws {
    try await persistEditorAssets(storage, registry, refs: collectAssetRefs(text: text), options: options)
}

private func persistEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, refs: [String], options: EditorAssetStorageOptions) async throws {
    if refs.isEmpty { return }
    // An unreadable marker never matches, so the cache is dropped and assets are written again.
    let marker: Marker
    do { marker = .value(try await storage.get(assetMarkerKey(options))) } catch { marker = .unread }
    persisted.with(storage, default: { (marker: .unread, keys: []) }) { cache in
        if marker == .unread || marker != cache.marker {
            cache.keys.removeAll()
            cache.marker = marker
        }
    }
    for ref in refs {
        let key = assetKey(ref, options)
        let written = persisted.with(storage, default: { (marker: .unread, keys: []) }) { $0.keys.contains(key) }
        if written { continue }
        guard let data = registry.get(ref) else { continue }
        try await storage.set(key, data)
        persisted.with(storage, default: { (marker: .unread, keys: []) }) { _ = $0.keys.insert(key) }
    }
}

/**
 Reads the assets `document` refers to from `storage` into the registry (`preloadEditorAssets`).
 Returns the references that could not be found.
 */
@discardableResult
public func preloadEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, _ document: JSONValue, options: EditorAssetStorageOptions = EditorAssetStorageOptions()) async throws -> [String] {
    try await preloadEditorAssets(storage, registry, refs: collectAssetRefs(document), options: options)
}

/// `preloadEditorAssets` for a document's JSON text.
@discardableResult
public func preloadEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, text: String, options: EditorAssetStorageOptions = EditorAssetStorageOptions()) async throws -> [String] {
    try await preloadEditorAssets(storage, registry, refs: collectAssetRefs(text: text), options: options)
}

private func preloadEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, refs: [String], options: EditorAssetStorageOptions) async throws -> [String] {
    var missing: [String] = []
    for ref in refs {
        if registry.has(ref) { continue }
        if let data = try await storage.get(assetKey(ref, options)) {
            registry.set(ref, data)
        } else {
            missing.append(ref)
        }
    }
    return missing
}

/// Changed by every collection that deletes something; never matches an asset key.
func assetMarkerKey(_ options: EditorAssetStorageOptions) -> String { "\(options.prefix)#collected" }
