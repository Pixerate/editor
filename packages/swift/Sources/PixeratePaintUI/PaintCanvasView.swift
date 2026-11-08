import PixerateCore
import PixeratePaint
import PixerateRaster
import SwiftUI
#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/**
 * The painting (`PaintCanvas`): the controller's composite drawn with the view's zoom, pan,
 * rotation and mirroring (pixels are never resampled into the document), the guides, the picked
 * stroke's box and the predicted tail of a stroke over it. The composite is one image per tile
 * (`PaintCanvasPresenter`), drawn as Core Animation layers (`PaintTilesView`) so only the tiles
 * that changed are rebuilt and uploaded; stills (`interactive: false`) draw them through SwiftUI. Input goes through `PaintGesture`: the mouse, trackpad and
 * tablet pens on macOS (scroll pans, pinch zooms, rotate turns the view); touch and Apple Pencil
 * on iOS, with force, altitude, azimuth, roll and coalesced and predicted touches.
 */
public struct PaintCanvasView: View {
    private let model: PaintEditorModel
    @State private var presenter: PaintCanvasPresenter
    /// Draw the guides, picked stroke and predicted tail (default true).
    private let showGuides: Bool
    /// Take pointer input (default true). Off for still images: `ImageRenderer` draws AppKit and UIKit views as placeholders.
    private let interactive: Bool
    /// Follow device tilt (gyroscope on iPhone / iPad) to shift `viewTilt` for thin-film iridescence.
    private let deviceTilt: Bool

    public init(model: PaintEditorModel, showGuides: Bool = true, interactive: Bool = true, deviceTilt: Bool = false) {
        self.model = model
        self.showGuides = showGuides
        self.interactive = interactive
        self.deviceTilt = deviceTilt
        _presenter = State(initialValue: PaintCanvasPresenter(controller: model.controller))
    }

    public var body: some View {
        // Reading `revision` redraws the canvas after every change.
        let _ = model.revision
        let tiles = presenter.tiles()
        let view = model.view
        let canvas = model.canvas
        let lines = showGuides ? guideLines() : []
        let predicted = model.predicted
        let color = model.color
        let tipSize = model.brush.tip.size
        let water = waterImages(model.waterOverlayTiles)
        GeometryReader { geo in
            let m = paintViewMatrix(view, canvas, viewport: geo.size.width, geo.size.height)
            let t = CGAffineTransform(a: m[0], b: m[2], c: m[1], d: m[3], tx: m[4], ty: m[5])
            let smooth = view.zoom < 2
            ZStack {
                PaintSheetShadowView(width: canvas.width, height: canvas.height, transform: t)
                    .equatable()
                // On screen the tiles are layers, which keep their textures until their images change.
                if interactive { PaintTilesView(tiles: tiles, transform: t, smooth: smooth) }
                Canvas { ctx, _ in
                    // A still (`ImageRenderer` draws no platform views): the tiles through SwiftUI.
                    if !interactive && !tiles.isEmpty {
                        var c = ctx
                        c.concatenate(t)
                        let interpolation: Image.Interpolation = smooth ? .medium : .none
                        for tile in tiles { c.draw(Image(decorative: tile.image, scale: 1).interpolation(interpolation), in: tile.rect) }
                    }
                    // The water overlay (view only): blue where the surface is wet, fainter where the paper is damp.
                    if !water.isEmpty {
                        var c = ctx
                        c.concatenate(t)
                        for (rect, img) in water { c.draw(Image(decorative: img, scale: 1).interpolation(.none), in: rect) }
                    }
                    for line in lines {
                        var p = Path()
                        p.move(to: CGPoint(x: line.from.x, y: line.from.y).applying(t))
                        p.addLine(to: CGPoint(x: line.to.x, y: line.to.y).applying(t))
                        ctx.stroke(p, with: .color(line.color), style: StrokeStyle(lineWidth: 1, dash: line.dashed ? [4, 4] : []))
                    }
                    if predicted.count > 0 {
                        var p = Path()
                        for (i, q) in predicted.enumerated() {
                            let s = CGPoint(x: q.x, y: q.y).applying(t)
                            if i == 0 { p.move(to: s) } else { p.addLine(to: s) }
                        }
                        ctx.stroke(p, with: .color(Color(hex: color).opacity(0.5)), style: StrokeStyle(lineWidth: Swift.max(1, tipSize / 2 * view.zoom), lineCap: .round))
                    }
                }
                .accessibilityLabel("Painting")
                if interactive { PaintInputView(model: model) }
            }
            .onAppear {
                layout(geo.size)
                if deviceTilt { model.deviceTiltEnabled = true }
            }
            .onChange(of: geo.size) { _, size in layout(size) }
            .onChange(of: deviceTilt) { _, on in model.deviceTiltEnabled = on }
        }
        .background(Color(white: 0.17))
        .clipped()
    }

    /// The water overlay tiles as images, in document rectangles.
    private func waterImages(_ tiles: [(tx: Int, ty: Int, data: [UInt8])]) -> [(CGRect, CGImage)] {
        tiles.compactMap { t in
            var px = t.data
            for i in stride(from: 0, to: px.count, by: 4) {
                let a = UInt16(px[i + 3])
                for c in 0..<3 { px[i + c] = UInt8((UInt16(px[i + c]) * a + 127) / 255) }
            }
            guard let provider = CGDataProvider(data: Data(px) as CFData),
                  let img = CGImage(width: TILE, height: TILE, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: TILE * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
            else { return nil }
            return (CGRect(x: t.tx * TILE, y: t.ty * TILE, width: TILE, height: TILE), img)
        }
    }

    private func layout(_ size: CGSize) {
        model.viewport = (Double(size.width), Double(size.height))
        model.fitOnce()
    }

    private struct GuideLine {
        var from: Point2
        var to: Point2
        var color: Color
        var dashed = false
    }

    /// The guide overlay (`guideOverlay`): the picked stroke's box, stencils, symmetry axes and perspective lines.
    private func guideLines() -> [GuideLine] {
        var out: [GuideLine] = []
        let c = model.canvas
        if let id = model.selectedStroke, model.liveStrokes?.contains(where: { $0.id == id }) == true, let area = model.controller.liveStrokeArea(id) {
            let drag = model.strokeDrag
            let dx = drag?.id == id ? drag!.dx : 0, dy = drag?.id == id ? drag!.dy : 0
            let x0 = Double(area.x) + dx, y0 = Double(area.y) + dy, x1 = x0 + Double(area.width), y1 = y0 + Double(area.height)
            let box = [Point2(x: x0, y: y0), Point2(x: x1, y: y0), Point2(x: x1, y: y1), Point2(x: x0, y: y1)]
            for i in 0..<4 { out.append(GuideLine(from: box[i], to: box[(i + 1) % 4], color: .indigo, dashed: true)) }
        }
        let g = model.guides
        for st in g.stencils where st.enabled {
            let line = stencilOutlinePoints(st)
            if line.count > 1 { for i in 0..<(line.count - 1) { out.append(GuideLine(from: line[i], to: line[i + 1], color: .orange)) } }
        }
        for (a, b) in symmetryAxisSegments(g.symmetry, c) { out.append(GuideLine(from: a, to: b, color: .cyan, dashed: true)) }
        if g.perspective.enabled { for (a, b) in perspectiveGuideLines(g.perspective, c, count: 16) { out.append(GuideLine(from: a, to: b, color: .pink.opacity(0.6))) } }
        for m in model.magnets {
            let col: Color = m.strength >= 0 ? .cyan : .orange
            let steps = 24
            for i in 0..<steps {
                let a0 = Double(i) * 2 * .pi / Double(steps)
                let a1 = Double(i + 1) * 2 * .pi / Double(steps)
                out.append(GuideLine(
                    from: Point2(x: m.x + cos(a0) * m.radius, y: m.y + sin(a0) * m.radius),
                    to: Point2(x: m.x + cos(a1) * m.radius, y: m.y + sin(a1) * m.radius),
                    color: col.opacity(0.65),
                    dashed: true
                ))
            }
        }
        if let active = model.controller.activeStroke, active.open, !active.points.isEmpty {
            let b = active.brush
            if b.engine == "vortex" || (b.engine == "wet" && b.wet.tool == "vortex") {
                for seg in vortexGuideSegments(active.points, b) {
                    let isReach = seg.kind == "vortex-reach"
                    out.append(GuideLine(
                        from: seg.from,
                        to: seg.to,
                        color: Color(red: 0.22, green: 0.74, blue: 0.97).opacity(isReach ? 0.5 : 0.95),
                        dashed: isReach
                    ))
                }
            }
        }
        return out
    }
}

extension Color {
    /// A `#rrggbb` colour (black when it can't be read).
    init(hex: String) {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt32(s.prefix(6), radix: 16) ?? 0
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: 1)
    }
}

private struct PaintSheetShadowView: View, Equatable {
    let width: Int
    let height: Int
    let transform: CGAffineTransform

    var body: some View {
        Canvas { ctx, _ in
            var shadow = ctx
            shadow.addFilter(.shadow(color: .black.opacity(0.45), radius: 8))
            shadow.fill(Path(CGRect(x: 0, y: 0, width: width, height: height)).applying(transform), with: .color(.white))
        }
    }
}

// MARK: - Tiles

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
typealias PaintPlatformView = NSView
#else
typealias PaintPlatformView = UIView
#endif

/**
 * The painting's tiles (`PaintCanvasPresenter.tiles()`) as Core Animation layers under the view
 * transform. A layer keeps its texture until its image changes, so a stroke uploads only the
 * tiles it touched. (SwiftUI's `Canvas` uploaded every tile image again each frame.)
 */
struct PaintTilesView {
    let tiles: [PaintCanvasTile]
    /// Document pixels to view points.
    let transform: CGAffineTransform
    /// Smooth sampling (zoomed out); nearest neighbour when false (zoomed in, so pixels stay square).
    let smooth: Bool
}

/// The view holding the tile layers (`PaintTilesView`); it takes no input.
final class PaintTilesLayerView: PaintPlatformView {
    private let content = CALayer()
    private var layers: [TileKey: CALayer] = [:]
    private var order: [TileKey] = []

    init() {
        super.init(frame: .zero)
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        // Layer-hosting, flipped: y runs down as in the document.
        let root = CALayer()
        root.isGeometryFlipped = true
        layer = root
        wantsLayer = true
        #else
        isUserInteractionEnabled = false
        backgroundColor = .clear
        #endif
        content.anchorPoint = .zero
        content.position = .zero
        hostLayer.addSublayer(content)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private var hostLayer: CALayer {
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        layer!
        #else
        layer
        #endif
    }

    #if canImport(AppKit) && !targetEnvironment(macCatalyst)
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    #endif

    /// The tile layers in drawing order, for tests.
    var tileLayers: [CALayer] { order.compactMap { layers[$0] } }

    func update(_ v: PaintTilesView) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if content.affineTransform() != v.transform { content.setAffineTransform(v.transform) }
        let keys = v.tiles.map { tileKey($0.tx, $0.ty) }
        if keys != order {
            // The canvas changed size: new layers, in drawing order.
            for l in layers.values { l.removeFromSuperlayer() }
            layers = [:]
            for key in keys {
                let l = CALayer()
                l.anchorPoint = .zero
                content.addSublayer(l)
                layers[key] = l
            }
            order = keys
        }
        let filter: CALayerContentsFilter = v.smooth ? .linear : .nearest
        let minFilter: CALayerContentsFilter = v.smooth ? .trilinear : .nearest
        for (key, tile) in zip(keys, v.tiles) {
            guard let l = layers[key] else { continue }
            // Only a new image is uploaded again.
            if (l.contents as AnyObject?) !== tile.image { l.contents = tile.image }
            if l.frame != tile.rect { l.frame = tile.rect }
            if l.magnificationFilter != filter { l.magnificationFilter = filter }
            if l.minificationFilter != minFilter { l.minificationFilter = minFilter }
        }
        CATransaction.commit()
    }
}

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
extension PaintTilesView: NSViewRepresentable {
    func makeNSView(context: Context) -> PaintTilesLayerView { PaintTilesLayerView() }
    func updateNSView(_ v: PaintTilesLayerView, context: Context) { v.update(self) }
}
#else
extension PaintTilesView: UIViewRepresentable {
    func makeUIView(context: Context) -> PaintTilesLayerView { PaintTilesLayerView() }
    func updateUIView(_ v: PaintTilesLayerView, context: Context) { v.update(self) }
}
#endif

// MARK: - Input

#if canImport(AppKit) && !targetEnvironment(macCatalyst)

/// Mouse, tablet and trackpad input over the canvas (macOS).
struct PaintInputView: NSViewRepresentable {
    let model: PaintEditorModel

    func makeNSView(context: Context) -> PaintInputNSView {
        let v = PaintInputNSView()
        v.model = model
        return v
    }

    func updateNSView(_ v: PaintInputNSView, context: Context) { v.model = model }
}

final class PaintInputNSView: NSView {
    var model: PaintEditorModel?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// An AppKit mouse event as a pointer event: tablet events (`subtype == .tabletPoint`) are pens with pressure, tilt and rotation.
    private func pointer(_ e: NSEvent, button: Int = 0) -> PaintPointerEvent {
        let p = convert(e.locationInWindow, from: nil)
        let pen = e.subtype == .tabletPoint
        var sample = PaintPointerSample(pointerType: pen ? "pen" : "mouse", pressure: Double(e.pressure), timeStamp: e.timestamp * 1000)
        if pen {
            // AppKit's tilt is -1..1 per axis (right and towards the user positive), as Pointer Events' degrees / 90.
            sample.tiltX = Double(e.tilt.x) * 90
            sample.tiltY = Double(e.tilt.y) * 90
            let r = Double(e.rotation)
            if r != 0 { sample.twist = (r.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }
        }
        let f = e.modifierFlags
        return PaintPointerEvent(pointerId: 1, x: Double(p.x), y: Double(p.y), sample: sample, button: button, shiftKey: f.contains(.shift), altKey: f.contains(.option), modKey: f.contains(.command))
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        model?.pointerDown(pointer(e))
    }
    override func mouseDragged(with e: NSEvent) { model?.pointerMove(pointer(e)) }
    override func mouseUp(with e: NSEvent) { model?.pointerUp(pointer(e)) }
    override func otherMouseDown(with e: NSEvent) { if e.buttonNumber == 2 { model?.pointerDown(pointer(e, button: 1)) } }
    override func otherMouseDragged(with e: NSEvent) { model?.pointerMove(pointer(e, button: 1)) }
    override func otherMouseUp(with e: NSEvent) { model?.pointerUp(pointer(e, button: 1)) }

    override func scrollWheel(with e: NSEvent) {
        guard let g = model?.gesture else { return }
        let p = convert(e.locationInWindow, from: nil)
        if e.hasPreciseScrollingDeltas && !e.modifierFlags.contains(.command) && !e.modifierFlags.contains(.shift) {
            // Trackpad: two fingers pan; pinch zooms (magnify).
            g.pan(dx: Double(e.scrollingDeltaX), dy: Double(e.scrollingDeltaY))
        } else {
            // A wheel notch is about 40 web pixels.
            let lines = e.hasPreciseScrollingDeltas ? Double(e.scrollingDeltaY) / 10 : Double(e.scrollingDeltaY)
            g.wheel(x: Double(p.x), y: Double(p.y), deltaY: -lines * 40, shiftKey: e.modifierFlags.contains(.shift))
        }
    }

    override func magnify(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        model?.gesture.zoom(by: 1 + Double(e.magnification), aboutX: Double(p.x), y: Double(p.y))
    }

    override func rotate(with e: NSEvent) {
        // AppKit turns counter-clockwise for positive values; the view's rotation is clockwise.
        model?.gesture.rotate(by: -Double(e.rotation))
    }

    private func keyName(_ e: NSEvent) -> String? {
        if e.keyCode == 53 { return "Escape" }
        return e.charactersIgnoringModifiers
    }

    override func keyDown(with e: NSEvent) {
        guard let model, let key = keyName(e), model.handleKey(key, mod: e.modifierFlags.contains(.command), shift: e.modifierFlags.contains(.shift)) else {
            super.keyDown(with: e)
            return
        }
    }

    /// Command shortcuts (undo, redo) reach the canvas before the menu bar while it has focus.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        guard window?.firstResponder === self, let model, let key = keyName(e) else { return super.performKeyEquivalent(with: e) }
        if model.handleKey(key, mod: e.modifierFlags.contains(.command), shift: e.modifierFlags.contains(.shift)) { return true }
        return super.performKeyEquivalent(with: e)
    }
}

#elseif canImport(UIKit)

/// Touch, Apple Pencil, pinch and rotation input over the canvas (iOS).
struct PaintInputView: UIViewRepresentable {
    let model: PaintEditorModel

    func makeUIView(context: Context) -> PaintInputUIView {
        let v = PaintInputUIView()
        v.model = model
        return v
    }

    func updateUIView(_ v: PaintInputUIView, context: Context) { v.model = model }
}

final class PaintInputUIView: UIView {
    var model: PaintEditorModel?
    private var lastScale: CGFloat = 1
    private var lastRotation: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        let rotate = UIRotationGestureRecognizer(target: self, action: #selector(rotated(_:)))
        pinch.delegate = self
        rotate.delegate = self
        // Two fingers: only touches, so the Pencil keeps drawing.
        pinch.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        rotate.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        addGestureRecognizer(pinch)
        addGestureRecognizer(rotate)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var canBecomeFirstResponder: Bool { true }

    /// A touch as a pointer event: the Pencil is a pen with force as pressure, altitude, azimuth and (Pencil Pro) roll.
    private func pointer(_ t: UITouch, _ event: UIEvent?, coalesced: Bool = false) -> PaintPointerEvent {
        let p = t.preciseLocation(in: self)
        let type: String = t.type == .pencil ? "pen" : t.type == .indirectPointer ? "mouse" : "touch"
        var sample = PaintPointerSample(pointerType: type, timeStamp: t.timestamp * 1000)
        if t.type == .pencil {
            sample.pressure = t.maximumPossibleForce > 0 ? Double(t.force / t.maximumPossibleForce) : nil
            sample.altitudeAngle = Double(t.altitudeAngle)
            sample.azimuthAngle = Double(t.azimuthAngle(in: self))
            if #available(iOS 17.5, *) {
                let roll = Double(t.rollAngle) * 180 / Double.pi
                if roll != 0 { sample.twist = (roll.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }
            }
        }
        var e = PaintPointerEvent(pointerId: ObjectIdentifier(t).hashValue, x: Double(p.x), y: Double(p.y), sample: sample)
        if coalesced, let event {
            e.coalesced = (event.coalescedTouches(for: t) ?? []).map { pointer($0, nil) }
            e.predicted = (event.predictedTouches(for: t) ?? []).map { pointer($0, nil) }
        }
        return e
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        becomeFirstResponder()
        for t in touches { model?.pointerDown(pointer(t, event)) }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { model?.pointerMove(pointer(t, event, coalesced: true)) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { model?.pointerUp(pointer(t, event)) }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        model?.pointerCancel()
    }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        if g.state == .began { lastScale = 1; model?.pointerCancel() }
        guard g.state == .changed else { return }
        let p = g.location(in: self)
        model?.gesture.zoom(by: Double(g.scale / lastScale), aboutX: Double(p.x), y: Double(p.y))
        lastScale = g.scale
    }

    @objc private func rotated(_ g: UIRotationGestureRecognizer) {
        if g.state == .began { lastRotation = 0; model?.pointerCancel() }
        guard g.state == .changed else { return }
        model?.gesture.rotate(by: Double(g.rotation - lastRotation) * 180 / Double.pi)
        lastRotation = g.rotation
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key, let model else { continue }
            let name = key.keyCode == .keyboardEscape ? "Escape" : key.charactersIgnoringModifiers
            if model.handleKey(name, mod: key.modifierFlags.contains(.command), shift: key.modifierFlags.contains(.shift)) { handled = true }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}

extension PaintInputUIView: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

#endif
