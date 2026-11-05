import Foundation
import PixerateRaster

// Planar maps (`canvas/pathops/planar.ts`): the faces and edges a set of paths divides the
// plane into (Shape Builder, fill regions, Pathfinder Outline). Every path is an edge, open
// ones included; `planarSplit` cuts them, half-edges are sorted round each vertex by the
// direction they leave a small circle in, and a face walk takes the sharpest left turn.

// MARK: - Public types

/// One input of a planar map.
public struct PlanarInput: Sendable {
    /// Its subpaths: closed ones bound faces and the area the input fills, open ones are edges only.
    public var path: BezierPathInput
    /// How its closed subpaths fill (default `nonzero`).
    public var fillRule: PolygonFillRule?
    /// Whether its closed subpaths count as filling the faces inside them (default true).
    public var fills: Bool?
    public init(path: BezierPathInput, fillRule: PolygonFillRule? = nil, fills: Bool? = nil) {
        self.path = path
        self.fillRule = fillRule
        self.fills = fills
    }
}

/// `PlanarMapOptions`: `PathOpsOptions` plus the planar map's own settings.
public struct PlanarMapOptions {
    /// The path-operation options (`extends PathOpsOptions` in the TS).
    public var pathOps: PathOpsOptions
    /// Close gaps up to this distance between loose ends (vertices with one edge): each one joins
    /// the nearest other loose end within reach by a straight edge (default 0, off).
    public var gap: Double?
    /// Most input segments mapped (default 4096); a bigger input gives no map.
    public var maxSegments: Double?
    public init(_ pathOps: PathOpsOptions = .init(), gap: Double? = nil, maxSegments: Double? = nil) {
        self.pathOps = pathOps
        self.gap = gap
        self.maxSegments = maxSegments
    }
}

/// A bounded face: an outer outline with the holes other pieces of the map make in it.
public struct PlanarFace: Sendable {
    /// Outer subpath (counter-clockwise in a y-up frame) followed by its holes (clockwise).
    public var path: BezierPath
    /// Area (holes taken out).
    public var area: Double
    public var bounds: PathBounds
}

/// A run of edges between junctions (vertices where paths meet or a path ends).
public struct PlanarChain: Sendable {
    public var segments: [BezierSegment]
    /// A loop with no junction on it.
    public var closed: Bool
    /// The input it lies on: the front-most (highest index) where several coincide.
    public var source: Int
}

// MARK: - Helpers

/// A `PlanarSplitEdge` with its front-most input (-1: an edge closing a gap).
private struct Edge {
    var a: Int
    var b: Int
    var pts: [PathPoint]
    var operands: [Int]
    var src: Int
    var sa: Double
    var sb: Double
    var source: Int
}

private struct Cycle {
    var halves: [Int]
    var segments: [BezierSegment]
    var area: Double
    var bounds: PathBounds
}

private struct Cycles {
    var faces: [Cycle]
    var holes: [Cycle]
    var faceHoles: [[Int]]
    var faceOf: [Int]
}

private struct Fill {
    var chains: [[BezierSegment]]
    var fillRule: PolygonFillRule
    var bounds: PathBounds
}

@inline(__always) private func twin(_ h: Int) -> Int { h ^ 1 }

private func boundsOf(_ segs: [BezierSegment]) -> PathBounds {
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for s in segs {
        for p in s {
            let x = p[0], y = p[1]
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
    return PathBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

@inline(__always) private func inBounds(_ b: PathBounds, _ p: PathPoint) -> Bool {
    p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY
}

/// `cycle` without the spurs it runs out and back along (a line's loose end).
private func withoutSpurs(_ cycle: [Int]) -> [Int] {
    var out: [Int] = []
    for h in cycle {
        if !out.isEmpty && out[out.count - 1] == twin(h) { out.removeLast() } else { out.append(h) }
    }
    while out.count >= 2 && twin(out[0]) == out[out.count - 1] {
        out.removeLast()
        out.removeFirst()
    }
    return out
}

/// Moves the end points of a segment onto `a` and `b`, the handles next to them moving along.
private func pinEnds(_ pts: [PathPoint], _ a: PathPoint, _ b: PathPoint) -> [PathPoint] {
    let n = pts.count
    if n == 2 { return [a, b] }
    var out = pts
    let d0 = Point(a[0] - pts[0][0], a[1] - pts[0][1])
    let d1 = Point(b[0] - pts[n - 1][0], b[1] - pts[n - 1][1])
    out[0] = a
    out[n - 1] = b
    if n == 3 {
        out[1] = Point(pts[1][0] + (d0[0] + d1[0]) / 2, pts[1][1] + (d0[1] + d1[1]) / 2)
    } else {
        out[1] = Point(pts[1][0] + d0[0], pts[1][1] + d0[1])
        out[2] = Point(pts[2][0] + d1[0], pts[2][1] + d1[1])
    }
    return out
}

// MARK: - Interior point

/// A point strictly inside a filled path (nonzero), well away from its edges where it can be:
/// the middle of the widest span of a few horizontal lines through it. `nil` for an empty path.
public func interiorPoint(_ path: BezierPathInput) -> PathPoint? {
    interiorPointOf(pathToContours(path).map { closeContour($0, true) })
}

/// `interiorPoint` of closed segment chains.
public func interiorPoint(_ chains: [[BezierSegment]]) -> PathPoint? {
    // The TS tells chains from commands by `path[0][0][0]` being an array: chains whose first
    // one is empty are read as a command list, which gives an empty path.
    if !chains.isEmpty && chains[0].isEmpty { return nil }
    return interiorPointOf(chains)
}

private let INTERIOR_FRACTIONS: [Double] = [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 0.0625, 0.9375]

private func interiorPointOf(_ chains: [[BezierSegment]]) -> PathPoint? {
    let b = boundsOf(chains.flatMap { $0 })
    if !(b.maxX > b.minX) || !(b.maxY > b.minY) { return nil }
    let tol = jmax(b.maxX - b.minX, b.maxY - b.minY) * 1e-3
    let rings = chains.filter { !$0.isEmpty }.map { flattenChain($0, tol) }
    var best: (width: Double, p: PathPoint)?
    for f in INTERIOR_FRACTIONS {
        // A little off round fractions, which on art drawn to a grid fall on the height of a corner.
        let y = b.minY + (b.maxY - b.minY) * (f + 0.0061803)
        var xs: [Double] = []
        for ring in rings {
            for i in 0..<ring.count {
                let a = ring[i]
                let c = ring[(i + 1) % ring.count]
                if (a[1] <= y) != (c[1] <= y) { xs.append(a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0])) }
            }
        }
        xs.jsSort { p, q in p - q }
        var i = 0
        while i + 1 < xs.count {
            let width = xs[i + 1] - xs[i]
            if width > (best?.width ?? 0) {
                let m = Point((xs[i] + xs[i + 1]) / 2, y)
                if windingNumber(chains, m) != 0 { best = (width, m) }
            }
            i += 1
        }
    }
    return best?.p
}

// MARK: - Planar map

/// The planar map of a set of paths. Build it with `PlanarMap.build`; faces, chains and fills
/// are computed on first use.
public final class PlanarMap {
    public let vertices: [PathPoint]
    private var edges: [Edge]
    private let sources: [BezierSegment]
    public let eps: Double
    public let inputCount: Int
    private var around: [[Int]] = []
    private var slot: [Int] = []
    private var component: [Int] = []
    private var cyclesCache: Cycles?
    private var sourcesCache: [[Int]?] = []
    private let fills: [Fill]

    private init(_ vertices: [PathPoint], _ edges: [Edge], _ sources: [BezierSegment], _ eps: Double, _ inputCount: Int, _ inputs: [PlanarInput]) {
        self.vertices = vertices
        self.edges = edges
        self.sources = sources
        self.eps = eps
        self.inputCount = inputCount
        fills = inputs.map { input in
            let chains = input.fills == false
                ? []
                : pathToContours(input.path).filter { $0.closed }.map { closeContour($0) }
            return Fill(chains: chains, fillRule: input.fillRule ?? .nonzero, bounds: boundsOf(chains.flatMap { $0 }))
        }
        let nv = vertices.count
        var around = [[Int]](repeating: [], count: nv)
        for h in 0..<(edges.count * 2) { around[origin(h)].append(h) }
        slot = [Int](repeating: 0, count: edges.count * 2)
        for v in 0..<nv {
            let list = around[v]
            if list.isEmpty { continue }
            let at = vertices[v]
            // Half the shortest chord here: every edge gets that far from the vertex.
            var r = Double.infinity
            for h in list { r = jmin(r, dist(at, vertices[origin(twin(h))])) }
            r *= 0.5
            let keyed = jsSorted(list.map { h in (h: h, angle: leavingAngle(h, at, r)) }) { a, b in a.angle - b.angle }
            around[v] = keyed.map(\.h)
            for (k, entry) in keyed.enumerated() { slot[entry.h] = k }
        }
        self.around = around
        // Connected pieces (union-find over the edges).
        var parent = Array(0..<nv)
        func find(_ vIn: Int) -> Int {
            var v = vIn
            while parent[v] != v {
                parent[v] = parent[parent[v]]
                v = parent[v]
            }
            return v
        }
        for e in edges {
            let ra = find(e.a)
            let rb = find(e.b)
            parent[ra] = rb
        }
        component = (0..<nv).map { find($0) }
    }

    /// Maps `inputs` (their subpaths as given: open ones stay open). `nil` when they cannot be
    /// mapped (non-finite points, more than `maxSegments` segments or an intersection search
    /// that does not settle) or have no edges.
    public static func build(_ inputs: [PlanarInput], _ options: PlanarMapOptions = .init()) -> PlanarMap? {
        let chains = inputs.map { input in pathToContours(input.path).map { closeContour($0) }.filter { !$0.isEmpty } }
        var count = 0.0
        for cs in chains {
            var m = 0.0
            for c in cs { m += Double(c.count) }
            count += m
        }
        if count == 0 || count > (options.maxSegments ?? 4096) { return nil }
        let split: PlanarSplitResult
        do {
            split = try planarSplit(chains, options.pathOps)
        } catch {
            return nil
        }
        var edges = split.edges.filter { $0.a != $0.b }.map { e in
            Edge(a: e.a, b: e.b, pts: e.pts, operands: e.operands, src: e.src, sa: e.sa, sb: e.sb, source: e.operands.last ?? -1)
        }
        if edges.isEmpty { return nil }
        let gap = options.gap ?? 0
        if gap > split.eps { closeGaps(split.vertices, &edges, gap) }
        return PlanarMap(split.vertices, edges, split.sources, split.eps, inputs.count, inputs)
    }

    // MARK: Half-edges

    private func origin(_ h: Int) -> Int {
        let e = edges[h >> 1]
        return h & 1 != 0 ? e.b : e.a
    }

    private func halfPts(_ h: Int) -> [PathPoint] {
        let pts = edges[h >> 1].pts
        return h & 1 != 0 ? pts.reversed() : pts
    }

    /// The half-edge after `h` on the face to its left: the sharpest left turn at its end.
    private func next(_ h: Int) -> Int {
        let back = twin(h)
        let list = around[origin(back)]
        return list[(slot[back] + list.count - 1) % list.count]
    }

    /// Direction (angle) in which half-edge `h`, leaving `at`, first gets `r` away from it.
    private func leavingAngle(_ h: Int, _ at: PathPoint, _ r: Double) -> Double {
        let pts = halfPts(h)
        func d(_ t: Double) -> Double { dist(segmentPoint(pts, t), at) }
        var lo = 0.0
        var hi = 1.0
        let steps = pts.count == 2 ? 1 : 16
        for k in stride(from: 1, through: steps, by: 1) {
            let t = Double(k) / Double(steps)
            if d(t) >= r {
                hi = t
                break
            }
            lo = t
        }
        var i = 0
        while i < 40 && hi - lo > 1e-12 {
            let m = (lo + hi) / 2
            if d(m) >= r { hi = m } else { lo = m }
            i += 1
        }
        let p = segmentPoint(pts, hi)
        if dist(p, at) > 0 { return JS.atan2(p[1] - at[1], p[0] - at[0]) }
        let t = segmentTangent(pts, 0)
        return JS.atan2(t[1], t[0])
    }

    private struct Run {
        var h: Int
        var src: Int
        var from: Double
        var to: Double
    }

    /// Segments of a run of half-edges (a loop unless `closed` is false), pieces of one input
    /// segment joined again.
    private func cycleSegments(_ halves: [Int], _ closed: Bool = true) -> [BezierSegment] {
        let runs = halves.map { h -> Run in
            let e = edges[h >> 1]
            return Run(h: h, src: e.source < 0 ? -1 : e.src, from: h & 1 != 0 ? e.sb : e.sa, to: h & 1 != 0 ? e.sa : e.sb)
        }
        func joins(_ a: Run, _ b: Run) -> Bool {
            a.src >= 0 && a.src == b.src && abs(a.to - b.from) < 1e-9 && (a.to - a.from > 0) == (b.to - b.from > 0)
        }
        let n = runs.count
        var start = 0
        if closed {
            for k in 0..<n where !joins(runs[(k + n - 1) % n], runs[k]) {
                start = k
                break
            }
        }
        let ordered = Array(runs[start...]) + Array(runs[..<start])
        var out: [BezierSegment] = []
        var i = 0
        while i < ordered.count {
            var j = i + 1
            while j < ordered.count && joins(ordered[j - 1], ordered[j]) { j += 1 }
            let first = ordered[i]
            let last = ordered[j - 1]
            if j - i == 1 {
                out.append(halfPts(first.h))
            } else {
                let a = vertices[origin(first.h)]
                let b = vertices[origin(twin(last.h))]
                let seg = sources[first.src]
                out.append(seg.count == 2 ? [a, b] : pinEnds(subSegment(seg, first.from, last.to), a, b))
            }
            i = j
        }
        return out
    }

    private func cycles() -> Cycles {
        if let cached = cyclesCache { return cached }
        let halves = edges.count * 2
        var seen = [Bool](repeating: false, count: halves)
        var faces: [Cycle] = []
        var holes: [Cycle] = []
        let sliver = eps * 10
        for start in 0..<halves {
            if seen[start] { continue }
            var walk: [Int] = []
            var h = start
            while !seen[h] {
                seen[h] = true
                walk.append(h)
                h = next(h)
            }
            let cycle = withoutSpurs(walk)
            if cycle.isEmpty { continue }
            let segments = cycleSegments(cycle)
            let area = contourSignedArea(segments)
            var perimeter = 0.0
            for s in segments { perimeter += s.count == 2 ? dist(s[0], s[1]) : segmentLength(s, 0, 1, 1e-6) }
            if !(perimeter > 0) { continue }
            let entry = Cycle(halves: cycle, segments: segments, area: area, bounds: boundsOf(segments))
            if area > 0 && (2 * area) / perimeter >= sliver {
                faces.append(entry)
            } else if area < 0 && (-2 * area) / perimeter >= sliver {
                holes.append(entry)
            }
        }
        // Each outer boundary is a hole in the smallest face of another piece around it.
        var faceHoles = [[Int]](repeating: [], count: faces.count)
        for (k, hole) in holes.enumerated() {
            let v = origin(hole.halves[0])
            let p = vertices[v]
            let own = component[v]
            var best = -1
            for (i, face) in faces.enumerated() {
                if component[origin(face.halves[0])] == own || !inBounds(face.bounds, p) { continue }
                if best >= 0 && faces[best].area <= face.area { continue }
                if windingNumber([face.segments], p) != 0 { best = i }
            }
            if best >= 0 { faceHoles[best].append(k) }
        }
        var faceOf = [Int](repeating: -1, count: halves)
        for (i, face) in faces.enumerated() {
            for h in face.halves { faceOf[h] = i }
            for k in faceHoles[i] { for h in holes[k].halves { faceOf[h] = i } }
        }
        let result = Cycles(faces: faces, holes: holes, faceHoles: faceHoles, faceOf: faceOf)
        cyclesCache = result
        sourcesCache = faces.map { _ in nil }
        return result
    }

    private func faceChains(_ i: Int) -> [[BezierSegment]] {
        let c = cycles()
        return [c.faces[i].segments] + c.faceHoles[i].map { c.holes[$0].segments }
    }

    /// The bounded faces of the map.
    public var faces: [PlanarFace] {
        let c = cycles()
        return c.faces.enumerated().map { i, f in
            let chains = faceChains(i)
            var holeSum = 0.0
            for k in c.faceHoles[i] { holeSum = holeSum + c.holes[k].area }
            let area = f.area + holeSum
            return PlanarFace(path: contoursToPath(chains.map { BezierContour(segments: $0, closed: true) }), area: area, bounds: f.bounds)
        }
    }

    /// The inputs whose fill covers face `i`, ascending (empty for an area only outlines enclose).
    public func faceSources(_ i: Int) -> [Int] {
        _ = cycles()
        if let cached = sourcesCache[i] { return cached }
        let p = interiorPoint(faceChains(i))
        var out: [Int] = []
        if let p {
            for (k, fill) in fills.enumerated() {
                if fill.chains.isEmpty || !inBounds(fill.bounds, p) { continue }
                let w = windingNumber(fill.chains, p)
                if fill.fillRule == .evenodd ? (w & 1) == 1 : w != 0 { out.append(k) }
            }
        }
        sourcesCache[i] = out
        return out
    }

    /// A point well inside face `i`.
    public func faceInterior(_ i: Int) -> PathPoint? {
        interiorPoint(faceChains(i))
    }

    /// The face under `p` (the smallest one around it), or -1.
    public func faceAt(_ p: PathPoint) -> Int {
        let faces = cycles().faces
        var best = -1
        for (i, face) in faces.enumerated() {
            if !inBounds(face.bounds, p) || (best >= 0 && faces[best].area <= face.area) { continue }
            if windingNumber(faceChains(i), p) != 0 { best = i }
        }
        return best
    }

    /// The union of faces, traced along the map's own edges: those between two merged faces drop
    /// out exactly, so no seam or sliver is left. Outer subpaths come out counter-clockwise
    /// (y-up), holes clockwise.
    public func merge(_ faceIndices: [Int]) -> BezierPath {
        let faceOf = cycles().faceOf
        let picked = Set(faceIndices)
        func merged(_ h: Int) -> Bool { faceOf[h] >= 0 && picked.contains(faceOf[h]) }
        func boundary(_ h: Int) -> Bool { merged(h) && !merged(twin(h)) }
        var used = [Bool](repeating: false, count: edges.count * 2)
        var contours: [BezierContour] = []
        for start in 0..<used.count {
            if used[start] || !boundary(start) { continue }
            var cycle: [Int] = []
            var h = start
            var ok = true
            while !used[h] {
                used[h] = true
                cycle.append(h)
                // Turn from the way back as a face walk does, past edges inside the merged faces.
                let back = twin(h)
                let list = around[origin(back)]
                let k = slot[back]
                let n = list.count
                var found = -1
                for j in stride(from: 1, through: n, by: 1) {
                    let g = list[(k - j + n * 2) % n]
                    if boundary(g) {
                        found = g
                        break
                    }
                }
                if found < 0 {
                    ok = false
                    break
                }
                h = found
            }
            if !ok || h != start { continue }
            contours.append(BezierContour(segments: cycleSegments(cycle), closed: true))
        }
        return contoursToPath(contours)
    }

    /// The edges joined into runs between junctions: vertices where other than two edges meet, or
    /// where the two edges lie on different inputs. Each run is keyed by its input.
    public func chains() -> [PlanarChain] {
        func passes(_ v: Int) -> (Int, Int)? {
            let list = around[v]
            if list.count != 2 { return nil }
            return edges[list[0] >> 1].source == edges[list[1] >> 1].source ? (list[0], list[1]) : nil
        }
        var used = [Bool](repeating: false, count: edges.count)
        var out: [PlanarChain] = []
        func walk(_ h0: Int) {
            let source = edges[h0 >> 1].source
            var halves: [Int] = []
            var h = h0
            var closed = false
            while true {
                if used[h >> 1] {
                    closed = true
                    break
                }
                used[h >> 1] = true
                halves.append(h)
                let v = origin(twin(h))
                guard let pass = passes(v) else {
                    closed = v == origin(h0)
                    break
                }
                h = pass.0 == twin(h) ? pass.1 : pass.0
            }
            if source < 0 { return }
            let segments = cycleSegments(halves, closed)
            out.append(PlanarChain(segments: segments, closed: closed, source: source))
        }
        for v in around.indices {
            if passes(v) != nil { continue }
            for h in around[v] where !used[h >> 1] { walk(h) }
        }
        for e in 0..<edges.count where !used[e] { walk(e * 2) }
        return out
    }

    // MARK: Fill regions (cadcraft `boundary_at_gap`)

    /// The region enclosing `p`: a ray from `p` towards +x meets the edges in order; for each,
    /// the half-edge with `p` on its left is followed by always taking the sharpest left turn,
    /// until a loop that runs counter-clockwise round `p` comes back. The pieces of the map
    /// nested inside that loop become its holes. `nil` when nothing encloses `p`.
    public func regionAt(_ p: PathPoint) -> BezierPath? {
        let c = cycles()
        var hits: [(x: Double, e: Int)] = []
        for (i, e) in edges.enumerated() {
            let ay = vertices[e.a][1]
            let by = vertices[e.b][1]
            if (ay > p[1]) == (by > p[1]) { continue }
            // Edges are monotone pieces, so the ray crosses each at most once.
            let t = solveMonotone(e.pts, 1, p[1])
            let x = segmentPoint(e.pts, t)[0]
            if x > p[0] { hits.append((x, i)) }
        }
        hits.jsSort { a, b in a.x - b.x }
        for (_, e) in hits.prefix(64) {
            let ay = vertices[edges[e].a][1]
            let by = vertices[edges[e].b][1]
            // `p` lies west of the edge, the left side (y-up) of the half-edge running towards +y.
            let h = by > ay ? e * 2 : e * 2 + 1
            var walk: [Int] = []
            var seen = Set<Int>()
            var g = h
            while !seen.contains(g) {
                seen.insert(g)
                walk.append(g)
                g = next(g)
            }
            if g != h { continue }
            let cycle = withoutSpurs(walk)
            if cycle.isEmpty { continue }
            let segments = cycleSegments(cycle)
            if !(contourSignedArea(segments) > 0) || windingNumber([segments], p) == 0 { continue }
            // The loop is one of the map's faces: take its holes.
            let face = c.faceOf[cycle[0]]
            if face >= 0 && c.faces[face].halves.contains(cycle[0]) {
                return contoursToPath(faceChains(face).map { BezierContour(segments: $0, closed: true) })
            }
            return contoursToPath([BezierContour(segments: segments, closed: true)])
        }
        return nil
    }
}

/// Joins loose ends (degree-one vertices) to the nearest other loose end within `gap`.
private func closeGaps(_ vertices: [PathPoint], _ edges: inout [Edge], _ gap: Double) {
    var degree = [Int](repeating: 0, count: vertices.count)
    var linked = Set<SIMD2<Int>>()
    for e in edges {
        degree[e.a] += 1
        degree[e.b] += 1
        linked.insert(SIMD2(Swift.min(e.a, e.b), Swift.max(e.a, e.b)))
    }
    let ends = jsSorted(degree.indices.filter { degree[$0] == 1 }) { a, b in vertices[a][0] - vertices[b][0] }
    var joined = Set<Int>()
    var lo = 0
    for i in 0..<ends.count {
        let u = ends[i]
        if joined.contains(u) { continue }
        let pu = vertices[u]
        while lo < ends.count && vertices[ends[lo]][0] < pu[0] - gap { lo += 1 }
        var best = -1
        var bestD = Double.infinity
        var j = lo
        while j < ends.count {
            let v = ends[j]
            let pv = vertices[v]
            if pv[0] > pu[0] + gap { break }
            j += 1
            if v == u || joined.contains(v) || linked.contains(SIMD2(Swift.min(u, v), Swift.max(u, v))) { continue }
            let d = dist(pu, pv)
            if d <= gap && d < bestD {
                best = v
                bestD = d
            }
        }
        if best < 0 { continue }
        let a = Swift.min(u, best)
        let b = Swift.max(u, best)
        edges.append(Edge(a: a, b: b, pts: [vertices[a], vertices[b]], operands: [], src: -1, sa: 0, sb: 1, source: -1))
        joined.insert(u)
        joined.insert(best)
    }
}

// MARK: - Cutting edges out of outlines (vectorcraft `cut_out`)

/// Whether a contour, closed, encloses an area (rather than retracing itself).
public func contourEnclosesArea(_ contour: BezierContour) -> Bool {
    let segs = closeContour(contour, true)
    if segs.isEmpty { return false }
    let b = boundsOf(segs)
    let w = b.maxX - b.minX
    let h = b.maxY - b.minY
    return abs(contourSignedArea(segs)) > 1e-9 * (w * w + h * h)
}

/// The point of a chain nearest `p`, as a parameter `segment + t`, with its distance.
private func nearestU(_ segs: [BezierSegment], _ p: PathPoint) -> (u: Double, d: Double)? {
    var best: (u: Double, d: Double)?
    for (k, seg) in segs.enumerated() {
        let n = segmentNearest(seg, p)
        if best == nil || n.distance < best!.d { best = (Double(k) + n.t, n.distance) }
    }
    return best
}

/// The run of a chain from parameter `u0` to `u1` (`u0 < u1`, unrolled past the end of a ring).
private func span(_ segs: [BezierSegment], _ u0: Double, _ u1: Double) -> [BezierSegment] {
    let n = segs.count
    if n == 0 || !u0.isFinite || !u1.isFinite { return [] }
    let nd = Double(n)
    let first = jmax(0, JS.floor(u0))
    let last = jmin(jmax(0, JS.ceil(u1)), first + 2 * nd)
    var out: [BezierSegment] = []
    var k = first
    while k < last {
        let t0 = jmin(1, jmax(0, u0 - k))
        let t1 = jmin(1, jmax(0, u1 - k))
        if t1 - t0 > 1e-12 { out.append(subSegment(segs[Int(k.truncatingRemainder(dividingBy: nd))], t0, t1)) }
        k += 1
    }
    return out
}

/// A run with its end points within `tol` of one of `to` put exactly on it (where the planar map
/// put the junction a piece ends at), the neighbouring handles moving with them.
private func snapEnds(_ segs: [BezierSegment], _ to: [PathPoint], _ tol: Double) -> [BezierSegment] {
    if segs.isEmpty { return segs }
    var out = segs
    func move(_ seg: inout [PathPoint], _ end: Int, _ handle: Int) {
        guard let q = to.first(where: { dist($0, seg[end]) <= tol }) else { return }
        let d = Point(q[0] - seg[end][0], q[1] - seg[end][1])
        seg[end] = q
        if seg.count == 4 { seg[handle] = Point(seg[handle][0] + d[0], seg[handle][1] + d[1]) }
    }
    move(&out[0], 0, 1)
    let li = out.count - 1
    let lastCount = out[li].count
    move(&out[li], lastCount - 1, lastCount - 2)
    return out
}

/// `cutOutPiece` with a chain of `PlanarMap.chains` as the piece.
public func cutOutPiece(_ path: BezierPathInput, _ piece: PlanarChain, _ fillCloses: Bool, _ tol: Double) -> BezierPath? {
    cutOutPiece(path, segments: piece.segments, closed: piece.closed, fillCloses: fillCloses, tol: tol)
}

/// `path` without the piece `segments`, a run along one of its subpaths between two points (a
/// Shape Builder edge from `PlanarMap.chains`): a closed subpath opens there, an open one splits
/// in two (or loses an end), and a piece that runs all the way round (`closed`, or ending where
/// it starts) takes its subpath with it. With `fillCloses`, open subpaths that enclose an area
/// run on round an invisible closing edge. `nil` when the piece does not lie on `path` within
/// `tol`.
public func cutOutPiece(_ path: BezierPathInput, segments segs: [BezierSegment], closed pieceClosed: Bool = false, fillCloses: Bool, tol: Double) -> BezierPath? {
    if segs.isEmpty { return nil }
    // A point well inside the piece: the middle of its longest segment.
    var mid: PathPoint?
    var longest = -1.0
    var perimeter = 0.0
    for seg in segs {
        let len = segmentLength(seg)
        perimeter += len
        if len > longest {
            longest = len
            mid = segmentPoint(seg, 0.5)
        }
    }
    // A speck (where paths touch): there is nothing to cut.
    guard let mid, !(perimeter <= tol) else { return nil }
    let a = segs[0][0]
    let lastSeg = segs[segs.count - 1]
    let b = lastSeg[lastSeg.count - 1]
    let whole = pieceClosed || dist(a, b) <= tol
    let contours = pathToContours(path)
    // Each subpath as the piece may run along it: round its closing edge when it has one.
    var found: (index: Int, ring: [BezierSegment], closed: Bool, um: Double, d: Double)?
    for (index, c) in contours.enumerated() {
        if c.segments.isEmpty { continue }
        let closed = c.closed || (fillCloses && contourEnclosesArea(c))
        let ring = closeContour(c, closed)
        if let n = nearestU(ring, mid), n.d <= tol, found == nil || n.d < found!.d {
            found = (index, ring, closed, n.u, n.d)
        }
    }
    guard let found else { return nil }
    let index = found.index, ring = found.ring, closed = found.closed, um = found.um
    let len = Double(ring.count)
    let real = Double(closeContour(contours[index]).count)
    func at(_ p: PathPoint) -> Double? {
        guard let n = nearestU(ring, p) else { return nil }
        return n.d <= tol ? n.u : nil
    }
    // The parameter spans of the ring that stay (unrolled past the end of a ring).
    var keep: [(Double, Double)] = []
    if !whole {
        guard let ua = at(a), let ub = at(b) else { return nil }
        if closed {
            func fwd(_ from: Double, _ to: Double) -> Double {
                ((to - from).truncatingRemainder(dividingBy: len) + len).truncatingRemainder(dividingBy: len)
            }
            // The piece runs from one end through `mid` to the other; what stays runs on round.
            let (start, end) = fwd(ua, um) <= fwd(ua, ub) ? (ub, ua) : (ua, ub)
            let rest = fwd(start, end)
            if rest > 1e-9 && len - rest > 1e-9 {
                // Where the ring closes with an invisible edge (`real..len`), what stays stops at it.
                let parts: [(Double, Double)] = real >= len ? [(0, 2 * len)] : [(0, real), (len, len + real)]
                keep = parts.map { lo, hi in (jmax(start, lo), jmin(start + rest, hi)) }.filter { x, y in y - x > 1e-9 }
            }
        } else {
            let lo = jmin(ua, ub)
            let hi = jmax(ua, ub)
            if um < lo - 1e-9 || um > hi + 1e-9 { return nil }
            keep = [(0, lo), (hi, len)].filter { x, y in y - x > 1e-9 }
        }
    }
    var out = Array(contours[..<index])
    for (u0, u1) in keep {
        let run = span(ring, u0, u1)
        if !run.isEmpty { out.append(BezierContour(segments: snapEnds(run, [a, b], tol), closed: false)) }
    }
    out.append(contentsOf: contours[(index + 1)...])
    return contoursToPath(out)
}
