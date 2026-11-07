// Contiguous region flood fill with gap closing, area expansion/contraction, and enclosed region detection.
// Port of `raster/fill.ts`.

import Foundation

public struct FillRegionPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct FillRegionSummary: Equatable, Sendable {
    public var point: FillRegionPoint
    public var bounds: RasterRect?
    public var pixelCount: Int
    public var leaked: Bool
    public init(point: FillRegionPoint, bounds: RasterRect?, pixelCount: Int, leaked: Bool) {
        self.point = point
        self.bounds = bounds
        self.pixelCount = pixelCount
        self.leaked = leaked
    }
}

public struct FillRegionMaskOptions: Sendable {
    public var points: [FillRegionPoint]
    public var tolerance: Double?
    public var closeGap: Double?
    public var expand: Double?
    public var antialias: Bool?
    public init(points: [FillRegionPoint], tolerance: Double? = nil, closeGap: Double? = nil, expand: Double? = nil, antialias: Bool? = nil) {
        self.points = points
        self.tolerance = tolerance
        self.closeGap = closeGap
        self.expand = expand
        self.antialias = antialias
    }
}

public struct FillRegionMaskResult: Sendable {
    public var mask: [Float]
    public var bounds: RasterRect?
    public var pixelCount: Int
    public var leaked: Bool
    public var regions: [FillRegionSummary]
}

public struct UnfilledRegion: Equatable, Sendable {
    public var point: (x: Int, y: Int)
    public var centroid: (x: Int, y: Int)
    public var bounds: RasterRect
    public var pixelCount: Int
    public var touchesEdge: Bool

    public static func == (lhs: UnfilledRegion, rhs: UnfilledRegion) -> Bool {
        lhs.point.x == rhs.point.x && lhs.point.y == rhs.point.y &&
        lhs.centroid.x == rhs.centroid.x && lhs.centroid.y == rhs.centroid.y &&
        lhs.bounds == rhs.bounds && lhs.pixelCount == rhs.pixelCount &&
        lhs.touchesEdge == rhs.touchesEdge
    }
}

public struct FindUnfilledRegionsMaskOptions: Sendable {
    public var target: [UInt8]?
    public var tolerance: Double?
    public var closeGap: Double?
    public var minArea: Int?
    public var includeEdge: Bool?
    public var maxRegions: Int?
    public init(target: [UInt8]? = nil, tolerance: Double? = nil, closeGap: Double? = nil, minArea: Int? = nil, includeEdge: Bool? = nil, maxRegions: Int? = nil) {
        self.target = target
        self.tolerance = tolerance
        self.closeGap = closeGap
        self.minArea = minArea
        self.includeEdge = includeEdge
        self.maxRegions = maxRegions
    }
}

private let INF = 1e12

/// Exact 2D squared Euclidean distance transform (Felzenszwalb & Huttenlocher, O(w * h)).
/// Returns for each pixel the squared distance `(dx^2 + dy^2)` to the nearest `0` in `binary`.
public func squaredDistanceTransform(_ binary: [UInt8], _ w: Int, _ h: Int) -> [Double] {
    let n = w * h
    var dist = [Double](repeating: INF, count: n)
    var hasZero = false
    for i in 0..<n {
        if binary[i] == 0 {
            dist[i] = 0
            hasZero = true
        }
    }
    if !hasZero { return dist }

    let maxDim = Swift.max(w, h)
    var f = [Double](repeating: 0, count: maxDim)
    var d = [Double](repeating: 0, count: maxDim)
    var v = [Int](repeating: 0, count: maxDim)
    var z = [Double](repeating: 0, count: maxDim + 1)

    for x in 0..<w {
        for y in 0..<h { f[y] = dist[y * w + x] }
        edt1d(f, &d, &v, &z, h)
        for y in 0..<h { dist[y * w + x] = d[y] }
    }
    for y in 0..<h {
        let row = y * w
        for x in 0..<w { f[x] = dist[row + x] }
        edt1d(f, &d, &v, &z, w)
        for x in 0..<w { dist[row + x] = d[x] }
    }
    return dist
}

private func edt1d(_ f: [Double], _ d: inout [Double], _ v: inout [Int], _ z: inout [Double], _ n: Int) {
    var k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    if n > 1 {
        for q in 1..<n {
            let fq = f[q] + Double(q * q)
            var vk = v[k]
            var s = (fq - (f[vk] + Double(vk * vk))) / Double(2 * q - 2 * vk)
            while s <= z[k] {
                k -= 1
                vk = v[k]
                s = (fq - (f[vk] + Double(vk * vk))) / Double(2 * q - 2 * vk)
            }
            k += 1
            v[k] = q
            z[k] = s
            z[k + 1] = INF
        }
    }
    k = 0
    for q in 0..<n {
        while z[k + 1] < Double(q) { k += 1 }
        let vk = v[k]
        let dx = q - vk
        d[q] = Double(dx * dx) + f[vk]
    }
}

@inline(__always)
private func pixelMatches(_ data: [UInt8], _ p: Int, _ sr: Int, _ sg: Int, _ sb: Int, _ sa: Int, _ tol: Double) -> Bool {
    let a = Int(data[p + 3])
    if sa == 0 && a == 0 { return true }
    return (
        Double(Swift.abs(Int(data[p]) - sr)) <= tol &&
        Double(Swift.abs(Int(data[p + 1]) - sg)) <= tol &&
        Double(Swift.abs(Int(data[p + 2]) - sb)) <= tol &&
        Double(Swift.abs(a - sa)) <= tol
    )
}

private func floodOneSeed(
    _ reference: [UInt8],
    _ w: Int,
    _ h: Int,
    _ sx: Int,
    _ sy: Int,
    _ tol: Double,
    _ closeGap: Double,
    _ expand: Double,
    _ queue: inout [Int]
) -> [UInt8] {
    let n = w * h
    var marks = [UInt8](repeating: 0, count: n)
    if sx < 0 || sy < 0 || sx >= w || sy >= h { return marks }

    let sp = (sy * w + sx) * 4
    let sr = Int(reference[sp])
    let sg = Int(reference[sp + 1])
    let sb = Int(reference[sp + 2])
    let sa = Int(reference[sp + 3])

    var open = [UInt8](repeating: 0, count: n)
    for i in 0..<n {
        if pixelMatches(reference, i * 4, sr, sg, sb, sa, tol) { open[i] = 1 }
    }
    let start = sy * w + sx
    open[start] = 1

    if closeGap <= 0 {
        var head = 0
        var tail = 0
        marks[start] = 1
        queue[tail] = start
        tail += 1
        while head < tail {
            let cur = queue[head]
            head += 1
            let cx = cur % w
            let cy = (cur - cx) / w
            if cx > 0 {
                let nb = cur - 1
                if open[nb] == 1 && marks[nb] == 0 {
                    marks[nb] = 1
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cx + 1 < w {
                let nb = cur + 1
                if open[nb] == 1 && marks[nb] == 0 {
                    marks[nb] = 1
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cy > 0 {
                let nb = cur - w
                if open[nb] == 1 && marks[nb] == 0 {
                    marks[nb] = 1
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cy + 1 < h {
                let nb = cur + w
                if open[nb] == 1 && marks[nb] == 0 {
                    marks[nb] = 1
                    queue[tail] = nb
                    tail += 1
                }
            }
        }
    } else {
        let distSq = squaredDistanceTransform(open, w, h)
        let r = (closeGap + 1) * 0.5
        let rSq = r * r
        let maxClimb = Int(JS.ceil(r)) + 2

        var coreSeed = start
        var head = 0
        var tail = 0
        marks[start] = 1
        queue[tail] = start
        tail += 1

        var step = 0
        while step < maxClimb && distSq[coreSeed] <= rSq {
            let cx = coreSeed % w
            let cy = (coreSeed - cx) / w
            var best = coreSeed
            var bestD = distSq[coreSeed]
            if cx > 0 && open[coreSeed - 1] == 1 && distSq[coreSeed - 1] > bestD {
                best = coreSeed - 1
                bestD = distSq[best]
            }
            if cx + 1 < w && open[coreSeed + 1] == 1 && distSq[coreSeed + 1] > bestD {
                best = coreSeed + 1
                bestD = distSq[best]
            }
            if cy > 0 && open[coreSeed - w] == 1 && distSq[coreSeed - w] > bestD {
                best = coreSeed - w
                bestD = distSq[best]
            }
            if cy + 1 < h && open[coreSeed + w] == 1 && distSq[coreSeed + w] > bestD {
                best = coreSeed + w
                bestD = distSq[best]
            }
            if best == coreSeed { break }
            coreSeed = best
            if marks[coreSeed] == 0 {
                marks[coreSeed] = 1
                queue[tail] = coreSeed
                tail += 1
            }
            step += 1
        }

        if distSq[coreSeed] > rSq {
            var scan = 0
            while scan < tail {
                let cur = queue[scan]
                scan += 1
                if distSq[cur] <= rSq { continue }
                let cx = cur % w
                let cy = (cur - cx) / w
                if cx > 0 {
                    let nb = cur - 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] > rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cx + 1 < w {
                    let nb = cur + 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] > rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy > 0 {
                    let nb = cur - w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] > rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy + 1 < h {
                    let nb = cur + w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] > rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
            }
            while head < tail {
                let cur = queue[head]
                head += 1
                let curD = distSq[cur]
                let cx = cur % w
                let cy = (cur - cx) / w
                if cx > 0 {
                    let nb = cur - 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cx + 1 < w {
                    let nb = cur + 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy > 0 {
                    let nb = cur - w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy + 1 < h {
                    let nb = cur + w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
            }
        } else {
            let maxLocal = Swift.max(64, Int(JS.floor(closeGap * closeGap * 8)))
            while head < tail && tail < maxLocal {
                let cur = queue[head]
                head += 1
                let cx = cur % w
                let cy = (cur - cx) / w
                if cx > 0 {
                    let nb = cur - 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cx + 1 < w {
                    let nb = cur + 1
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy > 0 {
                    let nb = cur - w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
                if cy + 1 < h {
                    let nb = cur + w
                    if open[nb] == 1 && marks[nb] == 0 && distSq[nb] <= rSq {
                        marks[nb] = 1
                        queue[tail] = nb
                        tail += 1
                    }
                }
            }
        }
    }

    if expand != 0 {
        var any = false
        for i in 0..<n {
            if marks[i] == 1 {
                any = true
                break
            }
        }
        if any {
            let expSq = expand * expand
            if expand > 0 {
                var inv = [UInt8](repeating: 0, count: n)
                for i in 0..<n { inv[i] = marks[i] == 1 ? 0 : 1 }
                let dSq = squaredDistanceTransform(inv, w, h)
                for i in 0..<n { marks[i] = dSq[i] <= expSq ? 1 : 0 }
            } else {
                let dSq = squaredDistanceTransform(marks, w, h)
                for i in 0..<n { marks[i] = dSq[i] > expSq ? 1 : 0 }
            }
        }
    }

    return marks
}

private func summarizeMarks(_ marks: [UInt8], _ w: Int, _ h: Int) -> (bounds: RasterRect?, pixelCount: Int, leaked: Bool) {
    var minX = w
    var minY = h
    var maxX = -1
    var maxY = -1
    var pixelCount = 0
    var leaked = false

    for y in 0..<h {
        let row = y * w
        for x in 0..<w {
            if marks[row + x] == 1 {
                pixelCount += 1
                if x < minX { minX = x }
                if y < minY { minY = y }
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 { leaked = true }
            }
        }
    }

    let bounds = pixelCount > 0 ? RasterRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1) : nil
    return (bounds, pixelCount, leaked)
}

/// Flood-fills one or more seed points against a reference RGBA buffer (`width * height * 4`),
/// closing line-art gaps up to `closeGap` px and expanding/contracting the filled mask by `expand` px.
public func fillRegionMask(
    _ reference: [UInt8],
    _ width: Int,
    _ height: Int,
    _ options: FillRegionMaskOptions
) -> FillRegionMaskResult {
    let n = width * height
    let tol = Swift.max(0, Swift.min(255, options.tolerance ?? 32))
    let closeGap = Swift.max(0, Swift.min(32, options.closeGap ?? 0))
    let expand = Swift.max(-16, Swift.min(16, options.expand ?? 0))
    let antialias = options.antialias ?? true

    var combined = [UInt8](repeating: 0, count: n)
    var queue = [Int](repeating: 0, count: n)
    var regions: [FillRegionSummary] = []

    for pt in options.points {
        let sx = Int(JS.floor(pt.x))
        let sy = Int(JS.floor(pt.y))
        let seedMarks = floodOneSeed(reference, width, height, sx, sy, tol, closeGap, expand, &queue)
        let summary = summarizeMarks(seedMarks, width, height)
        regions.append(FillRegionSummary(
            point: FillRegionPoint(x: pt.x, y: pt.y),
            bounds: summary.bounds,
            pixelCount: summary.pixelCount,
            leaked: summary.leaked
        ))
        for i in 0..<n {
            if seedMarks[i] == 1 { combined[i] = 1 }
        }
    }

    let total = summarizeMarks(combined, width, height)
    var mask = [Float](repeating: 0, count: n)
    if let b = total.bounds {
        let x0 = b.x
        let y0 = b.y
        let x1 = x0 + b.width
        let y1 = y0 + b.height
        for y in y0..<y1 {
            let row = y * width
            for x in x0..<x1 {
                let idx = row + x
                if combined[idx] != 1 { continue }
                if !antialias {
                    mask[idx] = 1
                    continue
                }
                var sum = 0
                var edge = false
                for dy in -1...1 {
                    let ny = y + dy
                    for dx in -1...1 {
                        let nx = x + dx
                        let v = (nx < 0 || ny < 0 || nx >= width || ny >= height) ? 1 : Int(combined[ny * width + nx])
                        if v == 0 { edge = true }
                        sum += v
                    }
                }
                mask[idx] = edge ? JS.f32(0.5 + 0.5 * (Double(sum) / 9.0)) : 1
            }
        }
    }

    return FillRegionMaskResult(
        mask: mask,
        bounds: total.bounds,
        pixelCount: total.pixelCount,
        leaked: total.leaked,
        regions: regions
    )
}

/// Finds enclosed unfilled regions in a reference RGBA buffer (`width * height * 4`),
/// closing gaps up to `closeGap` px and excluding areas already painted on `options.target`.
public func findUnfilledRegionsMask(
    _ reference: [UInt8],
    _ width: Int,
    _ height: Int,
    _ options: FindUnfilledRegionsMaskOptions = FindUnfilledRegionsMaskOptions()
) -> [UnfilledRegion] {
    let n = width * height
    if n <= 0 { return [] }
    let tol = Swift.max(0, Swift.min(255, options.tolerance ?? 32))
    let closeGap = Swift.max(0, Swift.min(32, options.closeGap ?? 0))
    let minArea = Swift.max(1, options.minArea ?? 16)
    let includeEdge = options.includeEdge ?? false
    let maxRegions = Swift.max(1, options.maxRegions ?? 100)
    let target = options.target

    var hasTransparent = false
    for i in 0..<n {
        if Double(reference[i * 4 + 3]) <= tol {
            hasTransparent = true
            break
        }
    }
    let br = Int(reference[0])
    let bg = Int(reference[1])
    let bb = Int(reference[2])
    let ba = Int(reference[3])

    var openRef = [UInt8](repeating: 0, count: n)
    for i in 0..<n {
        let p = i * 4
        let isRefOpen = hasTransparent ? Double(reference[p + 3]) <= tol : pixelMatches(reference, p, br, bg, bb, ba, tol)
        if isRefOpen { openRef[i] = 1 }
    }

    var unfilled = [UInt8](repeating: 0, count: n)
    for i in 0..<n {
        if openRef[i] == 1 && (target == nil || Double(target![i * 4 + 3]) <= tol) {
            unfilled[i] = 1
        }
    }

    let distSq = squaredDistanceTransform(openRef, width, height)
    let r = closeGap > 0 ? (closeGap + 1) * 0.5 : 0
    let rSq = r * r

    var labels = [Int](repeating: 0, count: n)
    var queue = [Int](repeating: 0, count: n)
    var nextLabel = 0
    var coreTail = 0

    for i in 0..<n {
        if unfilled[i] != 1 || labels[i] != 0 || distSq[i] <= rSq { continue }
        nextLabel += 1
        let label = nextLabel
        labels[i] = label
        var head = coreTail
        queue[coreTail] = i
        coreTail += 1
        while head < coreTail {
            let cur = queue[head]
            head += 1
            let cx = cur % width
            let cy = (cur - cx) / width
            if cx > 0 {
                let nb = cur - 1
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] > rSq {
                    labels[nb] = label
                    queue[coreTail] = nb
                    coreTail += 1
                }
            }
            if cx + 1 < width {
                let nb = cur + 1
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] > rSq {
                    labels[nb] = label
                    queue[coreTail] = nb
                    coreTail += 1
                }
            }
            if cy > 0 {
                let nb = cur - width
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] > rSq {
                    labels[nb] = label
                    queue[coreTail] = nb
                    coreTail += 1
                }
            }
            if cy + 1 < height {
                let nb = cur + width
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] > rSq {
                    labels[nb] = label
                    queue[coreTail] = nb
                    coreTail += 1
                }
            }
        }
    }

    if closeGap > 0 && nextLabel > 0 {
        var head = 0
        var tail = coreTail
        while head < tail {
            let cur = queue[head]
            head += 1
            let label = labels[cur]
            let curD = distSq[cur]
            let cx = cur % width
            let cy = (cur - cx) / width
            if cx > 0 {
                let nb = cur - 1
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                    labels[nb] = label
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cx + 1 < width {
                let nb = cur + 1
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                    labels[nb] = label
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cy > 0 {
                let nb = cur - width
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                    labels[nb] = label
                    queue[tail] = nb
                    tail += 1
                }
            }
            if cy + 1 < height {
                let nb = cur + width
                if unfilled[nb] == 1 && labels[nb] == 0 && distSq[nb] <= rSq && distSq[nb] <= curD {
                    labels[nb] = label
                    queue[tail] = nb
                    tail += 1
                }
            }
        }
    }

    if nextLabel == 0 { return [] }

    var counts = [Int](repeating: 0, count: nextLabel + 1)
    var sumX = [Double](repeating: 0, count: nextLabel + 1)
    var sumY = [Double](repeating: 0, count: nextLabel + 1)
    var minX = [Int](repeating: width, count: nextLabel + 1)
    var minY = [Int](repeating: height, count: nextLabel + 1)
    var maxX = [Int](repeating: -1, count: nextLabel + 1)
    var maxY = [Int](repeating: -1, count: nextLabel + 1)
    var edge = [UInt8](repeating: 0, count: nextLabel + 1)
    var bestIdx = [Int](repeating: -1, count: nextLabel + 1)
    var bestDist = [Double](repeating: -1, count: nextLabel + 1)

    for y in 0..<height {
        let row = y * width
        for x in 0..<width {
            let idx = row + x
            let l = labels[idx]
            if l == 0 { continue }
            counts[l] += 1
            sumX[l] += Double(x)
            sumY[l] += Double(y)
            if x < minX[l] { minX[l] = x }
            if y < minY[l] { minY[l] = y }
            if x > maxX[l] { maxX[l] = x }
            if y > maxY[l] { maxY[l] = y }
            if x == 0 || y == 0 || x == width - 1 || y == height - 1 { edge[l] = 1 }
            let d = distSq[idx]
            if d > bestDist[l] {
                bestDist[l] = d
                bestIdx[l] = idx
            }
        }
    }

    var out: [UnfilledRegion] = []
    for l in 1...nextLabel {
        let count = counts[l]
        if count < minArea { continue }
        let touchesEdge = edge[l] == 1
        if !includeEdge && touchesEdge { continue }
        let cx = Int(JS.round(sumX[l] / Double(count)))
        let cy = Int(JS.round(sumY[l] / Double(count)))
        let cIdx = cy * width + cx
        var px = cx
        var py = cy
        if cx < 0 || cy < 0 || cx >= width || cy >= height || labels[cIdx] != l || distSq[cIdx] <= rSq {
            let bi = bestIdx[l]
            px = bi % width
            py = (bi - px) / width
        }
        out.append(UnfilledRegion(
            point: (x: px, y: py),
            centroid: (x: cx, y: cy),
            bounds: RasterRect(x: minX[l], y: minY[l], width: maxX[l] - minX[l] + 1, height: maxY[l] - minY[l] + 1),
            pixelCount: count,
            touchesEdge: touchesEdge
        ))
    }

    out.sort { a, b in
        if b.pixelCount != a.pixelCount { return b.pixelCount < a.pixelCount }
        if a.bounds.y != b.bounds.y { return a.bounds.y < b.bounds.y }
        return a.bounds.x < b.bounds.x
    }
    return Array(out.prefix(maxRegions))
}
