import Foundation

// The Pathfinder panel's dividing operations over a stack of shapes (`canvas/pathops/pathfinder.ts`):
// Divide, Trim, Merge, Crop, Outline and Minus Back. The filled areas come from one arrangement of
// all shapes (`dividePaths`, `pathBooleanSelect`); Outline and Divide with cutting lines use the
// planar map (`PlanarMap`). Every result carries the index of the shape whose paint it keeps.

/// A Pathfinder dividing operation.
public enum PathfinderOperation: String, CaseIterable, Sendable {
    case divide, trim, merge, crop, outline, minusBack
}

public let PATHFINDER_OPERATIONS: [PathfinderOperation] = [.divide, .trim, .merge, .crop, .outline, .minusBack]

/// A shape's paint key (`string | number` in the TS).
public enum PathfinderKey: Sendable {
    case string(String)
    case number(Double)

    /// `===`.
    static func strictEquals(_ a: PathfinderKey, _ b: PathfinderKey) -> Bool {
        switch (a, b) {
        case let (.string(x), .string(y)): x == y
        case let (.number(x), .number(y)): x == y
        default: false
        }
    }

    /// `Array.prototype.includes` (SameValueZero: NaN matches NaN).
    static func sameValueZero(_ a: PathfinderKey, _ b: PathfinderKey) -> Bool {
        if case let .number(x) = a, case let .number(y) = b, x.isNaN && y.isNaN { return true }
        return strictEquals(a, b)
    }
}

/// A shape of the stack.
public struct PathfinderShape: Sendable {
    /// Its outline; open subpaths are closed for filling (unless `line`).
    public var path: BezierPathInput
    public var fillRule: PolygonFillRule?
    /// Identifies its paint: Merge joins touching areas whose shapes share a key (default: the index).
    public var key: PathfinderKey?
    /// An unfilled open path: a cutting edge for Divide, splitting the faces it crosses without
    /// becoming one (ignored by the other operations).
    public var line: Bool?
    public init(path: BezierPathInput, fillRule: PolygonFillRule? = nil, key: PathfinderKey? = nil, line: Bool? = nil) {
        self.path = path
        self.fillRule = fillRule
        self.key = key
        self.line = line
    }
}

/// One result: a filled area (or an open stroke for Outline).
public struct PathfinderPiece: Sendable {
    public var path: BezierPath
    /// Index of the shape whose paint it keeps.
    public var source: Int
    /// Outline edges are open paths (a loop with no junction on it stays closed); `nil` for the
    /// other operations.
    public var open: Bool?
}

public struct PathfinderResult: Sendable {
    public var pieces: [PathfinderPiece]
    public var report: PathOpsReport
}

@inline(__always) private func top(_ covering: [Int]) -> Int { covering[covering.count - 1] }

/// `report`: the engine, and the fallback reason and error when they are non-empty.
private func report(_ r: PathOpsReport) -> PathOpsReport {
    PathOpsReport(
        engine: r.engine,
        fallbackReason: r.fallbackReason?.isEmpty == false ? r.fallbackReason : nil,
        error: r.error?.isEmpty == false ? r.error : nil
    )
}

/// The path with every subpath closed (as it fills).
private func closeAll(_ path: BezierPathInput) -> BezierPath {
    contoursToPath(pathToContours(path).map { BezierContour(segments: $0.segments, closed: true) })
}

/// Runs a Pathfinder operation:
/// - `divide`: every face of the arrangement becomes its own piece, painted like the top-most
///   shape covering it. `line` shapes cut the faces they cross.
/// - `trim`: hidden parts are removed; one piece per shape that stays visible, nothing merged.
/// - `merge`: like Trim, then touching or overlapping visible parts of shapes with the same key
///   become one piece (one per connected area).
/// - `crop`: the top shape crops the others; it is removed, the visible parts below inside it stay.
/// - `outline`: every outline is cut where it meets another; the pieces are open paths painted
///   like the shape they bound (the top-most where outlines coincide).
/// - `minusBack`: the top shape minus everything behind it.
/// Throws a `PathOpsError` only when the curve engine fails with `fallback: false`.
public func pathfinder(_ op: PathfinderOperation, _ shapes: [PathfinderShape], _ options: PathOpsOptions = .init()) throws -> PathfinderResult {
    let n = shapes.count
    if n == 0 { return PathfinderResult(pieces: [], report: .init(engine: .curve)) }
    let filled = shapes.filter { $0.line != true }
    let operands = shapes.map { PathOperand($0.path, fillRule: $0.fillRule ?? .nonzero) }

    if op == .outline {
        let map = PlanarMap.build(
            shapes.map { PlanarInput(path: $0.line == true ? $0.path : .commands(closeAll($0.path)), fills: false) },
            PlanarMapOptions(options)
        )
        guard let map else { return PathfinderResult(pieces: [], report: .init(engine: .curve, error: "could not map the outlines")) }
        let pieces = map.chains().map { c in
            PathfinderPiece(path: contoursToPath([BezierContour(segments: c.segments, closed: c.closed)]), source: c.source, open: !c.closed)
        }
        return PathfinderResult(pieces: pieces, report: .init(engine: .curve))
    }

    if op == .divide {
        if filled.count != n {
            let map = PlanarMap.build(
                shapes.map { PlanarInput(path: $0.line == true ? $0.path : .commands(closeAll($0.path)), fillRule: $0.fillRule, fills: $0.line != true) },
                PlanarMapOptions(options)
            )
            guard let map else { return PathfinderResult(pieces: [], report: .init(engine: .curve, error: "could not map the shapes")) }
            var pieces: [PathfinderPiece] = []
            for (i, face) in map.faces.enumerated() {
                let covering = map.faceSources(i)
                if !covering.isEmpty { pieces.append(PathfinderPiece(path: face.path, source: top(covering))) }
            }
            return PathfinderResult(pieces: pieces, report: .init(engine: .curve))
        }
        let result = try dividePaths(operands, options)
        return PathfinderResult(pieces: result.pieces.map { PathfinderPiece(path: $0.path, source: top($0.operands)) }, report: report(result.report))
    }

    // The filled-area operations ignore cutting lines.
    let index = shapes.indices.filter { shapes[$0].line != true }
    let m = index.count
    if m == 0 { return PathfinderResult(pieces: [], report: .init(engine: .curve)) }
    let ops = index.map { operands[$0] }
    func key(_ k: Int) -> PathfinderKey { shapes[index[k]].key ?? .number(Double(index[k])) }
    func select(_ selectors: [([Int]) -> Bool]) throws -> PathSelectResult { try pathBooleanSelect(ops, selectors, options) }
    func joined(_ parts: [BezierPath]) -> BezierPath { parts.flatMap { $0 } }

    switch op {
    case .trim:
        let result = try select(index.indices.map { k in { c in !c.isEmpty && top(c) == k } })
        var pieces: [PathfinderPiece] = []
        for (k, parts) in result.parts.enumerated() where !parts.isEmpty { pieces.append(PathfinderPiece(path: joined(parts), source: index[k])) }
        return PathfinderResult(pieces: pieces, report: report(result.report))
    case .merge:
        var keys: [PathfinderKey] = []
        for k in 0..<m where !keys.contains(where: { PathfinderKey.sameValueZero($0, key(k)) }) { keys.append(key(k)) }
        let result = try select(keys.map { kk in { c in !c.isEmpty && PathfinderKey.strictEquals(key(top(c)), kk) } })
        var pieces: [PathfinderPiece] = []
        for (j, parts) in result.parts.enumerated() {
            // Painted like the front-most shape with that key.
            var source = 0
            for k in 0..<m where PathfinderKey.strictEquals(key(k), keys[j]) { source = index[k] }
            for part in parts { pieces.append(PathfinderPiece(path: part, source: source)) }
        }
        return PathfinderResult(pieces: pieces, report: report(result.report))
    case .crop:
        if m < 2 { return PathfinderResult(pieces: [], report: .init(engine: .curve)) }
        let front = m - 1
        let result = try select((0..<front).map { k in { c in c.count >= 2 && top(c) == front && c[c.count - 2] == k } })
        var pieces: [PathfinderPiece] = []
        for (k, parts) in result.parts.enumerated() where !parts.isEmpty { pieces.append(PathfinderPiece(path: joined(parts), source: index[k])) }
        return PathfinderResult(pieces: pieces, report: report(result.report))
    case .minusBack:
        let front = m - 1
        let result = try select([{ c in c.count == 1 && c[0] == front }])
        let parts = result.parts[0]
        return PathfinderResult(pieces: parts.isEmpty ? [] : [PathfinderPiece(path: joined(parts), source: index[front])], report: report(result.report))
    case .divide, .outline:
        return PathfinderResult(pieces: [], report: .init(engine: .curve))
    }
}
