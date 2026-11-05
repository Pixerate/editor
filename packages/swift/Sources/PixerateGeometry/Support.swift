import Foundation
import PixerateCore
import PixerateRaster

// The geometry port follows the TS core (`canvas/pathops`, `curveFit`, `shapeGeometry`,
// `polygonBoolean`) line for line: Doubles in the TS order of operations, `JS` for every
// `Math.*` call, stable sorts and insertion-ordered maps where the TS iterates a `Map`.

/// A point (`Point` in the TS core: `readonly [x, y]`). `p[0]` / `p[1]` read as in the TS.
public typealias PathPoint = SIMD2<Double>

/// Inside the module the TS name reads better (and shadows MacTypes' QuickDraw `Point`).
typealias Point = PathPoint

/// Axis-aligned bounds.
public struct PathBounds: Equatable, Sendable {
    public var minX: Double
    public var minY: Double
    public var maxX: Double
    public var maxY: Double
    public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }
}

/// SVG fill rule.
public enum PolygonFillRule: String, Sendable {
    case nonzero, evenodd
}

/// One absolute path command: `parseSvgPath`'s `PathCommand` and the path operations'
/// `BezierCommand` (the same cases without `A`).
public enum PathCommand: Equatable, Sendable {
    case M(x: Double, y: Double)
    case L(x: Double, y: Double)
    case Q(x1: Double, y1: Double, x: Double, y: Double)
    case C(x1: Double, y1: Double, x2: Double, y2: Double, x: Double, y: Double)
    case A(rx: Double, ry: Double, rotation: Double, largeArc: Bool, sweep: Bool, x: Double, y: Double)
    case Z

    /// The command letter (`type` in the TS).
    public var type: String {
        switch self {
        case .M: "M"
        case .L: "L"
        case .Q: "Q"
        case .C: "C"
        case .A: "A"
        case .Z: "Z"
        }
    }
}

/// `BezierCommand`: a `PathCommand` other than `A`.
public typealias BezierCommand = PathCommand
/// A path as absolute `M` / `L` / `Q` / `C` / `Z` commands.
public typealias BezierPath = [PathCommand]
/// One segment as its control points (2, 3 or 4).
public typealias BezierSegment = [PathPoint]

/// `BezierPathInput`: SVG path data or parsed commands.
public enum BezierPathInput: Sendable, ExpressibleByStringLiteral, ExpressibleByArrayLiteral {
    case svg(String)
    case commands([PathCommand])

    public init(stringLiteral value: String) { self = .svg(value) }
    public init(arrayLiteral elements: PathCommand...) { self = .commands(elements) }
}

/// A subpath as a chain of segments.
public struct BezierContour: Equatable, Sendable {
    public var segments: [BezierSegment]
    public var closed: Bool
    public init(segments: [BezierSegment], closed: Bool) {
        self.segments = segments
        self.closed = closed
    }
}

// MARK: - JavaScript semantics

/// `Math.max(...)`: NaN when any argument is NaN, +0 over -0.
@inline(__always) func jmax(_ a: Double, _ b: Double) -> Double { JS.max(a, b) }
@inline(__always) func jmax(_ a: Double, _ b: Double, _ c: Double) -> Double { JS.max(JS.max(a, b), c) }
@inline(__always) func jmax(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Double { JS.max(JS.max(JS.max(a, b), c), d) }
/// `Math.min(...)`.
@inline(__always) func jmin(_ a: Double, _ b: Double) -> Double { JS.min(a, b) }
@inline(__always) func jmin(_ a: Double, _ b: Double, _ c: Double) -> Double { JS.min(JS.min(a, b), c) }
@inline(__always) func jmin(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Double { JS.min(JS.min(JS.min(a, b), c), d) }
func jmin(_ xs: [Double]) -> Double { xs.reduce(Double.infinity) { JS.min($0, $1) } }
func jmax(_ xs: [Double]) -> Double { xs.reduce(-Double.infinity) { JS.max($0, $1) } }

/// `Math.hypot(a, b)` (V8's).
@inline(__always) func hypot(_ a: Double, _ b: Double) -> Double { JS.hypot(a, b) }

/// `Math.PI`.
let PI = Double.pi

/// `Math.tan`: Foundation's (V8's fdlibm `tan` is not ported; trig results are compared within
/// the conformance tolerance anyway).
@inline(__always) func jtan(_ x: Double) -> Double { Foundation.tan(x) }
/// `Math.acos`: Foundation's (see `jtan`).
@inline(__always) func jacos(_ x: Double) -> Double { Foundation.acos(x) }

/// `String(n)` for a number.
@inline(__always) func jsString(_ n: Double) -> String { n.isNaN ? "NaN" : n.isInfinite ? (n > 0 ? "Infinity" : "-Infinity") : JSONValue.jsNumber(n) }

/// `Array.prototype.sort` with a comparator: stable (V8's TimSort keeps equal elements in
/// order), and an element moves before another only when `compare` is positive.
public func jsSorted<T>(_ items: [T], _ compare: (T, T) -> Double) -> [T] {
    if items.count < 2 { return items }
    var a = items
    var b = items
    var width = 1
    let n = a.count
    while width < n {
        var lo = 0
        while lo < n {
            let mid = Swift.min(lo + width, n)
            let hi = Swift.min(lo + 2 * width, n)
            var i = lo, j = mid, k = lo
            while i < mid && j < hi {
                if compare(a[i], a[j]) > 0 {
                    b[k] = a[j]; j += 1
                } else {
                    b[k] = a[i]; i += 1
                }
                k += 1
            }
            while i < mid { b[k] = a[i]; i += 1; k += 1 }
            while j < hi { b[k] = a[j]; j += 1; k += 1 }
            lo = hi
        }
        swap(&a, &b)
        width *= 2
    }
    return a
}

extension Array {
    /// In-place `jsSorted`.
    mutating func jsSort(_ compare: (Element, Element) -> Double) { self = jsSorted(self, compare) }
}

/// A JavaScript `Map`: iterates in insertion order.
struct OrderedMap<Key: Hashable, Value> {
    private(set) var keys: [Key] = []
    private var storage: [Key: Value] = [:]

    init() {}

    var count: Int { keys.count }

    subscript(key: Key) -> Value? {
        get { storage[key] }
        set {
            if let v = newValue {
                if storage.updateValue(v, forKey: key) == nil { keys.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    func has(_ key: Key) -> Bool { storage[key] != nil }

    /// Mutates a stored value in place (it must exist).
    mutating func modify(_ key: Key, _ body: (inout Value) -> Void) {
        body(&storage[key]!)
    }

    var values: [Value] { keys.map { storage[$0]! } }
    var entries: [(key: Key, value: Value)] { keys.map { ($0, storage[$0]!) } }
}

/// Reference identity for class instances used as `Map` / `Set` keys in the TS.
struct Ident<T: AnyObject>: Hashable {
    let object: T
    init(_ object: T) { self.object = object }
    static func == (a: Ident, b: Ident) -> Bool { a.object === b.object }
    func hash(into h: inout Hasher) { h.combine(ObjectIdentifier(object)) }
}
