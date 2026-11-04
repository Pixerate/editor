import Foundation

/**
 * A dictionary that remembers insertion order, as a JavaScript `Map` does: iteration is in the
 * order keys were first set, `set` on an existing key keeps its place, and a deleted key that is
 * set again goes to the end. The raster code relies on that order for LRU eviction and for the
 * order of lists it returns.
 */
public struct OrderedMap<Key: Hashable, Value>: Sequence {
    private var storage: [Key: Value] = [:]
    private var order: [Key] = []

    public init() {}

    public var count: Int { storage.count }
    public var isEmpty: Bool { storage.isEmpty }
    public var keys: [Key] { order }
    public var values: [Value] { order.map { storage[$0]! } }

    public subscript(key: Key) -> Value? {
        get { storage[key] }
        set {
            if let v = newValue { set(key, v) } else { delete(key) }
        }
    }

    public func get(_ key: Key) -> Value? { storage[key] }
    public func has(_ key: Key) -> Bool { storage[key] != nil }

    public mutating func set(_ key: Key, _ value: Value) {
        if storage.updateValue(value, forKey: key) == nil { order.append(key) }
    }

    @discardableResult
    public mutating func delete(_ key: Key) -> Bool {
        guard storage.removeValue(forKey: key) != nil else { return false }
        if order.last == key { order.removeLast() } else if let i = order.firstIndex(of: key) { order.remove(at: i) }
        return true
    }

    public mutating func clear() {
        storage.removeAll(keepingCapacity: true)
        order.removeAll(keepingCapacity: true)
    }

    /// The first (oldest) entry.
    public var first: (key: Key, value: Value)? {
        guard let k = order.first else { return nil }
        return (k, storage[k]!)
    }

    public func makeIterator() -> AnyIterator<(key: Key, value: Value)> {
        var i = 0
        let order = self.order
        let storage = self.storage
        return AnyIterator {
            guard i < order.count else { return nil }
            defer { i += 1 }
            return (order[i], storage[order[i]]!)
        }
    }
}

/**
 * A cache keyed by object identity whose entries go away with their key, as a `WeakMap`: an entry
 * is found only while its key object is alive, and dead entries are swept now and then.
 */
final class IdentityCache<Key: AnyObject, Value> {
    private struct Entry {
        weak var key: Key?
        var value: Value
    }
    private var entries: [ObjectIdentifier: Entry] = [:]
    private var writes = 0

    func get(_ key: Key) -> Value? {
        guard let e = entries[ObjectIdentifier(key)], e.key === key else { return nil }
        return e.value
    }

    func set(_ key: Key, _ value: Value) {
        entries[ObjectIdentifier(key)] = Entry(key: key, value: value)
        writes += 1
        if writes >= 256 {
            writes = 0
            entries = entries.filter { $0.value.key != nil }
        }
    }

    func has(_ key: Key) -> Bool { get(key) != nil }

    func clear() { entries.removeAll() }
}

/// `a` when it is in range, else the nearest bound (the TS `clamp`).
@inline(__always) func clampValue(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v < lo ? lo : (v > hi ? hi : v) }

extension OrderedMap: @unchecked Sendable where Key: Sendable, Value: Sendable {}

/// Module-level mutable state (caches, counters) behind a lock, as the TS module variables are.
final class Locked<T>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()
    init(_ value: T) { self.value = value }
    func with<R>(_ body: (inout T) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }
}
