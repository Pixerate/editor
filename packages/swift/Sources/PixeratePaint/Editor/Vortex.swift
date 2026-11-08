import Foundation
import PixerateCore
import PixerateRaster

/**
 * Vortex paint (`marks.kind: "vortex"`, `engine: "vortex"` and `wet.tool: "vortex"`,
 * `paint-editor/vortex.ts`).
 */

public let VORTEX_SHAPES = ["point", "open", "closed"]

public struct VortexStrokeSummary: Equatable, Sendable {
    public var shape: String
    public var maxDisplacement: Double

    public init(shape: String, maxDisplacement: Double) {
        self.shape = shape
        self.maxDisplacement = maxDisplacement
    }

    public var json: JSONValue {
        ["shape": .string(shape), "maxDisplacement": .number(maxDisplacement)]
    }
}

public struct VortexClassification: Sendable {
    public var shape: String
    public var pathLength: Double
    public var signedArea: Double
    public var vertices: [PenPoint]
}

/// Deduplicates consecutive samples closer than 0.5 px and applies position/pressure smoothing.
public func smoothVortexPoints(_ points: [PenPoint], _ posSmoothing: Double = 0, _ pressureSmoothing: Double = 0) -> [PenPoint] {
    guard let first = points.first else { return [] }
    var out: [PenPoint] = []
    let posAlpha = 1.0 - Swift.min(0.95, Swift.max(0.0, posSmoothing)) * 0.85
    let presAlpha = 1.0 - Swift.min(0.95, Swift.max(0.0, pressureSmoothing)) * 0.85
    var sx = first.x
    var sy = first.y
    var sp = first.pressure ?? 1.0
    var p0 = first
    p0.x = sx
    p0.y = sy
    p0.pressure = sp
    out.append(p0)

    for i in 1..<points.count {
        let p = points[i]
        sx += (p.x - sx) * posAlpha
        sy += (p.y - sy) * posAlpha
        sp += ((p.pressure ?? 1.0) - sp) * presAlpha
        let prev = out[out.count - 1]
        if hypot(sx - prev.x, sy - prev.y) >= 0.5 || i == points.count - 1 {
            var q = p
            q.x = sx
            q.y = sy
            q.pressure = sp
            out.append(q)
        }
    }
    return out
}

private func segmentsProperlyIntersect(
    _ ax: Double, _ ay: Double,
    _ bx: Double, _ by: Double,
    _ cx: Double, _ cy: Double,
    _ dx: Double, _ dy: Double
) -> (hit: Bool, x: Double, y: Double) {
    let rX = bx - ax
    let rY = by - ay
    let sX = dx - cx
    let sY = dy - cy
    let denom = rX * sY - rY * sX
    if abs(denom) < 1e-8 { return (false, 0, 0) }
    let qpX = cx - ax
    let qpY = cy - ay
    let t = (qpX * sY - qpY * sX) / denom
    let u = (qpX * rY - qpY * rX) / denom
    if t > 1e-4 && t < 1.0 - 1e-4 && u > 1e-4 && u < 1.0 - 1e-4 {
        return (true, ax + t * rX, ay + t * rY)
    }
    return (false, 0, 0)
}

/// Classifies a stroke into `"point"`, `"open"`, or `"closed"`.
public func classifyVortexShape(
    _ rawPoints: [PenPoint],
    _ tipSize: Double,
    _ posSmoothing: Double = 0,
    _ pressureSmoothing: Double = 0
) -> VortexClassification {
    let vertices = smoothVortexPoints(rawPoints, posSmoothing, pressureSmoothing)
    if vertices.count <= 1 {
        return VortexClassification(shape: "point", pathLength: 0, signedArea: 0, vertices: vertices)
    }
    var cumLen = [Double](repeating: 0, count: vertices.count)
    var pathLength = 0.0
    for i in 1..<vertices.count {
        pathLength += hypot(vertices[i].x - vertices[i - 1].x, vertices[i].y - vertices[i - 1].y)
        cumLen[i] = pathLength
    }

    let pointThreshold = Swift.max(2.0, tipSize * 0.35)
    if pathLength < pointThreshold {
        return VortexClassification(shape: "point", pathLength: pathLength, signedArea: 0, vertices: vertices)
    }

    let first = vertices[0]
    let last = vertices[vertices.count - 1]
    let endDist = hypot(last.x - first.x, last.y - first.y)
    let closeThreshold = Swift.max(4.0, tipSize)

    var area2 = 0.0
    for i in 0..<vertices.count {
        let a = vertices[i]
        let b = vertices[(i + 1) % vertices.count]
        area2 += a.x * b.y - b.x * a.y
    }
    let signedArea = area2 * 0.5

    if endDist <= closeThreshold && vertices.count >= 4 && pathLength >= Swift.max(8.0, tipSize * 2.0) {
        let nSeg = vertices.count - 1
        var selfCrosses = false
        let closureZone = Swift.min(closeThreshold, pathLength * 0.18)
        var i = 0
        while i < nSeg && !selfCrosses {
            let a = vertices[i]
            let b = vertices[i + 1]
            if i + 2 < nSeg {
                for j in (i + 2)..<nSeg {
                    if i == 0 && j == nSeg - 1 { continue }
                    let c = vertices[j]
                    let d = vertices[j + 1]
                    let inter = segmentsProperlyIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)
                    if inter.hit {
                        let nearStart = cumLen[i + 1] <= closureZone
                        let nearEnd = pathLength - cumLen[j] <= closureZone
                        let nearClosurePt =
                            hypot(inter.x - first.x, inter.y - first.y) <= closeThreshold ||
                            hypot(inter.x - last.x, inter.y - last.y) <= closeThreshold
                        if !(nearStart && nearEnd && nearClosurePt) {
                            selfCrosses = true
                            break
                        }
                    }
                }
            }
            i += 1
        }
        let minLoopArea = (pathLength * pathLength) / (16.0 * Double.pi)
        if !selfCrosses && abs(signedArea) >= minLoopArea {
            return VortexClassification(shape: "closed", pathLength: pathLength, signedArea: signedArea, vertices: vertices)
        }
    }

    return VortexClassification(shape: "open", pathLength: pathLength, signedArea: signedArea, vertices: vertices)
}

/// Resolves the spin sign (`1` clockwise in document space where +y is down, `-1` counter-clockwise).
func resolveVortexSpinSign(
    _ direction: String,
    _ shape: String,
    _ signedArea: Double,
    _ copy: StrokeCopy = IDENTITY_COPY
) -> Int {
    var sign = 1
    if direction == "cw" {
        sign = 1
    } else if direction == "ccw" {
        sign = -1
    } else if shape == "closed" {
        sign = signedArea < 0 ? -1 : 1
    } else {
        sign = 1
    }
    let det = copy.linear[0] * copy.linear[3] - copy.linear[1] * copy.linear[2]
    if det < 0 { sign = -sign }
    return sign
}

private func pointInPolygon(_ x: Double, _ y: Double, _ poly: [PenPoint]) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in 0..<poly.count {
        let xi = poly[i].x, yi = poly[i].y
        let xj = poly[j].x, yj = poly[j].y
        let intersect = ((yi > y) != (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)
        if intersect { inside.toggle() }
        j = i
    }
    return inside
}

private func smoothGrid3x3(_ src: [Float], _ cols: Int, _ rows: Int, _ passes: Int = 2) -> [Float] {
    var cur = src
    var tmp = [Float](repeating: 0, count: src.count)
    for _ in 0..<passes {
        for r in 0..<rows {
            let rowOff = r * cols
            for c in 0..<cols {
                let c0 = c > 0 ? c - 1 : 0
                let c1 = c < cols - 1 ? c + 1 : cols - 1
                tmp[rowOff + c] = Float((Double(cur[rowOff + c0]) + 2.0 * Double(cur[rowOff + c]) + Double(cur[rowOff + c1])) * 0.25)
            }
        }
        for r in 0..<rows {
            let r0 = r > 0 ? r - 1 : 0
            let r1 = r < rows - 1 ? r + 1 : rows - 1
            let off0 = r0 * cols
            let offC = r * cols
            let off1 = r1 * cols
            for c in 0..<cols {
                cur[offC + c] = Float((Double(tmp[off0 + c]) + 2.0 * Double(tmp[offC + c]) + Double(tmp[off1 + c])) * 0.25)
            }
        }
    }
    return cur
}

@inline(__always)
private func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    let t = Swift.max(0.0, Swift.min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)
}

/// Computes the local reach in pixels at a sample point `p` for `brush`.
public func localVortexReachPx(_ brush: PaintBrush, _ p: PenPoint) -> Double {
    let vortex = brushVortex(brush)
    let tipRadius = Swift.max(1.0, brush.tip.size * 0.5)
    let minS = Swift.max(0.15, brush.dynamics.minSize)
    let pScale = brush.tip.pressureSize
        ? minS + (1.0 - minS) * Swift.max(0.0, Swift.min(1.0, p.pressure ?? 1.0))
        : 1.0
    return Swift.max(2.0, vortex.reach * tipRadius * pScale)
}

/// Builds the coarse-grid forward velocity field `v(x, y)` for one vortex stroke (or one symmetry copy of it).
public func buildVortexVelocityField(
    _ rawPoints: [PenPoint],
    _ brush: PaintBrush,
    spinSignOverride: Int? = nil
) -> (velocity: VelocityGridField, classification: VortexClassification) {
    let vortex = brushVortex(brush)
    let tipRadius = Swift.max(1.0, brush.tip.size * 0.5)
    let classification = classifyVortexShape(
        rawPoints,
        brush.tip.size,
        brush.tip.smoothing,
        brush.pressureSmoothing
    )
    let shape = classification.shape
    let signedArea = classification.signedArea
    let vertices = classification.vertices
    let spinSign = Double(spinSignOverride ?? resolveVortexSpinSign(vortex.direction, shape, signedArea, IDENTITY_COPY))
    let step = Swift.max(1, Swift.min(4, Int(JS.round(tipRadius / 6.0))))

    if vertices.isEmpty {
        let empty = VelocityGridField(
            rect: RasterRect(x: 0, y: 0, width: step, height: step),
            step: step,
            cols: 2,
            rows: 2,
            vx: [Float](repeating: 0, count: 4),
            vy: [Float](repeating: 0, count: 4),
            maxSpeed: 0
        )
        return (empty, classification)
    }

    let reaches = vertices.map { localVortexReachPx(brush, $0) }
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    var maxReach = 0.0
    for i in 0..<vertices.count {
        let p = vertices[i]
        let r = reaches[i]
        if p.x < minX { minX = p.x }
        if p.y < minY { minY = p.y }
        if p.x > maxX { maxX = p.x }
        if p.y > maxY { maxY = p.y }
        if r > maxReach { maxReach = r }
    }

    let margin = ceil(maxReach + Double(step * 3))
    let rx0 = Int(floor(minX - margin))
    let ry0 = Int(floor(minY - margin))
    let rx1 = Int(ceil(maxX + margin))
    let ry1 = Int(ceil(maxY + margin))
    let cols = Swift.max(3, Int(ceil(Double(rx1 - rx0) / Double(step))) + 1)
    let rows = Swift.max(3, Int(ceil(Double(ry1 - ry0) / Double(step))) + 1)
    let rect = RasterRect(x: rx0, y: ry0, width: (cols - 1) * step, height: (rows - 1) * step)
    let count = cols * rows
    var vx = [Float](repeating: 0, count: count)
    var vy = [Float](repeating: 0, count: count)
    var maxSpeed = 0.0

    if shape == "point" {
        var cx = 0.0, cy = 0.0, R = 0.0
        for i in 0..<vertices.count {
            cx += vertices[i].x
            cy += vertices[i].y
            R += reaches[i]
        }
        let invN = 1.0 / Double(vertices.count)
        cx *= invN
        cy *= invN
        R *= invN
        let rc = Swift.max(1.5, Swift.min(tipRadius * 0.45, R * 0.35))

        for r in 0..<rows {
            let y = Double(rect.y + r * step)
            for c in 0..<cols {
                let x = Double(rect.x + c * step)
                let idx = r * cols + c
                let dx = x - cx
                let dy = y - cy
                let d = hypot(dx, dy)
                if d >= R || d <= 1e-5 { continue }
                let nx = dx / d
                let ny = dy / d
                let tx = -ny * spinSign
                let ty = nx * spinSign
                let u = d / rc
                let lamb = ((1.0 - exp(-(u * u))) / u) / 0.63817
                let s = d / R
                let win = (1.0 - s * s) * (1.0 - s * s)
                let spinMag = lamb * win
                let pullMag = vortex.pull * sin(Double.pi * s) * win * 0.65
                let ux = spinMag * tx - pullMag * nx
                let uy = spinMag * ty - pullMag * ny
                vx[idx] = Float(ux)
                vy[idx] = Float(uy)
                let sp = hypot(ux, uy)
                if sp > maxSpeed { maxSpeed = sp }
            }
        }
        return (VelocityGridField(rect: rect, step: step, cols: cols, rows: rows, vx: vx, vy: vy, maxSpeed: maxSpeed), classification)
    }

    var rawD = [Float](repeating: 0, count: count)
    var reachGrid = [Float](repeating: 0, count: count)
    let segCount = shape == "closed" ? vertices.count : vertices.count - 1
    let loopInteriorReach = shape == "closed" ? Swift.max(maxReach, hypot(maxX - minX, maxY - minY) * 0.6) : maxReach

    for r in 0..<rows {
        let y = Double(rect.y + r * step)
        for c in 0..<cols {
            let x = Double(rect.x + c * step)
            let idx = r * cols + c
            var bestD2 = Double.infinity
            var bestReach = maxReach
            for i in 0..<segCount {
                let j = (i + 1) % vertices.count
                let ax = vertices[i].x, ay = vertices[i].y
                let bx = vertices[j].x, by = vertices[j].y
                let abx = bx - ax, aby = by - ay
                let len2 = abx * abx + aby * aby
                let t = len2 > 1e-8 ? Swift.max(0.0, Swift.min(1.0, ((x - ax) * abx + (y - ay) * aby) / len2)) : 0.0
                let px = ax + t * abx
                let py = ay + t * aby
                let d2 = (x - px) * (x - px) + (y - py) * (y - py)
                if d2 < bestD2 {
                    bestD2 = d2
                    bestReach = reaches[i] + t * (reaches[j] - reaches[i])
                }
            }
            let dist = bestD2.squareRoot()
            let inside = shape == "closed" && pointInPolygon(x, y, vertices)
            rawD[idx] = Float(inside ? -dist : dist)
            reachGrid[idx] = Float(bestReach)
        }
    }

    let smoothD = smoothGrid3x3(rawD, cols, rows, 2)
    let rc = Swift.max(1.5, tipRadius * (shape == "closed" ? 0.55 : 0.4))

    for r in 0..<rows {
        let rPrev = r > 0 ? r - 1 : 0
        let rNext = r < rows - 1 ? r + 1 : rows - 1
        let dySpan = Double((rNext - rPrev) * step)
        for c in 0..<cols {
            let idx = r * cols + c
            let dExact = Double(rawD[idx])
            let R = Double(reachGrid[idx])
            let limit = dExact < 0 ? loopInteriorReach : R
            let absD = abs(dExact)
            if absD >= limit { continue }

            let cPrev = c > 0 ? c - 1 : 0
            let cNext = c < cols - 1 ? c + 1 : cols - 1
            let dxSpan = Double((cNext - cPrev) * step)
            let gx = (Double(smoothD[r * cols + cNext]) - Double(smoothD[r * cols + cPrev])) / dxSpan
            let gy = (Double(smoothD[rNext * cols + c]) - Double(smoothD[rPrev * cols + c])) / dySpan
            let gradMag = hypot(gx, gy)
            if gradMag <= 1e-5 { continue }

            let nx = gx / gradMag
            let ny = gy / gradMag
            let tx = -ny * spinSign
            let ty = nx * spinSign
            let axisWeight = smoothstep(0.08, 0.55, gradMag)

            let s = absD / limit
            let win = (1.0 - s * s) * (1.0 - s * s)
            let lamb: Double
            if shape == "closed" {
                lamb = rc / hypot(absD, rc)
            } else {
                let u = Swift.max(1e-3, absD / rc)
                lamb = ((1.0 - exp(-(u * u))) / u) / 0.63817
            }
            let spinMag = lamb * win * axisWeight
            let signSmooth = tanh(Double(smoothD[idx]) / Swift.max(1.5, rc * 0.5))
            let pullMag = vortex.pull * sin(Double.pi * Swift.min(1.0, absD / R)) * win * 0.6 * signSmooth
            let ux = spinMag * tx - pullMag * nx
            let uy = spinMag * ty - pullMag * ny
            vx[idx] = Float(ux)
            vy[idx] = Float(uy)
            let sp = hypot(ux, uy)
            if sp > maxSpeed { maxSpeed = sp }
        }
    }

    return (VelocityGridField(rect: rect, step: step, cols: cols, rows: rows, vx: vx, vy: vy, maxSpeed: maxSpeed), classification)
}

/// Builds the integrated backward `DisplacementField` for a vortex stroke across all symmetry copies.
func buildVortexDisplacement(
    _ rawPoints: [PenPoint],
    _ brush: PaintBrush,
    _ copies: [StrokeCopy] = [IDENTITY_COPY]
) -> (field: DisplacementField?, shape: String, maxDisplacement: Double) {
    let vortex = brushVortex(brush)
    let tipRadius = Swift.max(1.0, brush.tip.size * 0.5)
    let primaryClass = classifyVortexShape(
        rawPoints,
        brush.tip.size,
        brush.tip.smoothing,
        brush.pressureSmoothing
    )
    if rawPoints.isEmpty {
        return (nil, "point", 0)
    }

    let charRadius = tipRadius * (0.35 + 0.22 * vortex.reach)
    let totalTravel = vortex.turns * 2.0 * Double.pi * charRadius

    var combined: DisplacementField? = nil
    let activeCopies = copies.isEmpty ? [IDENTITY_COPY] : copies
    for copy in activeCopies {
        let mapped = rawPoints.map { copy.map($0) }
        let spinSign = resolveVortexSpinSign(vortex.direction, primaryClass.shape, primaryClass.signedArea, copy)
        let (velocity, _) = buildVortexVelocityField(mapped, brush, spinSignOverride: spinSign)
        let disp = integrateVelocityField(velocity, totalTravel)
        if disp.maxDisplacement <= 1e-4 { continue }
        combined = combined.map { composeDisplacementFields($0, disp) } ?? disp
    }

    return (
        combined,
        primaryClass.shape,
        combined.map { JS.round($0.maxDisplacement * 100.0) / 100.0 } ?? 0
    )
}

/// Builds the live guide segments shown while drawing a vortex stroke (`"vortex"` and `"vortex-reach"`).
public func vortexGuideSegments(
    _ rawPoints: [PenPoint],
    _ brush: PaintBrush
) -> [(from: Point2, to: Point2, kind: String)] {
    vortexGuideSegments(rawPoints, brush, [IDENTITY_COPY])
}

func vortexGuideSegments(
    _ rawPoints: [PenPoint],
    _ brush: PaintBrush,
    _ copies: [StrokeCopy]
) -> [(from: Point2, to: Point2, kind: String)] {
    if rawPoints.isEmpty { return [] }
    var out: [(from: Point2, to: Point2, kind: String)] = []
    let tipRadius = Swift.max(1.0, brush.tip.size * 0.5)
    let smoothed = smoothVortexPoints(rawPoints, brush.tip.smoothing, brush.pressureSmoothing)
    let classification = classifyVortexShape(
        rawPoints,
        brush.tip.size,
        brush.tip.smoothing,
        brush.pressureSmoothing
    )
    let reaches = smoothed.map { localVortexReachPx(brush, $0) }
    let activeCopies = copies.isEmpty ? [IDENTITY_COPY] : copies

    for copy in activeCopies {
        let pts = smoothed.map { copy.map($0) }
        if pts.count == 1 || classification.shape == "point" {
            let c = pts[0]
            let R = reaches.first ?? localVortexReachPx(brush, PenPoint(x: c.x, y: c.y, pressure: 1))
            let rCore = Swift.max(2.0, Swift.min(tipRadius, R * 0.25))
            let steps = 16
            for i in 0..<steps {
                let a0 = (Double(i) / Double(steps)) * Double.pi * 2.0
                let a1 = (Double(i + 1) / Double(steps)) * Double.pi * 2.0
                out.append((
                    from: Point2(x: c.x + cos(a0) * rCore, y: c.y + sin(a0) * rCore),
                    to: Point2(x: c.x + cos(a1) * rCore, y: c.y + sin(a1) * rCore),
                    kind: "vortex"
                ))
                out.append((
                    from: Point2(x: c.x + cos(a0) * R, y: c.y + sin(a0) * R),
                    to: Point2(x: c.x + cos(a1) * R, y: c.y + sin(a1) * R),
                    kind: "vortex-reach"
                ))
            }
            continue
        }

        for i in 0..<(pts.count - 1) {
            out.append((
                from: Point2(x: pts[i].x, y: pts[i].y),
                to: Point2(x: pts[i + 1].x, y: pts[i + 1].y),
                kind: "vortex"
            ))
        }
        if classification.shape == "closed" {
            out.append((
                from: Point2(x: pts[pts.count - 1].x, y: pts[pts.count - 1].y),
                to: Point2(x: pts[0].x, y: pts[0].y),
                kind: "vortex"
            ))
        }

        var left: [Point2] = []
        var right: [Point2] = []
        for i in 0..<pts.count {
            let prev = i > 0 ? pts[i - 1] : (classification.shape == "closed" ? pts[pts.count - 1] : pts[0])
            let next = (i + 1 < pts.count) ? pts[i + 1] : (classification.shape == "closed" ? pts[0] : pts[pts.count - 1])
            let dx = next.x - prev.x
            let dy = next.y - prev.y
            let len = hypot(dx, dy)
            let invLen = len > 0 ? 1.0 / len : 1.0
            let nx = -dy * invLen
            let ny = dx * invLen
            let r = reaches[i]
            left.append(Point2(x: pts[i].x + nx * r, y: pts[i].y + ny * r))
            right.append(Point2(x: pts[i].x - nx * r, y: pts[i].y - ny * r))
        }
        if left.count >= 2 {
            for i in 0..<(left.count - 1) {
                out.append((from: left[i], to: left[i + 1], kind: "vortex-reach"))
                out.append((from: right[i], to: right[i + 1], kind: "vortex-reach"))
            }
            if classification.shape == "closed" {
                out.append((from: left[left.count - 1], to: left[0], kind: "vortex-reach"))
                out.append((from: right[right.count - 1], to: right[0], kind: "vortex-reach"))
            } else {
                out.append((from: left[0], to: right[0], kind: "vortex-reach"))
                out.append((from: left[left.count - 1], to: right[right.count - 1], kind: "vortex-reach"))
            }
        }
    }
    return out
}

struct VortexStrokeDriverInit {
    var brush: PaintBrush
    var base: TiledSurface
    var offset: LayerOffset
    var lockTransparency: Bool
    var selection: PaintSelection?
    var color: [Int]
    var background: [Int]
    var grain: PaperGrain?
    var paperDepth: Double
    var seed: Int
    var copies: [StrokeCopy]
    var paint: PaintGradientSource?
    var effect: EffectPaintPixels?
    var stampArt: StampArtLookup?
    var relief: ThickChannels?
}

private func sameTileContent(_ a: Tile?, _ b: Tile?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    if a === b { return true }
    if a.uniform != nil || b.uniform != nil { return a.uniform == b.uniform }
    return a.data == b.data
}

private func surfaceDiffers(_ a: TiledSurface, _ b: TiledSurface) -> Bool {
    if a === b { return false }
    if a.tiles.count != b.tiles.count { return true }
    for (k, ta) in a.tiles {
        if !sameTileContent(ta, b.tiles.get(k)) { return true }
    }
    return false
}

final class VortexStrokeDriver {
    private let initValues: VortexStrokeDriverInit
    private var rawPoints: [PenPoint] = []
    private var warpedSurface: TiledSurface? = nil
    private var preInkSurface: TiledSurface? = nil
    private var displacementField: DisplacementField? = nil
    private var warpedRelief: ThickChannels? = nil
    private var changedBounds: RasterRect? = nil
    private var summary = VortexStrokeSummary(shape: "point", maxDisplacement: 0)
    var dabCount = 0

    init(_ initValues: VortexStrokeDriverInit) {
        self.initValues = initValues
    }

    func push(_ points: [PenPoint]) -> [RasterRect] {
        rawPoints.append(contentsOf: points)
        return []
    }

    func finish() -> (surface: TiledSurface?, bounds: RasterRect?) {
        let i = initValues
        let brush = i.brush
        let vortex = brushVortex(brush)

        if rawPoints.isEmpty {
            summary = VortexStrokeSummary(shape: "point", maxDisplacement: 0)
            return (nil, nil)
        }

        let (field, shape, maxDisplacement) = buildVortexDisplacement(rawPoints, brush, i.copies)
        displacementField = field

        var preSurface = i.base
        var preFilm = i.relief?.film
        var inkBounds: RasterRect? = nil

        if vortex.ink > 0 && i.base.channels == 4 {
            var inkBrush = brush
            inkBrush.tip.opacity = Swift.min(1.0, brush.tip.opacity * vortex.ink)
            let filmBuf = (i.relief != nil && brush.iridescence != nil)
                ? FilmBuffer(i.relief!.film, i.offset, i.selection)
                : nil
            let dry = DryStroke(
                inkBrush,
                grain: i.grain,
                paperDepth: i.paperDepth,
                seed: i.seed,
                copies: i.copies,
                effect: i.effect,
                stampArt: i.stampArt
            )
            dry.film = filmBuf
            let rects = dry.push(rawPoints) + dry.finish()
            if !rects.isEmpty {
                var tiles = i.base.tiles
                let apply = StrokeApply(
                    mode: .paint,
                    color: i.color,
                    background: i.background,
                    opacity: inkBrush.tip.opacity,
                    blend: inkBrush.tip.blend,
                    lockTransparency: i.lockTransparency,
                    selection: i.selection,
                    offset: i.offset
                )
                var touchedOrder: [TileKey] = []
                var touchedCoords: [TileKey: (tx: Int, ty: Int)] = [:]
                for r in rects {
                    inkBounds = unionRect(inkBounds, r)
                    for t in tilesInRect(RasterRect(x: r.x - i.offset.x, y: r.y - i.offset.y, width: r.width, height: r.height)) {
                        let key = tileKey(t.tx, t.ty)
                        if touchedCoords[key] == nil {
                            touchedOrder.append(key)
                            touchedCoords[key] = t
                        }
                    }
                }
                let defaultTile = [UInt8](repeating: UInt8(truncatingIfNeeded: i.base.defaultValue), count: TILE * TILE * 4)
                for key in touchedOrder {
                    let (tx, ty) = touchedCoords[key]!
                    let src = i.base.tiles.get(key)?.data ?? defaultTile
                    let data = applyStrokeToTile(dry.coverage, src, 4, tx, ty, apply)
                    if let finished = finishTile(data, 4, i.base.defaultValue) {
                        tiles.set(key, finished)
                    } else {
                        _ = tiles.delete(key)
                    }
                }
                preSurface = TiledSurface(channels: 4, tiles: tiles, defaultValue: i.base.defaultValue)
                if let filmBuf { preFilm = filmBuf.surface() }
            }
        }
        preInkSurface = preSurface

        var finalSurface = preSurface
        var warpBounds: RasterRect? = nil
        let warpOpts = WarpSurfaceOptions(
            scale: 1.0,
            offset: i.offset,
            selection: i.selection,
            lockTransparency: i.lockTransparency
        )
        if let field, field.maxDisplacement > 1e-4 {
            if preSurface.channels == 4 {
                let res = warpTiledSurfaceRgba(preSurface, field, warpOpts)
                finalSurface = res.surface
                warpBounds = res.bounds
            } else {
                let res = warpTiledSurfaceChannel(preSurface, field, warpOpts)
                finalSurface = res.surface
                warpBounds = res.bounds
            }
        }

        var reliefChanged = false
        if let relief = i.relief {
            var height = relief.height
            var material = relief.material
            var film = preFilm ?? relief.film
            if let field, field.maxDisplacement > 1e-4 {
                let wHeight = warpTiledSurfaceChannel(height, field, warpOpts)
                let wMat = warpTiledSurfaceNearest(material, field, warpOpts)
                let wFilm = warpTiledSurfaceNearest(film, field, warpOpts)
                height = wHeight.surface
                material = wMat.surface
                film = wFilm.surface
                warpBounds = unionRectOpt(warpBounds, unionRectOpt(wHeight.bounds, unionRectOpt(wMat.bounds, wFilm.bounds)))
            }
            reliefChanged =
                surfaceDiffers(height, relief.height) ||
                surfaceDiffers(material, relief.material) ||
                surfaceDiffers(film, relief.film)
            if reliefChanged {
                warpedRelief = ThickChannels(height: height, material: material, film: film)
            }
        }

        let surfaceChanged = surfaceDiffers(finalSurface, i.base)
        let anyChanged = surfaceChanged || reliefChanged
        dabCount = anyChanged ? Swift.max(1, rawPoints.count) : 0
        changedBounds = anyChanged ? (unionRectOpt(inkBounds, warpBounds) ?? field?.rect) : nil
        warpedSurface = anyChanged ? finalSurface : nil
        summary = VortexStrokeSummary(shape: shape, maxDisplacement: anyChanged ? maxDisplacement : 0)

        return (warpedSurface, changedBounds)
    }

    func vortexResult() -> VortexStrokeSummary { summary }

    func reliefChannels() -> ThickChannels? { warpedRelief }

    func windingAnimation() -> (field: DisplacementField, preInkSurface: TiledSurface, duration: Double)? {
        let duration = brushVortex(initValues.brush).duration
        guard let _ = warpedSurface, let field = displacementField, let preInk = preInkSurface, duration > 0 else { return nil }
        return (field, preInk, duration)
    }
}
