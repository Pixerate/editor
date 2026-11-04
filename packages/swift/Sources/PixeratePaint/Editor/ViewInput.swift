import Foundation
import PixerateCore
import PixerateRaster

/*
 * The view maths and pen input helpers a canvas view needs (`paint-editor/view.ts`, `input.ts`),
 * and the guide lines it draws over the canvas (`guides.ts`). UI-free: the SwiftUI canvas in
 * `PixeratePaintUI` maps its events into `PaintPointerSample`s and calls these.
 */

/// Document → screen for a canvas shown in a viewport of `width × height` points (`viewMatrix`).
public func paintViewMatrix(_ view: PaintView, _ canvas: PaintCanvas, viewport width: Double, _ height: Double) -> Affine {
    viewMatrix(view, canvas, width, height)
}

/// Screen position (viewport points, origin top-left) → document position.
public func screenToDocument(_ view: PaintView, _ canvas: PaintCanvas, viewport width: Double, _ height: Double, _ x: Double, _ y: Double) -> Point2 {
    let m = viewMatrix(view, canvas, width, height)
    guard let inv = try? invertAffine(m) else { return Point2(x: x, y: y) }
    let p = applyAffine(inv, x, y)
    return Point2(x: p.x, y: p.y)
}

/// Document position → screen position.
public func documentToScreen(_ view: PaintView, _ canvas: PaintCanvas, viewport width: Double, _ height: Double, _ x: Double, _ y: Double) -> Point2 {
    let p = applyAffine(viewMatrix(view, canvas, width, height), x, y)
    return Point2(x: p.x, y: p.y)
}

/// The zoom that fits the canvas in the viewport (with `margin` points around it).
public func fitZoom(_ canvas: PaintCanvas, viewport width: Double, _ height: Double, margin: Double = 24) -> Double {
    let w = Swift.max(1, width - 2 * margin)
    let h = Swift.max(1, height - 2 * margin)
    return Swift.min(MAX_ZOOM, Swift.max(MIN_ZOOM, Swift.min(w / Double(canvas.width), h / Double(canvas.height))))
}

/// `a % b` (JavaScript remainder).
private func viewMod(_ a: Double, _ b: Double) -> Double { a.truncatingRemainder(dividingBy: b) }

/**
 * Pen rotation as the document sees it: a rotated or mirrored view turns the pen's azimuth and
 * barrel rotation too, so a tilted pencil shades the same way on screen however the canvas is turned.
 */
public func viewPenToDocument(_ view: PaintView, _ p: PenPoint) -> PenPoint {
    if view.rotation == 0 && !view.mirror { return p }
    var out = p
    let r = (view.rotation * Double.pi) / 180
    if let az = p.azimuth {
        var a = az - r
        if view.mirror { a = Double.pi - a }
        out.azimuth = viewMod(viewMod(a, 2 * Double.pi) + 2 * Double.pi, 2 * Double.pi)
    }
    if let tw = p.twist {
        var t = tw - view.rotation
        if view.mirror { t = -t }
        out.twist = viewMod(viewMod(t, 360) + 360, 360)
    }
    return out
}

/// The pointer fields the paint editor reads (Pointer Events' names; `PointerSample` in `input.ts`).
public struct PaintPointerSample: Equatable, Sendable {
    /// `mouse`, `pen` or `touch`.
    public var pointerType: String
    /// 0..1 (pens); mice report 0.5 while pressed.
    public var pressure: Double?
    /// Degrees, -90..90.
    public var tiltX: Double?
    public var tiltY: Double?
    /// Radians: 0 lying flat, π/2 upright.
    public var altitudeAngle: Double?
    /// Radians, clockwise from the x axis (screen y down).
    public var azimuthAngle: Double?
    /// Degrees 0..359.
    public var twist: Double?
    /// Milliseconds.
    public var timeStamp: Double?
    public init(pointerType: String, pressure: Double? = nil, tiltX: Double? = nil, tiltY: Double? = nil, altitudeAngle: Double? = nil, azimuthAngle: Double? = nil, twist: Double? = nil, timeStamp: Double? = nil) {
        self.pointerType = pointerType
        self.pressure = pressure
        self.tiltX = tiltX
        self.tiltY = tiltY
        self.altitudeAngle = altitudeAngle
        self.azimuthAngle = azimuthAngle
        self.twist = twist
        self.timeStamp = timeStamp
    }
}

/// Pressure of a pointer sample: pens report it; mice (0.5 while pressed) and pens at 0 mean full.
public func samplePressure(_ e: PaintPointerSample) -> Double {
    if e.pointerType == "pen", let p = e.pressure, p > 0 { return Swift.min(1, p) }
    return 1
}

/**
 * A pointer sample at document position (x, y) as a pen point (`pointerToPenPoint`). Only pens
 * report tilt and twist; a pen's lean and barrel rotation are turned with the view.
 */
public func pointerToPenPoint(_ e: PaintPointerSample, _ x: Double, _ y: Double, view: PaintView? = nil) -> PenPoint {
    var p = PenPoint(x: x, y: y, pressure: samplePressure(e))
    if let t = e.timeStamp, t.isFinite { p.t = t }
    if e.pointerType != "pen" { return p }
    let o = penOrientation(PenPoint(x: x, y: y, tiltX: e.tiltX, tiltY: e.tiltY, altitude: e.altitudeAngle, azimuth: e.azimuthAngle))
    // A pen standing straight up with no tilt reported keeps no orientation.
    if let o, o.altitude < Double.pi / 2 - 1e-6 {
        p.altitude = o.altitude
        p.azimuth = o.azimuth
    }
    if let tw = e.twist, tw.isFinite, tw != 0 { p.twist = tw }
    return view.map { viewPenToDocument($0, p) } ?? p
}

/**
 * Palm rejection: whether a touch at `touch` (screen points) is probably the drawing hand resting
 * on the screen while the pen is at `pen`. A right hand rests below and to the right of the pen.
 */
public func isPalmTouch(_ touch: Point2, _ pen: Point2?, hand: String) -> Bool {
    guard let pen else { return false }
    let dx = touch.x - pen.x
    let dy = touch.y - pen.y
    let side = hand == "right" ? dx : -dx
    return dy > -40 && side > -40 && JS.hypot(dx, dy) < 600
}

// MARK: - Guide lines

/// The symmetry guide's axes clipped to the canvas, as segments in document pixels.
public func symmetryAxisSegments(_ g: SymmetryGuide, _ size: PaintCanvas) -> [(Point2, Point2)] {
    var out: [(Point2, Point2)] = []
    for a in symmetryAxisAngles(g) {
        let d = [JS.cos(a), JS.sin(a)]
        let origin = [g.center.x, g.center.y]
        let extent = [Double(size.width), Double(size.height)]
        var lo = -Double.infinity, hi = Double.infinity
        var ok = true
        for i in 0..<2 {
            if abs(d[i]) < 1e-12 {
                if origin[i] < 0 || origin[i] > extent[i] { ok = false }
            } else {
                let t0 = -origin[i] / d[i], t1 = (extent[i] - origin[i]) / d[i]
                lo = Swift.max(lo, Swift.min(t0, t1))
                hi = Swift.min(hi, Swift.max(t0, t1))
            }
        }
        if !ok || !lo.isFinite || !hi.isFinite || hi < lo { continue }
        out.append((Point2(x: g.center.x + lo * d[0], y: g.center.y + lo * d[1]), Point2(x: g.center.x + hi * d[0], y: g.center.y + hi * d[1])))
    }
    return out
}

/// Fans of lines from each vanishing point across the canvas (`count` per point).
public func perspectiveGuideLines(_ g: PerspectiveGuide, _ size: PaintCanvas, count: Int = 12) -> [(Point2, Point2)] {
    var out: [(Point2, Point2)] = []
    let w = Double(size.width), h = Double(size.height)
    let far = JS.hypot(w, h) * 4
    for v in g.points {
        // Aim the fan at the canvas: spread around the direction to its centre.
        let cx = w / 2 - v.x, cy = h / 2 - v.y
        let inside = v.x >= 0 && v.y >= 0 && v.x <= w && v.y <= h
        let mid = JS.atan2(cy, cx)
        let spread = inside ? Double.pi : Swift.min(Double.pi, 2 * JS.atan2(JS.hypot(w, h) / 2, JS.hypot(cx, cy)))
        for i in 0..<count {
            let a = inside ? (2 * Double.pi * Double(i)) / Double(count) : mid - spread / 2 + (spread * (Double(i) + 0.5)) / Double(count)
            out.append((v, Point2(x: v.x + JS.cos(a) * far, y: v.y + JS.sin(a) * far)))
        }
    }
    return out
}

/// A stencil's outline as a polyline in document pixels.
public func stencilOutlinePoints(_ s: Stencil) -> [Point2] { stencilOutline(s) }
