import Foundation

/*
 Asset writes and asset garbage collection (`persistence/assetWrites.ts` and the collection half of
 `persistence/assets.ts`). Collection must never delete an asset that a write in flight is about to
 point a document at, so every write that persists assets leases their references until its
 document is written, and a running collection skips leased references and references leased
 while it runs. (The TS core also takes a Web Lock where the browser has one, to cover other tabs;
 a Swift process has no other tabs, so the leases are the whole of it, as in the TS core on Node.)
 */

/// Leased references and the collections watching them, shared by every storage (as the TS module state).
private final class AssetLeases: @unchecked Sendable {
    let lock = NSLock()
    var counts: [String: Int] = [:]
    var watchers: [Int: Set<String>] = [:]
    var nextWatcher = 0
}

private let assetLeases = AssetLeases()

/// Marks `refs` as about to be referenced by a document write (`leaseAssetRefs`); call the result when it is written.
func leaseAssetRefs(_ refs: [String]) -> () -> Void {
    var held: [String] = []
    var seen = Set<String>()
    for ref in refs where seen.insert(ref).inserted { held.append(ref) }
    let leases = assetLeases
    leases.lock.lock()
    for ref in held {
        leases.counts[ref, default: 0] += 1
        for id in leases.watchers.keys { leases.watchers[id]?.insert(ref) }
    }
    leases.lock.unlock()
    var released = false
    return {
        leases.lock.lock()
        defer { leases.lock.unlock() }
        if released { return }
        released = true
        for ref in held {
            let n = (leases.counts[ref] ?? 1) - 1
            if n > 0 { leases.counts[ref] = n } else { leases.counts[ref] = nil }
        }
    }
}

/// Records the references that are, or become, leased until `stop()` (`watchAssetLeases`).
final class AssetLeaseWatch {
    private let id: Int
    init() {
        let leases = assetLeases
        leases.lock.lock()
        id = leases.nextWatcher
        leases.nextWatcher += 1
        leases.watchers[id] = Set(leases.counts.keys)
        leases.lock.unlock()
    }
    /// Whether `ref` was leased when the watch started or at any time since.
    func touched(_ ref: String) -> Bool {
        assetLeases.lock.lock()
        defer { assetLeases.lock.unlock() }
        return assetLeases.watchers[id]?.contains(ref) ?? false
    }
    func stop() {
        assetLeases.lock.lock()
        assetLeases.watchers[id] = nil
        assetLeases.lock.unlock()
    }
}

/**
 `storage` with assets handled (`withEditorAssets`): every `set` first writes the assets the value
 refers to, and every `get` reads them into the registry before returning. Wrap the storage an
 autosave or a document store uses for an editor whose document has `assets`.
 */
public func withEditorAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry, options: EditorAssetStorageOptions = EditorAssetStorageOptions()) -> EditorStorage {
    EditorAssetStorage(storage, registry, options)
}

private final class EditorAssetStorage: EditorStorage {
    let storage: EditorStorage
    let registry: EditorAssetRegistry
    let options: EditorAssetStorageOptions
    init(_ storage: EditorStorage, _ registry: EditorAssetRegistry, _ options: EditorAssetStorageOptions) {
        self.storage = storage
        self.registry = registry
        self.options = options
    }
    var kind: String { storage.kind }
    var listsKeys: Bool { storage.listsKeys }
    func get(_ key: String) async throws -> String? {
        let value = try await storage.get(key)
        if let value, value.jsIncludes(editorAssetPrefix) { try await preloadEditorAssets(storage, registry, text: value, options: options) }
        return value
    }
    func set(_ key: String, _ value: String) async throws {
        if !value.jsIncludes(editorAssetPrefix) { return try await storage.set(key, value) }
        try await writeWithAssets(storage, registry, value, options) { try await self.storage.set(key, value) }
    }
    func remove(_ key: String) async throws { try await storage.remove(key) }
    func keys(_ prefix: String) async throws -> [String] { try await storage.keys(prefix) }
}

/**
 Persists the assets `document` refers to, then runs `write` (which stores the document), with the
 references protected from a concurrent `collectEditorAssetGarbage` throughout.
 */
private func writeWithAssets(_ storage: EditorStorage, _ registry: EditorAssetRegistry?, _ document: String, _ options: EditorAssetStorageOptions, _ write: () async throws -> Void) async throws {
    let release = leaseAssetRefs(collectAssetRefs(text: document))
    defer { release() }
    if let registry { try await persistEditorAssets(storage, registry, text: document, options: options) }
    try await write()
}

// MARK: - Garbage collection

/// Assets `collectEditorAssetGarbage` keeps although no stored value refers to them (an item of `keep`).
public enum EditorAssetKeep {
    /// Every reference a registry holds (e.g. an open editor's `doc.assets`).
    case registry(EditorAssetRegistry)
    /// An editor document's registry (nothing when it has no `assets`).
    case document(EditorDocument)
    /// The references in a document.
    case value(JSONValue)
    /// The references in JSON text, or one reference.
    case text(String)
}

/// Options of `collectEditorAssetGarbage` (`EditorAssetGarbageOptions`).
public struct EditorAssetGarbageOptions {
    /// Key prefix of stored assets (default `pixerate.assets:`).
    public var prefix: String
    /// More assets to keep although no stored value refers to them.
    public var keep: [EditorAssetKeep]
    /// Report what would be deleted without deleting anything (default false).
    public var dryRun: Bool
    /**
     Delete only these references (e.g. from a dry run). Every one must still be unreferenced, or
     nothing is deleted and the call throws naming them.
     */
    public var only: [String]?

    public init(prefix: String = "pixerate.assets:", keep: [EditorAssetKeep] = [], dryRun: Bool = false, only: [String]? = nil) {
        self.prefix = prefix
        self.keep = keep
        self.dryRun = dryRun
        self.only = only
    }
}

/// What a collection found and did (`EditorAssetGarbageReport`).
public struct EditorAssetGarbageReport: Equatable, Sendable {
    /// Assets found in storage.
    public var assets: Int
    /// Stored values read for references (documents, the index, autosave snapshots, anything else).
    public var scannedKeys: Int
    /// Assets a stored value refers to.
    public var referenced: Int
    /// Unreferenced assets kept because of `keep` or a write in flight.
    public var kept: Int
    /// References of the assets nothing refers to (limited by `only`); deleted unless `dryRun`.
    public var unreferenced: [String]
    /// Characters of data the unreferenced assets hold.
    public var unreferencedChars: Int
    /// References deleted (empty on a dry run).
    public var removed: [String]
    /// Characters of data deleted.
    public var freedChars: Int
    public var dryRun: Bool

    /// The report as the TS core returns it, keys in its order.
    public var json: JSONValue {
        let strings = { (refs: [String]) -> JSONValue in .array(refs.map { JSONValue.string($0) }) }
        return .object(JSONObject([
            ("assets", .number(Double(assets))), ("scannedKeys", .number(Double(scannedKeys))), ("referenced", .number(Double(referenced))),
            ("kept", .number(Double(kept))), ("unreferenced", strings(unreferenced)), ("unreferencedChars", .number(Double(unreferencedChars))),
            ("removed", strings(removed)), ("freedChars", .number(Double(freedChars))), ("dryRun", .bool(dryRun)),
        ]))
    }
}

/// An asset key's id part (`<length>-<hash>`, `~n` for a hash collision).
private let assetIdPattern = try! NSRegularExpression(pattern: "^[0-9a-z]+-[0-9a-z]+(?:~[0-9]+)?$")

/// Data length encoded in a reference (`pixerate-asset:<length>-<hash>`): `parseInt(…, 36) || 0`.
private func refChars(_ ref: String) -> Int {
    let id = String(ref.dropFirst(editorAssetPrefix.count))
    let length = id.split(separator: "-", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    var digits = ""
    for c in length {
        guard c.isASCII, c.isNumber || c.isLetter, Int(String(c), radix: 36) != nil else { break }
        digits.append(c)
    }
    return Int(digits, radix: 36) ?? 0
}

/// `key.slice(prefix.length)` in UTF-16 units.
private func dropUTF16(_ key: String, _ count: Int) -> String {
    String(decoding: Array(key.utf16.dropFirst(count)), as: UTF16.self)
}

private func keptRefs(_ keep: [EditorAssetKeep]) -> Set<String> {
    var out = Set<String>()
    for item in keep {
        switch item {
        case .registry(let registry): out.formUnion(registry.refs())
        case .document(let doc): if let assets = doc.assets { out.formUnion(assets.refs()) }
        case .value(let value): out.formUnion(collectAssetRefs(value))
        case .text(let text): out.formUnion(collectAssetRefs(text: text))
        }
    }
    return out
}

/**
 Deletes the stored assets that nothing refers to (`collectEditorAssetGarbage`). Every other value
 in `storage` (named documents, the document index, autosave snapshots, anything else) is read and
 its `pixerate-asset:` references are kept, so pass the whole storage the editors write to (a
 `withEditorAssets` wrapper works too, but reads assets into its registry). Assets in `keep`, and
 assets a write in flight is about to refer to, are never deleted. Needs storage that lists its
 keys, and throws without it.

 Run it after removing documents, after an autosave snapshot was retired, or on demand. Deleting an
 asset that an open editor's registry still holds is safe: the collection invalidates every
 session's "already written" cache, so its next save writes the asset again.
 */
@discardableResult
public func collectEditorAssetGarbage(_ storage: EditorStorage, _ options: EditorAssetGarbageOptions = EditorAssetGarbageOptions()) async throws -> EditorAssetGarbageReport {
    guard storage.listsKeys else {
        throw EditorStorageError("This \(storage.kind) storage cannot list its keys, so unreferenced assets cannot be found. Give the adapter a keys(prefix) method (every built-in adapter has one).")
    }
    let prefix = options.prefix
    let prefixLength = prefix.utf16.count
    let keep = keptRefs(options.keep)
    let dryRun = options.dryRun
    let storageOptions = EditorAssetStorageOptions(prefix: prefix)
    let watch = AssetLeaseWatch()
    defer { watch.stop() }
    let assetKeys: [String] = try await storage.keys(prefix).filter { (key: String) -> Bool in
        let id = dropUTF16(key, prefixLength)
        return assetIdPattern.firstMatch(in: id, range: NSRange(location: 0, length: (id as NSString).length)) != nil
    }
    let others: [String] = try await storage.keys("").filter { !$0.jsStartsWith(prefix) }
    var live = Set<String>()
    for key in others {
        if let value = try await storage.get(key), value.jsIncludes(editorAssetPrefix) {
            live.formUnion(collectAssetRefs(text: value))
        }
    }
    var referenced = 0
    var kept = 0
    var candidates: [String] = []
    for key in assetKeys {
        let ref = editorAssetPrefix + dropUTF16(key, prefixLength)
        if live.contains(ref) {
            referenced += 1
        } else if keep.contains(ref) || watch.touched(ref) {
            kept += 1
        } else {
            candidates.append(ref)
        }
    }
    var unreferenced = candidates
    if let only = options.only {
        var wanted: [String] = []
        var wantedSet = Set<String>()
        for ref in only where wantedSet.insert(ref).inserted { wanted.append(ref) }
        let candidateSet = Set(candidates)
        let stale = wanted.filter { !candidateSet.contains($0) }
        if !stale.isEmpty {
            let shown = stale.prefix(3).joined(separator: ", ") + (stale.count > 3 ? ", …" : "")
            throw EditorStorageError("\(stale.count) of the given asset\(stale.count == 1 ? " is" : "s are") not unreferenced in storage now (\(shown)): unknown, already deleted, referenced or in use. Nothing was deleted; find the unreferenced assets again.")
        }
        unreferenced = candidates.filter { wantedSet.contains($0) }
    }
    var report = EditorAssetGarbageReport(
        assets: assetKeys.count, scannedKeys: others.count, referenced: referenced, kept: kept,
        unreferenced: unreferenced, unreferencedChars: unreferenced.reduce(0) { $0 + refChars($1) },
        removed: [], freedChars: 0, dryRun: dryRun
    )
    if dryRun || unreferenced.isEmpty { return report }
    // Change the marker first: every session's "already written" cache is now stale.
    let stamp = String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
    try await storage.set(assetMarkerKey(storageOptions), "\(stamp)-\(String(UInt64.random(in: 0 ... UInt64.max), radix: 36))")
    for ref in unreferenced {
        // A write that started meanwhile is about to refer to it.
        if watch.touched(ref) {
            report.kept += 1
            continue
        }
        do {
            try await storage.remove(assetKey(ref, storageOptions))
        } catch {
            throw EditorStorageError("Deleted \(report.removed.count) of \(unreferenced.count) unreferenced assets, then storage failed: \(errorMessage(error)). The rest are still stored and nothing refers to the deleted ones; run the collection again.")
        }
        report.removed.append(ref)
        report.freedChars += refChars(ref)
    }
    return report
}

/**
 `collectEditorAssetGarbage` for automatic, best-effort runs (`tryCollectEditorAssetGarbage`):
 nil instead of throwing when the storage cannot list keys or the collection fails.
 */
@discardableResult
public func tryCollectEditorAssetGarbage(_ storage: EditorStorage, _ options: EditorAssetGarbageOptions = EditorAssetGarbageOptions()) async -> EditorAssetGarbageReport? {
    if !storage.listsKeys { return nil }
    do {
        return try await collectEditorAssetGarbage(storage, options)
    } catch {
        return nil
    }
}

/**
 The collection an editor autosave runs after retiring a snapshot (`collectRetiredEditorAssets`):
 best effort, keeping the assets `doc` uses now, and only for documents with `assets`. `setting`
 is the autosave's collection setting (nil: off). Pass the unwrapped storage.

 Not the whole registry: a recovery check reads the old snapshot's assets into it, so keeping it
 would keep exactly what a discard throws away. Assets only the registry (e.g. undo) still holds
 are written again by the next save.
 */
@discardableResult
public func collectRetiredEditorAssets(_ storage: EditorStorage, _ doc: EditorDocument, _ setting: EditorAssetGarbageOptions? = EditorAssetGarbageOptions()) async -> EditorAssetGarbageReport? {
    guard doc.assets != nil, let setting else { return nil }
    var options = setting
    options.dryRun = false
    options.only = nil
    options.keep = [.value(doc.getDocument())] + setting.keep
    return await tryCollectEditorAssetGarbage(storage, options)
}
