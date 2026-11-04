import Foundation
import PixerateCore
import PixerateRaster

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

// MARK: - Reading loose JSON the way the TS normalisers do

extension JSONValue {
    /// A finite number (`typeof v === 'number' && Number.isFinite(v)`), else nil.
    var finite: Double? {
        guard case .number(let n) = self, n.isFinite else { return nil }
        return n
    }
}

/// `unit(v, d)`: a finite number clamped to 0..1, else `d`.
func unitValue(_ v: JSONValue?, _ d: Double) -> Double {
    guard let n = v?.finite else { return d }
    return Swift.min(1, Swift.max(0, n))
}

/// `range(v, lo, hi, d)`: a finite number clamped to lo..hi, else `d`.
func rangeValue(_ v: JSONValue?, _ lo: Double, _ hi: Double, _ d: Double) -> Double {
    guard let n = v?.finite else { return d }
    return Swift.min(hi, Swift.max(lo, n))
}

/// A boolean, else `d`.
func boolValue(_ v: JSONValue?, _ d: Bool) -> Bool { v?.boolValue ?? d }

/// A deep copy as JSON makes one (`JSON.parse(JSON.stringify(v))`): drops nothing in this model.
func copyJSON(_ v: JSONValue) -> JSONValue { v }

extension JSONObject {
    /// The object without `keys` (`const { a, b, ...rest } = o`).
    func without(_ keys: String...) -> JSONObject {
        var o = self
        for k in keys { o[k] = nil }
        return o
    }

    /// `{ ...self, ...other }`.
    func merging(_ other: JSONObject) -> JSONObject {
        var o = self
        for (k, v) in other { o[k] = v }
        return o
    }
}

/// `{ x, y }` as JSON.
func pointJSON(_ x: Double, _ y: Double) -> JSONValue { ["x": .number(x), "y": .number(y)] }

extension RasterRect {
    var json: JSONValue { ["x": .number(Double(x)), "y": .number(Double(y)), "width": .number(Double(width)), "height": .number(Double(height))] }
}

/// A rect as JSON, or null.
func rectJSON(_ r: RasterRect?) -> JSONValue { r?.json ?? .null }

/// `Math.round(v * 1000) / 1000`.
func round3(_ v: Double) -> Double { JS.round(v * 1000) / 1000 }
