import Foundation
import PixerateCore
import PixerateRaster

/**
 * 2D vector field displacement and single-pass premultiplied bilinear / nearest resampling
 * (`paint/displacement.ts`).
 */

/// A 2D vector field defined on a regular coarse grid (`step` pixels between samples) covering `rect`.
public struct DisplacementField: Sendable {
    public var rect: RasterRect
    public var step: Int
    public var cols: Int
    public var rows: Int
    public var dx: [Float]
    public var dy: [Float]
    public var maxDisplacement: Double

    public init(rect: RasterRect, step: Int, cols: Int, rows: Int, dx: [Float], dy: [Float], maxDisplacement: Double) {
        self.rect = rect
        self.step = step
        self.cols = cols
        self.rows = rows
        self.dx = dx
        self.dy = dy
        self.maxDisplacement = maxDisplacement
    }
}

/// A 2D forward velocity field on a coarse grid (`step` pixels between samples) covering `rect`.
public struct VelocityGridField: Sendable {
    public var rect: RasterRect
    public var step: Int
    public var cols: Int
    public var rows: Int
    public var vx: [Float]
    public var vy: [Float]
    public var maxSpeed: Double

    public init(rect: RasterRect, step: Int, cols: Int, rows: Int, vx: [Float], vy: [Float], maxSpeed: Double) {
        self.rect = rect
        self.step = step
        self.cols = cols
        self.rows = rows
        self.vx = vx
        self.vy = vy
        self.maxSpeed = maxSpeed
    }
}

/// Creates an empty `DisplacementField` covering `rect` at spacing `step` (1..4 px).
public func createDisplacementField(_ rect: RasterRect, _ step: Int) -> DisplacementField {
    let s = Swift.max(1, Swift.min(4, step))
    let cols = Swift.max(2, Int(ceil(Double(rect.width) / Double(s))) + 1)
    let rows = Swift.max(2, Int(ceil(Double(rect.height) / Double(s))) + 1)
    return DisplacementField(
        rect: RasterRect(x: rect.x, y: rect.y, width: (cols - 1) * s, height: (rows - 1) * s),
        step: s,
        cols: cols,
        rows: rows,
        dx: [Float](repeating: 0, count: cols * rows),
        dy: [Float](repeating: 0, count: cols * rows),
        maxDisplacement: 0
    )
}

/// Bilinearly samples `(dx, dy)` from `field` at document coordinate `(x, y)`.
/// Outside `field.rect`, returns `(0, 0)`.
@inline(__always)
public func sampleDisplacement(_ field: DisplacementField, _ x: Double, _ y: Double) -> (dx: Double, dy: Double) {
    let gx = (x - Double(field.rect.x)) / Double(field.step)
    let gy = (y - Double(field.rect.y)) / Double(field.step)
    let maxCol = field.cols - 1
    let maxRow = field.rows - 1
    if gx <= 0 || gy <= 0 || gx >= Double(maxCol) || gy >= Double(maxRow) {
        return (0, 0)
    }
    let c0 = Int(floor(gx))
    let r0 = Int(floor(gy))
    let c1 = Swift.min(maxCol, c0 + 1)
    let r1 = Swift.min(maxRow, r0 + 1)
    let tx = gx - Double(c0)
    let ty = gy - Double(r0)
    let omtX = 1.0 - tx
    let omtY = 1.0 - ty
    let i00 = r0 * field.cols + c0
    let i10 = r0 * field.cols + c1
    let i01 = r1 * field.cols + c0
    let i11 = r1 * field.cols + c1
    let w00 = omtX * omtY
    let w10 = tx * omtY
    let w01 = omtX * ty
    let w11 = tx * ty
    let dx = Double(field.dx[i00]) * w00 + Double(field.dx[i10]) * w10 + Double(field.dx[i01]) * w01 + Double(field.dx[i11]) * w11
    let dy = Double(field.dy[i00]) * w00 + Double(field.dy[i10]) * w10 + Double(field.dy[i01]) * w01 + Double(field.dy[i11]) * w11
    return (dx, dy)
}

@inline(__always)
private func sampleGridPair(_ arrX: [Float], _ arrY: [Float], _ cols: Int, _ rows: Int, _ gx: Double, _ gy: Double) -> (Double, Double) {
    let maxCol = cols - 1
    let maxRow = rows - 1
    if gx <= 0 || gy <= 0 || gx >= Double(maxCol) || gy >= Double(maxRow) {
        return (0, 0)
    }
    let c0 = Int(gx)
    let r0 = Int(gy)
    let c1 = c0 < maxCol ? c0 + 1 : maxCol
    let r1 = r0 < maxRow ? r0 + 1 : maxRow
    let tx = gx - Double(c0)
    let ty = gy - Double(r0)
    let omtX = 1.0 - tx
    let omtY = 1.0 - ty
    let i00 = r0 * cols + c0
    let i10 = i00 + (c1 - c0)
    let i01 = r1 * cols + c0
    let i11 = i01 + (c1 - c0)
    let w00 = omtX * omtY
    let w10 = tx * omtY
    let w01 = omtX * ty
    let w11 = tx * ty
    let x = Double(arrX[i00]) * w00 + Double(arrX[i10]) * w10 + Double(arrX[i01]) * w01 + Double(arrX[i11]) * w11
    let y = Double(arrY[i00]) * w00 + Double(arrY[i10]) * w10 + Double(arrY[i01]) * w01 + Double(arrY[i11]) * w11
    return (x, y)
}

/// Most sub-steps `integrateVelocityField` takes; beyond it each sub-step moves further.
public let MAX_INTEGRATION_STEPS = 960

/// Integrates a forward velocity field `vel` over `totalTravel` pixels into a single backward
/// displacement field `D` in fixed sub-steps `D'(x) = D(x + v(x)) + v(x)`. Sub-steps move at most
/// `maxSubStepPx` each, unless that would take more than `MAX_INTEGRATION_STEPS`: then they are
/// longer, and the full travel is kept.
public func integrateVelocityField(_ vel: VelocityGridField, _ totalTravel: Double, maxSubStepPx: Double? = nil) -> DisplacementField {
    let rect = vel.rect
    let step = vel.step
    let cols = vel.cols
    let rows = vel.rows
    let vx = vel.vx
    let vy = vel.vy
    let maxSpeed = vel.maxSpeed
    let count = cols * rows
    var dx = [Float](repeating: 0, count: count)
    var dy = [Float](repeating: 0, count: count)
    if totalTravel <= 1e-5 || maxSpeed <= 1e-6 {
        return DisplacementField(rect: rect, step: step, cols: cols, rows: rows, dx: dx, dy: dy, maxDisplacement: 0)
    }

    // As many sub-steps as the fastest cell needs to move at most `maxSubStepPx` each, up to
    // MAX_INTEGRATION_STEPS; past that the sub-steps grow instead, so the travel is never clipped
    // (a big tip with many turns still turns that many times).
    let maxSub = maxSubStepPx ?? Swift.max(0.5, Double(step) * 0.45)
    let totalPeakDisp = totalTravel * maxSpeed
    let steps = Swift.max(4, Swift.min(MAX_INTEGRATION_STEPS, Int(ceil(totalPeakDisp / maxSub))))
    let dt = totalTravel / Double(steps)
    let stepCap = Swift.max(maxSub, totalPeakDisp / Double(steps))
    let invStep = 1.0 / Double(step)

    var stepX = [Float](repeating: 0, count: count)
    var stepY = [Float](repeating: 0, count: count)
    for r in 0..<rows {
        for c in 0..<cols {
            let idx = r * cols + c
            var bx = -Double(vx[idx]) * dt
            var by = -Double(vy[idx]) * dt
            let mag0 = hypot(bx, by)
            if mag0 > 1e-6 {
                if mag0 > stepCap {
                    let s = stepCap / mag0
                    bx *= s
                    by *= s
                }
                let midC = Double(c) + bx * 0.5 * invStep
                let midR = Double(r) + by * 0.5 * invStep
                let (tvx, tvy) = sampleGridPair(vx, vy, cols, rows, midC, midR)
                bx = -tvx * dt
                by = -tvy * dt
                let mag1 = hypot(bx, by)
                if mag1 > stepCap {
                    let s = stepCap / mag1
                    bx *= s
                    by *= s
                }
            }
            stepX[idx] = Float(bx)
            stepY[idx] = Float(by)
        }
    }

    var nextDx = [Float](repeating: 0, count: count)
    var nextDy = [Float](repeating: 0, count: count)

    for _ in 0..<steps {
        for r in 0..<rows {
            for c in 0..<cols {
                let idx = r * cols + c
                let sx = Double(stepX[idx])
                let sy = Double(stepY[idx])
                if sx == 0 && sy == 0 {
                    nextDx[idx] = dx[idx]
                    nextDy[idx] = dy[idx]
                    continue
                }
                let qc = Double(c) + sx * invStep
                let qr = Double(r) + sy * invStep
                let (tdx, tdy) = sampleGridPair(dx, dy, cols, rows, qc, qr)
                nextDx[idx] = Float(tdx + sx)
                nextDy[idx] = Float(tdy + sy)
            }
        }
        swap(&dx, &nextDx)
        swap(&dy, &nextDy)
    }

    var maxDisplacement = 0.0
    for i in 0..<count {
        let m = hypot(Double(dx[i]), Double(dy[i]))
        if m > maxDisplacement { maxDisplacement = m }
    }

    return DisplacementField(rect: rect, step: step, cols: cols, rows: rows, dx: dx, dy: dy, maxDisplacement: maxDisplacement)
}

/// Composes two backward displacement fields `first` followed by `second` onto a grid covering their
/// union: `D(x) = first(x + second(x)) + second(x)`.
public func composeDisplacementFields(_ first: DisplacementField, _ second: DisplacementField) -> DisplacementField {
    let step = Swift.min(first.step, second.step)
    let x0 = Swift.min(first.rect.x, second.rect.x)
    let y0 = Swift.min(first.rect.y, second.rect.y)
    let x1 = Swift.max(first.rect.x + first.rect.width, second.rect.x + second.rect.width)
    let y1 = Swift.max(first.rect.y + first.rect.height, second.rect.y + second.rect.height)
    var out = createDisplacementField(RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0), step)
    var maxDisp = 0.0
    for r in 0..<out.rows {
        let y = Double(out.rect.y + r * out.step)
        for c in 0..<out.cols {
            let x = Double(out.rect.x + c * out.step)
            let idx = r * out.cols + c
            let s2 = sampleDisplacement(second, x, y)
            let s1 = sampleDisplacement(first, x + s2.dx, y + s2.dy)
            let dx = s1.dx + s2.dx
            let dy = s1.dy + s2.dy
            out.dx[idx] = Float(dx)
            out.dy[idx] = Float(dy)
            let m = hypot(dx, dy)
            if m > maxDisp { maxDisp = m }
        }
    }
    out.maxDisplacement = maxDisp
    return out
}

public struct WarpSurfaceOptions {
    public var scale: Double
    public var offset: LayerOffset
    public var clip: (width: Int, height: Int)?
    public var selection: PaintSelection?
    public var lockTransparency: Bool

    public init(scale: Double = 1.0, offset: LayerOffset = LayerOffset(x: 0, y: 0), clip: (width: Int, height: Int)? = nil, selection: PaintSelection? = nil, lockTransparency: Bool = false) {
        self.scale = scale
        self.offset = offset
        self.clip = clip
        self.selection = selection
        self.lockTransparency = lockTransparency
    }
}

/// Samples straight-alpha RGBA from `src` (`srcW × srcH`) at `(sx, sy)` (relative to `srcX, srcY`)
/// using premultiplied bilinear interpolation so transparent neighbours never bleed dark fringes.
@inline(__always)
public func sampleRgbaPremultiplied(
    _ src: [UInt8],
    _ srcX: Int,
    _ srcY: Int,
    _ srcW: Int,
    _ srcH: Int,
    _ sx: Double,
    _ sy: Double
) -> (UInt8, UInt8, UInt8, UInt8) {
    let lx = sx - Double(srcX)
    let ly = sy - Double(srcY)
    if lx < 0 || ly < 0 || lx > Double(srcW - 1) || ly > Double(srcH - 1) {
        let cx = Swift.max(0, Swift.min(srcW - 1, Int(JS.round(lx))))
        let cy = Swift.max(0, Swift.min(srcH - 1, Int(JS.round(ly))))
        if lx < -0.5 || ly < -0.5 || lx > Double(srcW) - 0.5 || ly > Double(srcH) - 0.5 {
            return (0, 0, 0, 0)
        }
        let idx = (cy * srcW + cx) * 4
        return (src[idx], src[idx + 1], src[idx + 2], src[idx + 3])
    }
    let x0 = Int(lx)
    let y0 = Int(ly)
    let x1 = x0 < srcW - 1 ? x0 + 1 : x0
    let y1 = y0 < srcH - 1 ? y0 + 1 : y0
    let tx = lx - Double(x0)
    let ty = ly - Double(y0)
    let w00 = (1.0 - tx) * (1.0 - ty)
    let w10 = tx * (1.0 - ty)
    let w01 = (1.0 - tx) * ty
    let w11 = tx * ty

    let i00 = (y0 * srcW + x0) * 4
    let i10 = (y0 * srcW + x1) * 4
    let i01 = (y1 * srcW + x0) * 4
    let i11 = (y1 * srcW + x1) * 4

    let a00 = Double(src[i00 + 3]) * w00
    let a10 = Double(src[i10 + 3]) * w10
    let a01 = Double(src[i01 + 3]) * w01
    let a11 = Double(src[i11 + 3]) * w11
    let aSum = a00 + a10 + a01 + a11
    if aSum <= 0.001 {
        return (0, 0, 0, 0)
    }
    let invA = 1.0 / aSum
    let r = UInt8(clamping: Int(JS.round((Double(src[i00]) * a00 + Double(src[i10]) * a10 + Double(src[i01]) * a01 + Double(src[i11]) * a11) * invA)))
    let g = UInt8(clamping: Int(JS.round((Double(src[i00 + 1]) * a00 + Double(src[i10 + 1]) * a10 + Double(src[i01 + 1]) * a01 + Double(src[i11 + 1]) * a11) * invA)))
    let b = UInt8(clamping: Int(JS.round((Double(src[i00 + 2]) * a00 + Double(src[i10 + 2]) * a10 + Double(src[i01 + 2]) * a01 + Double(src[i11 + 2]) * a11) * invA)))
    let a = UInt8(clamping: Int(JS.round(aSum)))
    return (r, g, b, a)
}

/// Resamples an RGBA `TiledSurface` once through `field` using premultiplied bilinear sampling.
public func warpTiledSurfaceRgba(
    _ source: TiledSurface,
    _ field: DisplacementField,
    _ options: WarpSurfaceOptions = WarpSurfaceOptions()
) -> (surface: TiledSurface, touchedKeys: [TileKey], changedPixels: Int, bounds: RasterRect?) {
    let scale = options.scale
    if field.maxDisplacement * abs(scale) <= 1e-4 {
        return (source, [], 0, nil)
    }
    let offX = options.offset.x
    let offY = options.offset.y
    let dstX0 = options.clip != nil ? Swift.max(0, field.rect.x) : field.rect.x
    let dstY0 = options.clip != nil ? Swift.max(0, field.rect.y) : field.rect.y
    let dstX1 = options.clip.map { Swift.min($0.width, field.rect.x + field.rect.width) } ?? (field.rect.x + field.rect.width)
    let dstY1 = options.clip.map { Swift.min($0.height, field.rect.y + field.rect.height) } ?? (field.rect.y + field.rect.height)
    if dstX1 <= dstX0 || dstY1 <= dstY0 {
        return (source, [], 0, nil)
    }
    let dstRect = RasterRect(x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0)
    let pad = Int(ceil(field.maxDisplacement * abs(scale))) + 2
    let srcX0 = dstX0 - pad
    let srcY0 = dstY0 - pad
    let srcW = dstRect.width + pad * 2
    let srcH = dstRect.height + pad * 2
    let srcBuf = readRegion(source, RasterRect(x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH))

    var anyOpaque = false
    var ai = 3
    while ai < srcBuf.count {
        if srcBuf[ai] > 0 {
            anyOpaque = true
            break
        }
        ai += 4
    }
    if !anyOpaque {
        return (source, [], 0, nil)
    }

    var dstBuf = [UInt8](repeating: 0, count: dstRect.width * dstRect.height * 4)
    let sel = options.selection
    let lockAlpha = options.lockTransparency
    var changedPixels = 0
    var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min

    for row in 0..<dstRect.height {
        let y = dstY0 + row
        let srcRowOff = (y - srcY0) * srcW
        let dstRowOff = row * dstRect.width
        for col in 0..<dstRect.width {
            let x = dstX0 + col
            let origIdx = (srcRowOff + (x - srcX0)) * 4
            let dstIdx = (dstRowOff + col) * 4
            let r0 = srcBuf[origIdx]
            let g0 = srcBuf[origIdx + 1]
            let b0 = srcBuf[origIdx + 2]
            let a0 = srcBuf[origIdx + 3]

            var selWeight = 1.0
            if let sel {
                if x < 0 || y < 0 || x >= sel.width || y >= sel.height {
                    selWeight = 0
                } else {
                    selWeight = Double(sel.data[y * sel.width + x]) / 255.0
                }
            }
            if selWeight <= 0 {
                dstBuf[dstIdx] = r0
                dstBuf[dstIdx + 1] = g0
                dstBuf[dstIdx + 2] = b0
                dstBuf[dstIdx + 3] = a0
                continue
            }

            let d = sampleDisplacement(field, Double(x), Double(y))
            let dx = d.dx * scale
            let dy = d.dy * scale
            if abs(dx) <= 1e-4 && abs(dy) <= 1e-4 {
                dstBuf[dstIdx] = r0
                dstBuf[dstIdx + 1] = g0
                dstBuf[dstIdx + 2] = b0
                dstBuf[dstIdx + 3] = a0
                continue
            }

            let rgba = sampleRgbaPremultiplied(srcBuf, srcX0, srcY0, srcW, srcH, Double(x) + dx, Double(y) + dy)
            var r1 = rgba.0
            var g1 = rgba.1
            var b1 = rgba.2
            var a1 = lockAlpha ? a0 : rgba.3
            if lockAlpha && rgba.3 == 0 {
                r1 = r0
                g1 = g0
                b1 = b0
            }
            if selWeight < 1 {
                r1 = UInt8(clamping: Int(JS.round(Double(r0) + (Double(r1) - Double(r0)) * selWeight)))
                g1 = UInt8(clamping: Int(JS.round(Double(g0) + (Double(g1) - Double(g0)) * selWeight)))
                b1 = UInt8(clamping: Int(JS.round(Double(b0) + (Double(b1) - Double(b0)) * selWeight)))
                a1 = UInt8(clamping: Int(JS.round(Double(a0) + (Double(a1) - Double(a0)) * selWeight)))
            }
            dstBuf[dstIdx] = r1
            dstBuf[dstIdx + 1] = g1
            dstBuf[dstIdx + 2] = b1
            dstBuf[dstIdx + 3] = a1
            if r1 != r0 || g1 != g0 || b1 != b0 || a1 != a0 {
                changedPixels += 1
                if x < minX { minX = x }
                if y < minY { minY = y }
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
            }
        }
    }

    if changedPixels == 0 {
        return (source, [], 0, nil)
    }

    let localDstRect = RasterRect(x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height)
    let nextSurface = writeRegion(source, localDstRect, dstBuf)
    let touchedKeys = tilesInRect(localDstRect).map { tileKey($0.tx, $0.ty) }
    let bounds = RasterRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    return (nextSurface, touchedKeys, changedPixels, bounds)
}

/// Resamples a single-channel (`channels == 1`) `TiledSurface` once through `field` using bilinear sampling.
public func warpTiledSurfaceChannel(
    _ source: TiledSurface,
    _ field: DisplacementField,
    _ options: WarpSurfaceOptions = WarpSurfaceOptions()
) -> (surface: TiledSurface, touchedKeys: [TileKey], bounds: RasterRect?) {
    let scale = options.scale
    if source.tileCount == 0 || field.maxDisplacement * abs(scale) <= 1e-4 {
        return (source, [], nil)
    }
    let offX = options.offset.x
    let offY = options.offset.y
    let dstX0 = options.clip != nil ? Swift.max(0, field.rect.x) : field.rect.x
    let dstY0 = options.clip != nil ? Swift.max(0, field.rect.y) : field.rect.y
    let dstX1 = options.clip.map { Swift.min($0.width, field.rect.x + field.rect.width) } ?? (field.rect.x + field.rect.width)
    let dstY1 = options.clip.map { Swift.min($0.height, field.rect.y + field.rect.height) } ?? (field.rect.y + field.rect.height)
    if dstX1 <= dstX0 || dstY1 <= dstY0 { return (source, [], nil) }
    let dstRect = RasterRect(x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0)
    let pad = Int(ceil(field.maxDisplacement * abs(scale))) + 2
    let srcX0 = dstX0 - pad
    let srcY0 = dstY0 - pad
    let srcW = dstRect.width + pad * 2
    let srcH = dstRect.height + pad * 2
    let srcBuf = readRegion(source, RasterRect(x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH))
    var dstBuf = [UInt8](repeating: 0, count: dstRect.width * dstRect.height)
    let sel = options.selection
    var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min

    for row in 0..<dstRect.height {
        let y = dstY0 + row
        for col in 0..<dstRect.width {
            let x = dstX0 + col
            let v0 = srcBuf[(y - srcY0) * srcW + (x - srcX0)]
            let dstIdx = row * dstRect.width + col
            if let sel, x < 0 || y < 0 || x >= sel.width || y >= sel.height || sel.data[y * sel.width + x] == 0 {
                dstBuf[dstIdx] = v0
                continue
            }
            let d = sampleDisplacement(field, Double(x), Double(y))
            let sx = Double(x) + d.dx * scale - Double(srcX0)
            let sy = Double(y) + d.dy * scale - Double(srcY0)
            var v1: UInt8 = 0
            if sx >= 0 && sy >= 0 && sx < Double(srcW - 1) && sy < Double(srcH - 1) {
                let x0 = Int(sx)
                let y0 = Int(sy)
                let tx = sx - Double(x0)
                let ty = sy - Double(y0)
                let i00 = y0 * srcW + x0
                let v =
                    Double(srcBuf[i00]) * (1.0 - tx) * (1.0 - ty) +
                    Double(srcBuf[i00 + 1]) * tx * (1.0 - ty) +
                    Double(srcBuf[i00 + srcW]) * (1.0 - tx) * ty +
                    Double(srcBuf[i00 + srcW + 1]) * tx * ty
                v1 = UInt8(clamping: Int(JS.round(v)))
            }
            dstBuf[dstIdx] = v1
            if v1 != v0 {
                if x < minX { minX = x }
                if y < minY { minY = y }
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
            }
        }
    }
    if minX == Int.max { return (source, [], nil) }
    let localDstRect = RasterRect(x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height)
    let nextSurface = writeRegion(source, localDstRect, dstBuf)
    let touchedKeys = tilesInRect(localDstRect).map { tileKey($0.tx, $0.ty) }
    return (nextSurface, touchedKeys, RasterRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
}

/// Resamples an RGBA `TiledSurface` where bytes encode discrete or un-premultiplied packed state
/// (such as impasto `material` where `A = 0` means "no material", or `film`) using nearest-neighbour sampling.
public func warpTiledSurfaceNearest(
    _ source: TiledSurface,
    _ field: DisplacementField,
    _ options: WarpSurfaceOptions = WarpSurfaceOptions()
) -> (surface: TiledSurface, touchedKeys: [TileKey], bounds: RasterRect?) {
    let scale = options.scale
    if source.tileCount == 0 || field.maxDisplacement * abs(scale) <= 1e-4 {
        return (source, [], nil)
    }
    let offX = options.offset.x
    let offY = options.offset.y
    let dstX0 = options.clip != nil ? Swift.max(0, field.rect.x) : field.rect.x
    let dstY0 = options.clip != nil ? Swift.max(0, field.rect.y) : field.rect.y
    let dstX1 = options.clip.map { Swift.min($0.width, field.rect.x + field.rect.width) } ?? (field.rect.x + field.rect.width)
    let dstY1 = options.clip.map { Swift.min($0.height, field.rect.y + field.rect.height) } ?? (field.rect.y + field.rect.height)
    if dstX1 <= dstX0 || dstY1 <= dstY0 { return (source, [], nil) }
    let dstRect = RasterRect(x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0)
    let pad = Int(ceil(field.maxDisplacement * abs(scale))) + 2
    let srcX0 = dstX0 - pad
    let srcY0 = dstY0 - pad
    let srcW = dstRect.width + pad * 2
    let srcH = dstRect.height + pad * 2
    let srcBuf = readRegion(source, RasterRect(x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH))
    var dstBuf = [UInt8](repeating: 0, count: dstRect.width * dstRect.height * 4)
    let sel = options.selection
    var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min

    for row in 0..<dstRect.height {
        let y = dstY0 + row
        for col in 0..<dstRect.width {
            let x = dstX0 + col
            let origIdx = ((y - srcY0) * srcW + (x - srcX0)) * 4
            let dstIdx = (row * dstRect.width + col) * 4
            let r0 = srcBuf[origIdx]
            let g0 = srcBuf[origIdx + 1]
            let b0 = srcBuf[origIdx + 2]
            let a0 = srcBuf[origIdx + 3]
            if let sel, x < 0 || y < 0 || x >= sel.width || y >= sel.height || sel.data[y * sel.width + x] == 0 {
                dstBuf[dstIdx] = r0
                dstBuf[dstIdx + 1] = g0
                dstBuf[dstIdx + 2] = b0
                dstBuf[dstIdx + 3] = a0
                continue
            }
            let d = sampleDisplacement(field, Double(x), Double(y))
            let sx = Int(JS.round(Double(x) + d.dx * scale - Double(srcX0)))
            let sy = Int(JS.round(Double(y) + d.dy * scale - Double(srcY0)))
            var r1: UInt8 = 0, g1: UInt8 = 0, b1: UInt8 = 0, a1: UInt8 = 0
            if sx >= 0 && sy >= 0 && sx < srcW && sy < srcH {
                let sIdx = (sy * srcW + sx) * 4
                r1 = srcBuf[sIdx]
                g1 = srcBuf[sIdx + 1]
                b1 = srcBuf[sIdx + 2]
                a1 = srcBuf[sIdx + 3]
            }
            dstBuf[dstIdx] = r1
            dstBuf[dstIdx + 1] = g1
            dstBuf[dstIdx + 2] = b1
            dstBuf[dstIdx + 3] = a1
            if r1 != r0 || g1 != g0 || b1 != b0 || a1 != a0 {
                if x < minX { minX = x }
                if y < minY { minY = y }
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
            }
        }
    }
    if minX == Int.max { return (source, [], nil) }
    let localDstRect = RasterRect(x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height)
    let nextSurface = writeRegion(source, localDstRect, dstBuf)
    let touchedKeys = tilesInRect(localDstRect).map { tileKey($0.tx, $0.ty) }
    return (nextSurface, touchedKeys, RasterRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
}
