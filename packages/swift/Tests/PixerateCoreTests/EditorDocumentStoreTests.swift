import XCTest
@testable import PixerateCore

/// The TS tests' inline image: a PNG data URL of 822 characters (`bigDataUrl` in `editor-asset-gc.test.ts`).
private func bigDataUrl(_ seed: Int) -> String {
    let letters = Array("ABCDEFGHIJKLMNOP")
    return "data:image/png;base64," + String((0 ..< 800).map { (i: Int) -> Character in letters[(i * seed) % 16] })
}

private func keyOf(_ ref: String) -> String { "pixerate.assets:" + ref.dropFirst("pixerate-asset:".count) }

/// The asset keys in storage, sorted (`assetKeys` in the TS tests).
private func assetKeys(_ storage: MemoryEditorStorage) -> [String] {
    storage.orderedKeys.filter { $0.range(of: "^pixerate\\.assets:[0-9a-z]+-", options: .regularExpression) != nil }.sorted()
}

// The references and lengths the TS core gives these images (`createEditorAssetRegistry().put`).
private let REF3 = "pixerate-asset:mu-2a8u0vv4ghr"
private let REF5 = "pixerate-asset:mu-1a6ilvan2bz"
private let REF7 = "pixerate-asset:mu-1h0dwjqvw0g"
private let REF9 = "pixerate-asset:mu-1vn9j21hfuk"
private let REF11 = "pixerate-asset:mu-v5gyb9633v"

/// A tiny editor document whose state is a list of inline images (`pictureDoc` in the TS tests).
private final class PictureEditor {
    var pictures: [String] = []
    let history = HistoryManager()
    var listeners: [UUID: () -> Void] = [:]
    let assets: EditorAssetRegistry
    var doc: EditorDocument!

    init(assets: EditorAssetRegistry = EditorAssetRegistry(), readOnly: String? = nil) throws {
        self.assets = assets
        doc = try EditorDocument(EditorDocumentSpec(
            kind: "picture",
            recordsLoads: false,
            get: { [unowned self] in ["pictures": .array(self.pictures.map { JSONValue.string($0) })] },
            load: { [unowned self] document, _ in
                self.pictures = document["pictures"]?.arrayValue?.compactMap(\.stringValue) ?? []
                self.emit()
                return []
            },
            history: history,
            readOnly: { readOnly },
            subscribe: { [unowned self] listener in
                let id = UUID()
                self.listeners[id] = listener
                return Cancellable { [weak self] in self?.listeners[id] = nil }
            },
            assets: assets
        ))
    }

    func emit() { for l in Array(listeners.values) { l() } }

    func set(_ next: [String]) {
        pictures = next
        emit()
    }
}

/// Storage whose operations fail when `failure` says so (`withStorageFailures`), with or without key listing.
private final class FailingStorage: EditorStorage {
    let inner: MemoryEditorStorage
    let failure: (String, String) -> Bool
    let lists: Bool
    init(_ inner: MemoryEditorStorage = MemoryEditorStorage(), lists: Bool = true, failure: @escaping (String, String) -> Bool = { _, _ in false }) {
        self.inner = inner
        self.lists = lists
        self.failure = failure
    }
    var kind: String { inner.kind }
    var listsKeys: Bool { lists }
    private func check(_ op: String, _ key: String) throws {
        if failure(op, key) { throw EditorStorageError("injected \(op) failure for \"\(key)\"") }
    }
    func get(_ key: String) async throws -> String? { try check("get", key); return try await inner.get(key) }
    func set(_ key: String, _ value: String) async throws { try check("set", key); try await inner.set(key, value) }
    func remove(_ key: String) async throws { try check("remove", key); try await inner.remove(key) }
    func keys(_ prefix: String) async throws -> [String] {
        guard lists else { throw EditorStorageError("no keys") }
        try check("keys", prefix)
        return try await inner.keys(prefix)
    }
}

private func message(_ error: Error) -> String { (error as? LocalizedError)?.errorDescription ?? "\(error)" }

/// Asset garbage collection and the document store (`persistence/assets.ts`, `documentStore.ts`);
/// expected values are what the TS core returns for the same calls (`editor-asset-gc.test.ts`).
final class EditorDocumentStoreTests: XCTestCase {
    func testTheImagesHaveTheTypeScriptReferences() {
        let registry = EditorAssetRegistry()
        XCTAssertEqual([3, 5, 7, 9, 11].map { registry.put(bigDataUrl($0)) }, [REF3, REF5, REF7, REF9, REF11])
        XCTAssertEqual(bigDataUrl(3).utf16.count, 822)
    }

    func testMemoryStorageListsKeysInInsertionOrderByPrefix() async throws {
        let storage = MemoryEditorStorage()
        for key in ["b:1", "a:2", "a:1"] { try await storage.set(key, "x") }
        try await storage.set("b:1", "y")
        let all = try await storage.keys("")
        XCTAssertEqual(all, ["b:1", "a:2", "a:1"])
        let a = try await storage.keys("a:")
        XCTAssertEqual(a, ["a:2", "a:1"])
        try await storage.remove("a:2")
        try await storage.remove("missing")
        XCTAssertEqual(storage.orderedKeys, ["b:1", "a:1"])
        // A wrapper keeps the listing; storage without one cannot be collected.
        let wrapped = withEditorAssets(storage, EditorAssetRegistry())
        XCTAssertTrue(wrapped.listsKeys)
        XCTAssertEqual(wrapped.kind, "memory")
        let b = try await wrapped.keys("b:")
        XCTAssertEqual(b, ["b:1"])
    }

    func testDirectoryStorageRoundTripsAndListsKeys() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pixerate-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let storage = DirectoryEditorStorage(directory: dir)
        let none = try await storage.keys("")
        XCTAssertEqual(none, [])
        let missing = try await storage.get("pixerate.documents:index")
        XCTAssertNil(missing)
        try await storage.set("pixerate.documents:file:paint/sketch", "{\"a\":1}")
        try await storage.set("pixerate.assets:mu-2a8u0vv4ghr", "data")
        try await storage.set(".hidden/../é", "odd")
        try Data().write(to: dir.appendingPathComponent(".DS_Store"))
        let keys = try await storage.keys("")
        XCTAssertEqual(keys, [".hidden/../é", "pixerate.assets:mu-2a8u0vv4ghr", "pixerate.documents:file:paint/sketch"])
        let assets = try await storage.keys("pixerate.assets:")
        XCTAssertEqual(assets, ["pixerate.assets:mu-2a8u0vv4ghr"])
        let odd = try await storage.get(".hidden/../é")
        XCTAssertEqual(odd, "odd")
        try await storage.remove("pixerate.assets:mu-2a8u0vv4ghr")
        try await storage.remove("pixerate.assets:mu-2a8u0vv4ghr")
        let after = try await storage.keys("pixerate.")
        XCTAssertEqual(after, ["pixerate.documents:file:paint/sketch"])
    }

    func testCollectionDeletesOnlyAssetsNoStoredValueRefersTo() async throws {
        let storage = MemoryEditorStorage()
        let registry = EditorAssetRegistry()
        let wrapped = withEditorAssets(storage, registry)
        let keepDoc = externalizeAssets(["png": .string(bigDataUrl(3))], registry)
        let dropDoc = externalizeAssets(["png": .string(bigDataUrl(5))], registry)
        try await wrapped.set("docs:keep", keepDoc.stringified())
        try await wrapped.set("docs:drop", dropDoc.stringified())
        try await storage.set("unrelated", "plain text")
        XCTAssertEqual(storage.orderedKeys, ["pixerate.assets:mu-2a8u0vv4ghr", "docs:keep", "pixerate.assets:mu-1a6ilvan2bz", "docs:drop", "unrelated"])
        try await storage.remove("docs:drop")

        let dry = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(dryRun: true))
        XCTAssertEqual(dry.json.stringified(), #"{"assets":2,"scannedKeys":2,"referenced":1,"kept":0,"unreferenced":["pixerate-asset:mu-1a6ilvan2bz"],"unreferencedChars":822,"removed":[],"freedChars":0,"dryRun":true}"#)
        XCTAssertEqual(assetKeys(storage).count, 2)

        let report = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual(report.json.stringified(), #"{"assets":2,"scannedKeys":2,"referenced":1,"kept":0,"unreferenced":["pixerate-asset:mu-1a6ilvan2bz"],"unreferencedChars":822,"removed":["pixerate-asset:mu-1a6ilvan2bz"],"freedChars":822,"dryRun":false}"#)
        XCTAssertEqual(Array(storage.orderedKeys.prefix(3)), ["pixerate.assets:mu-2a8u0vv4ghr", "docs:keep", "unrelated"])
        XCTAssertEqual(storage.orderedKeys.last, "pixerate.assets:#collected")
        XCTAssertEqual(storage.values["unrelated"], "plain text")
        let again = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual(again.json.stringified(), #"{"assets":1,"scannedKeys":2,"referenced":1,"kept":0,"unreferenced":[],"unreferencedChars":0,"removed":[],"freedChars":0,"dryRun":false}"#)
    }

    func testCollectionKeepsRegistriesDocumentsReferencesAndValues() async throws {
        let storage = MemoryEditorStorage()
        let a = EditorAssetRegistry()
        let refs = [3, 5, 7, 9].map { a.put(bigDataUrl($0)) }
        for ref in refs { try await storage.set(keyOf(ref), a.get(ref)!) }
        let onlyFirst = EditorAssetRegistry()
        onlyFirst.set(refs[0], a.get(refs[0])!)
        let picture = try PictureEditor()
        picture.assets.set(refs[1], a.get(refs[1])!)
        let report = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(keep: [.registry(onlyFirst), .document(picture.doc), .text(refs[2])], dryRun: true))
        XCTAssertEqual(report.kept, 3)
        XCTAssertEqual(report.unreferenced, [refs[3]])
        let byValue = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(keep: [.value(["layers": [["png": .string(refs[3])]]])], dryRun: true))
        XCTAssertEqual(byValue.unreferenced, [refs[0], refs[1], refs[2]])
        XCTAssertEqual(assetKeys(storage).count, 4)
    }

    func testOnlyDeletesTheGivenReferencesAndRefusesStaleOnesWithoutDeleting() async throws {
        let storage = MemoryEditorStorage()
        let registry = EditorAssetRegistry()
        let refs = [3, 5, 7].map { registry.put(bigDataUrl($0)) }
        for ref in refs { try await storage.set(keyOf(ref), registry.get(ref)!) }
        try await storage.set("doc", #"{"png":"\#(refs[2])"}"#)
        do {
            _ = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(only: [refs[0], refs[2]]))
            XCTFail("a referenced asset was accepted")
        } catch {
            XCTAssertEqual(message(error), "1 of the given asset is not unreferenced in storage now (pixerate-asset:mu-1h0dwjqvw0g): unknown, already deleted, referenced or in use. Nothing was deleted; find the unreferenced assets again.")
        }
        do {
            _ = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(only: [refs[2], "pixerate-asset:a-b", "pixerate-asset:c-d", "pixerate-asset:e-f", "pixerate-asset:a-b"]))
            XCTFail("unknown assets were accepted")
        } catch {
            XCTAssertEqual(message(error), "4 of the given assets are not unreferenced in storage now (pixerate-asset:mu-1h0dwjqvw0g, pixerate-asset:a-b, pixerate-asset:c-d, …): unknown, already deleted, referenced or in use. Nothing was deleted; find the unreferenced assets again.")
        }
        XCTAssertEqual(assetKeys(storage).count, 3)
        let report = try await collectEditorAssetGarbage(storage, EditorAssetGarbageOptions(only: [refs[0]]))
        XCTAssertEqual(report.json.stringified(), #"{"assets":3,"scannedKeys":1,"referenced":1,"kept":0,"unreferenced":["pixerate-asset:mu-2a8u0vv4ghr"],"unreferencedChars":822,"removed":["pixerate-asset:mu-2a8u0vv4ghr"],"freedChars":822,"dryRun":false}"#)
        XCTAssertEqual(assetKeys(storage).count, 2)
    }

    func testStorageThatCannotListKeysIsRefusedAndTheBestEffortFormReturnsNil() async throws {
        let plain = FailingStorage(lists: false)
        do {
            _ = try await collectEditorAssetGarbage(plain)
            XCTFail("storage without keys was collected")
        } catch {
            XCTAssertEqual(message(error), "This memory storage cannot list its keys, so unreferenced assets cannot be found. Give the adapter a keys(prefix) method (every built-in adapter has one).")
        }
        let none = await tryCollectEditorAssetGarbage(plain)
        XCTAssertNil(none)
        let failing = await tryCollectEditorAssetGarbage(FailingStorage { op, _ in op == "keys" })
        XCTAssertNil(failing)
    }

    func testAStorageFailureMidWaySaysHowFarItGot() async throws {
        let inner = MemoryEditorStorage()
        let registry = EditorAssetRegistry()
        for ref in [3, 5].map({ registry.put(bigDataUrl($0)) }) { try await inner.set(keyOf(ref), registry.get(ref)!) }
        var removes = 0
        let storage = FailingStorage(inner) { op, _ in
            guard op == "remove" else { return false }
            removes += 1
            return removes == 2
        }
        do {
            _ = try await collectEditorAssetGarbage(storage)
            XCTFail("the failure was swallowed")
        } catch {
            XCTAssertEqual(message(error), "Deleted 1 of 2 unreferenced assets, then storage failed: injected remove failure for \"pixerate.assets:mu-1a6ilvan2bz\". The rest are still stored and nothing refers to the deleted ones; run the collection again.")
        }
    }

    func testAssetsAWriteInFlightIsAboutToReferToAreKept() async throws {
        let storage = MemoryEditorStorage()
        let registry = EditorAssetRegistry()
        let doc = externalizeAssets(["png": .string(bigDataUrl(9))], registry)
        try await persistEditorAssets(storage, registry, doc)
        let release = leaseAssetRefs([REF9, REF9])
        let during = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual([during.assets, during.kept, during.removed.count], [1, 1, 0])
        try await storage.set("doc", doc.stringified())
        release()
        release()
        let after = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual(after.referenced, 1)
        // Released and unreferenced: deleted.
        try await storage.remove("doc")
        let gone = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual(gone.removed, [REF9])
    }

    func testSessionsWriteDeletedAssetsAgainInsteadOfTrustingTheirCache() async throws {
        let storage = MemoryEditorStorage()
        let registry = EditorAssetRegistry()
        let doc = externalizeAssets(["png": .string(bigDataUrl(11))], registry)
        try await persistEditorAssets(storage, registry, doc)
        let first = try await collectEditorAssetGarbage(storage)
        XCTAssertEqual(first.removed.count, 1)
        XCTAssertEqual(assetKeys(storage), [])
        try await withEditorAssets(storage, registry).set("doc", doc.stringified())
        XCTAssertEqual(assetKeys(storage), [keyOf(REF11)])
        XCTAssertEqual(collectAssetRefs(text: storage.values["doc"]!), [REF11])
    }

    func testTheStoreSavesListsOpensAndRemovesAsTheTypeScriptStoreDoes() async throws {
        let storage = MemoryEditorStorage()
        var tick = 0.0
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage, now: {
            defer { tick += 1 }
            return 1_767_225_600_000 + 60000 * tick
        }))
        let picture = try PictureEditor()
        picture.set([bigDataUrl(3), bigDataUrl(5)])
        let first = try await store.save(picture.doc, name: "First")
        XCTAssertEqual(first.json.stringifiedObject, #"{"key":"picture/first","kind":"picture","name":"First","formatVersion":1,"savedAt":"2026-01-01T00:00:00.000Z"}"#)
        picture.set([bigDataUrl(3), bigDataUrl(7)])
        let second = try await store.save(picture.doc, name: "Second")
        XCTAssertEqual(second.savedAt, "2026-01-01T00:01:00.000Z")
        XCTAssertEqual(storage.orderedKeys, ["pixerate.assets:mu-2a8u0vv4ghr", "pixerate.assets:mu-1a6ilvan2bz", "pixerate.documents:file:picture/first", "pixerate.documents:index", "pixerate.assets:mu-1h0dwjqvw0g", "pixerate.documents:file:picture/second"])
        XCTAssertEqual(storage.values["pixerate.documents:index"], #"{"version":1,"items":[{"key":"picture/first","kind":"picture","name":"First","formatVersion":1,"savedAt":"2026-01-01T00:00:00.000Z"},{"key":"picture/second","kind":"picture","name":"Second","formatVersion":1,"savedAt":"2026-01-01T00:01:00.000Z"}]}"#)
        XCTAssertEqual(storage.values["pixerate.documents:file:picture/second"], #"{"format":"pixerate.editor-document","kind":"picture","formatVersion":1,"name":"Second","document":{"pictures":["pixerate-asset:mu-2a8u0vv4ghr","pixerate-asset:mu-1h0dwjqvw0g"]}}"#)

        // Removing a document collects its assets, keeping the one the other document shares.
        let removed = try await store.remove("picture/first")
        XCTAssertTrue(removed)
        XCTAssertEqual(storage.orderedKeys, ["pixerate.assets:mu-2a8u0vv4ghr", "pixerate.documents:index", "pixerate.assets:mu-1h0dwjqvw0g", "pixerate.documents:file:picture/second", "pixerate.assets:#collected"])
        let missingRemoved = try await store.remove("picture/missing")
        XCTAssertFalse(missingRemoved)

        let fresh = try PictureEditor()
        let opened = try await store.open(fresh.doc, key: "picture/second")
        XCTAssertEqual(opened.entry, second)
        XCTAssertEqual(opened.report, LoadReport(version: 1))
        XCTAssertEqual(fresh.doc.getDocument(), picture.doc.getDocument())
        XCTAssertEqual(fresh.pictures, [bigDataUrl(3), bigDataUrl(7)])

        do {
            _ = try await store.open(fresh.doc, key: "picture/nope")
            XCTFail("an unknown key opened")
        } catch {
            XCTAssertEqual(message(error), "There is no saved document \"picture/nope\". Saved picture documents: picture/second.")
        }
        do {
            _ = try await createEditorDocumentStore(EditorDocumentStoreOptions(storage: MemoryEditorStorage())).open(fresh.doc, key: "x")
            XCTFail("an empty store opened a document")
        } catch {
            XCTAssertEqual(message(error), "There is no saved document \"x\". No picture documents are saved yet.")
        }
        // An asset that storage lost: refused before the editor changes.
        try await storage.remove(keyOf(REF3))
        let other = try PictureEditor()
        do {
            _ = try await store.open(other.doc, key: "picture/second")
            XCTFail("a document with a lost asset opened")
        } catch {
            XCTAssertEqual(message(error), "The saved document \"picture/second\" refers to 1 asset that storage no longer has, so it cannot be opened.")
        }
        XCTAssertEqual(other.pictures, [])
        let listed = try await store.list()
        XCTAssertEqual(listed, [second])
        let others = try await store.list(kind: "other")
        XCTAssertEqual(others, [])
        let file = try await store.read("picture/second")
        XCTAssertEqual(file?.name, "Second")
        let none = try await store.read("picture/first")
        XCTAssertNil(none)
    }

    func testTheIndexIsReadBackNewestFirstAndBadEntriesAreSkipped() async throws {
        let storage = MemoryEditorStorage([
            "pixerate.documents:index": #"{"version":1,"items":[{"key":"paint/a","kind":"paint","name":"A","formatVersion":1,"savedAt":"2026-01-01T00:00:00.000Z"},{"key":3,"kind":"paint"},null,{"key":"paint/b","kind":"paint","savedAt":"2026-02-01T00:00:00.000Z","extra":true},{"key":"chart/d","kind":"chart","name":"D","savedAt":"2027-01-01T00:00:00.000Z"}]}"#,
        ])
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage))
        let all = try await store.list()
        XCTAssertEqual(all.map(\.key), ["chart/d", "paint/b", "paint/a"])
        let paint = try await store.list(kind: "paint")
        XCTAssertEqual(paint.map(\.key), ["paint/b", "paint/a"])
        // Not JSON: an empty index.
        let broken = createEditorDocumentStore(EditorDocumentStoreOptions(storage: MemoryEditorStorage(["pixerate.documents:index": "{nope"])))
        let empty = try await broken.list()
        XCTAssertEqual(empty, [])
    }

    func testCollectionCanBeOffAndRunsOnDemand() async throws {
        let storage = MemoryEditorStorage()
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage, collectAssetGarbage: .off))
        let picture = try PictureEditor()
        picture.set([bigDataUrl(5)])
        _ = try await store.save(picture.doc, name: "Only")
        try await store.remove("picture/only")
        XCTAssertEqual(assetKeys(storage).count, 1)
        XCTAssertTrue(store.canCollectAssetGarbage)
        let report = try await store.collectAssetGarbage()
        XCTAssertEqual(report.removed.count, 1)
        XCTAssertEqual(assetKeys(storage).count, 0)
        // Storage that cannot list keys: no collection, and remove still works.
        let plainStore = createEditorDocumentStore(EditorDocumentStoreOptions(storage: FailingStorage(lists: false)))
        XCTAssertFalse(plainStore.canCollectAssetGarbage)
        _ = try await plainStore.save(picture.doc, name: "Only")
        let removed = try await plainStore.remove("picture/only")
        XCTAssertTrue(removed)
        // Replacing a saved document leaves the old assets for the next collection.
        let replacing = MemoryEditorStorage()
        let same = createEditorDocumentStore(EditorDocumentStoreOptions(storage: replacing))
        picture.set([bigDataUrl(5)])
        _ = try await same.save(picture.doc, name: "Same")
        picture.set([bigDataUrl(7)])
        _ = try await same.save(picture.doc, name: "Same")
        XCTAssertEqual(assetKeys(replacing).count, 2)
        let collected = try await same.collectAssetGarbage(EditorAssetGarbageOptions(keep: []))
        XCTAssertEqual(collected.removed, [REF5])
    }

    func testSlugsAndTimesMatchTheTypeScriptCore() {
        let names = ["Release flow v2", "  Ünïcödé   Ñame ", "!!!", "", String(repeating: "a", count: 100) + " b", "İstanbul ΣΑΣ", "ﬁle №5"]
        XCTAssertEqual(names.map(slugifyDocumentName), ["release-flow-v2", "u-ni-co-de-n-ame", "untitled", "untitled", String(repeating: "a", count: 80), "i-stanbul", "file-no5"])
        XCTAssertEqual([0, 1_767_225_600_000, 1_767_225_600_123, -1, 253_402_300_799_999, 951_782_400_000].map(jsISOString), ["1970-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.123Z", "1969-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z", "2000-02-29T00:00:00.000Z"])
    }

    func testTheAssetToolsFindAndDeleteThroughCallTool() async throws {
        let storage = MemoryEditorStorage()
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage, now: { 1_767_225_600_000 }, collectAssetGarbage: .off))
        let picture = try PictureEditor()
        let registry = ToolRegistry(validateArguments: true)
        _ = try registry.register(createDocumentToolProvider(picture.doc, DocumentToolProviderOptions(namespace: "", store: store)))
        picture.set([bigDataUrl(3)])
        _ = try await store.save(picture.doc, name: "A")
        picture.set([bigDataUrl(5)])
        _ = try await store.save(picture.doc, name: "B")
        try await store.remove("picture/a")
        // Another session's leftover.
        try await storage.set(keyOf(REF9), bigDataUrl(9))
        // The open document now also uses a picture that only an unsaved write has stored.
        picture.set([bigDataUrl(5), bigDataUrl(11)])
        try await storage.set(keyOf(REF11), bigDataUrl(11))

        let found = await registry.callTool("find_unreferenced_picture_assets")
        XCTAssertEqual(found.structuredContent.map { JSONValue.object($0).stringified() }, #"{"assets":4,"referenced":1,"kept":1,"unreferenced":2,"unreferencedChars":1644,"refs":["pixerate-asset:mu-2a8u0vv4ghr","pixerate-asset:mu-1vn9j21hfuk"],"more":0}"#)
        let bad = await registry.callTool("delete_unreferenced_picture_assets", ["refs": ["pixerate-asset:zz-zz"]])
        XCTAssertTrue(bad.isError)
        XCTAssertEqual(bad.structuredContent?["error"]?["message"], "1 of the given asset is not unreferenced in storage now (pixerate-asset:zz-zz): unknown, already deleted, referenced or in use. Nothing was deleted; find the unreferenced assets again.")
        let invalid = await registry.callTool("delete_unreferenced_picture_assets", ["refs": ["nope"]])
        XCTAssertEqual(invalid.structuredContent?["error"]?["code"], "invalid_arguments")
        let extra = await registry.callTool("delete_unreferenced_picture_assets", ["all": true])
        XCTAssertEqual(extra.structuredContent?["error"]?["details"], [["path": "/all", "message": "Unknown property \"all\". Allowed: refs."]])
        XCTAssertEqual(assetKeys(storage).count, 4)

        let one = await registry.callTool("delete_unreferenced_picture_assets", ["refs": [.string(REF9)]])
        XCTAssertEqual(one.structuredContent.map { JSONValue.object($0).stringified() }, #"{"removed":1,"freedChars":822,"kept":1,"remaining":3}"#)
        let rest = await registry.callTool("delete_unreferenced_picture_assets")
        XCTAssertEqual(rest.structuredContent.map { JSONValue.object($0).stringified() }, #"{"removed":1,"freedChars":822,"kept":1,"remaining":2}"#)
        let again = await registry.callTool("delete_unreferenced_picture_assets")
        XCTAssertEqual(again.structuredContent.map { JSONValue.object($0).stringified() }, #"{"removed":0,"freedChars":0,"kept":1,"remaining":2}"#)

        let list = await registry.callTool("list_saved_picture_documents")
        XCTAssertEqual(list.structuredContent.map { JSONValue.object($0).stringified() }, #"{"documents":[{"key":"picture/b","name":"B","savedAt":"2026-01-01T00:00:00.000Z","formatVersion":1}]}"#)
        let save = await registry.callTool("save_picture_document")
        XCTAssertEqual(save.structuredContent.map { JSONValue.object($0).stringified() }, #"{"key":"picture/untitled-picture","name":"Untitled picture","savedAt":"2026-01-01T00:00:00.000Z","revision":3}"#)
        let open = await registry.callTool("open_saved_picture_document", ["key": "picture/b"])
        XCTAssertEqual(open.structuredContent.map { JSONValue.object($0).stringified() }, #"{"key":"picture/b","name":"B","revision":4,"undoable":false}"#)
    }

    func testTheToolsAreListedOnlyWhenTheyCanWorkAndRefuseWritesWhenReadOnly() async throws {
        let picture = try PictureEditor()
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: MemoryEditorStorage()))
        let provider = createDocumentToolProvider(picture.doc, DocumentToolProviderOptions(store: store))
        XCTAssertEqual([provider.id, provider.title, provider.description], ["picture-document", "Picture document", "Get, load, undo, redo, save and open the whole picture."])
        XCTAssertEqual(provider.tools.map(\.name), ["get_picture_document", "load_picture_document", "undo_picture", "redo_picture", "save_picture_document", "list_saved_picture_documents", "open_saved_picture_document", "find_unreferenced_picture_assets", "delete_unreferenced_picture_assets"])
        let plainStore = createEditorDocumentStore(EditorDocumentStoreOptions(storage: FailingStorage(lists: false)))
        XCTAssertEqual(createDocumentToolProvider(picture.doc, DocumentToolProviderOptions(store: plainStore)).tools.map(\.name).last, "open_saved_picture_document")
        let plain = try EditorDocument(EditorDocumentSpec(kind: "plain", get: { ["n": 1] }, load: { _, _ in [] }, history: HistoryManager()))
        XCTAssertFalse(createDocumentToolProvider(plain, DocumentToolProviderOptions(store: store)).tools.map(\.name).contains("find_unreferenced_plain_assets"))
        XCTAssertEqual(createDocumentToolProvider(plain, DocumentToolProviderOptions(history: false)).description, "Get, load the whole plain.")

        let locked = try PictureEditor(readOnly: "The document is locked.")
        let registry = ToolRegistry(validateArguments: true)
        _ = try registry.register(createDocumentToolProvider(locked.doc, DocumentToolProviderOptions(namespace: "", store: store, name: { "Named" })))
        let find = await registry.callTool("find_unreferenced_picture_assets")
        XCTAssertFalse(find.isError)
        let refusal = "The document is locked. Read tools still work; write tools are refused."
        let delete = await registry.callTool("delete_unreferenced_picture_assets")
        XCTAssertEqual(delete.structuredContent?["error"]?["message"], .string(refusal))
        let open = await registry.callTool("open_saved_picture_document", ["key": "picture/b"])
        XCTAssertEqual(open.structuredContent?["error"]?["message"], .string(refusal))
        // Saving only reads the document, so it still works (under the host's name).
        let save = await registry.callTool("save_picture_document")
        XCTAssertEqual(save.structuredContent?["key"], "picture/named")
        XCTAssertEqual(save.structuredContent?["revision"], 0)
    }
}

private extension JSONObject {
    var stringifiedObject: String { JSONValue.object(self).stringified() }
}
