import CoreGraphics
import PixerateCore
import PixerateGeometry
import PixerateVector
import SwiftUI
#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/**
 * The drawing (`VectorCanvas`): the scene render data drawn with CoreGraphics
 * (`VectorSceneDrawer`) under the view's pan and zoom, and over it the selection box with its
 * resize handles, Direct Selection's anchors, the marquee, the pen path's points and the stroke
 * being drawn. Input goes through `VectorCanvasGesture`: the mouse, trackpad (two fingers pan,
 * pinch zooms) and tablet pens on macOS, touch and Apple Pencil on iOS (two fingers pinch and pan),
 * and the keyboard (tool letters, Delete, arrows, Return / Escape, ⌘Z, the commands' shortcuts).
 */
public struct VectorCanvasView: View {
    private let model: VectorEditorModel
    /// Take pointer input (default true). Off for still images: `ImageRenderer` draws AppKit and UIKit views as placeholders.
    private let interactive: Bool

    public init(model: VectorEditorModel, interactive: Bool = true) {
        self.model = model
        self.interactive = interactive
    }

    public var body: some View {
        // Reading `revision` redraws the canvas after every change.
        let _ = model.revision
        let scene: VectorSceneSnapshot = model.scene
        let overlay: VectorOverlayData = VectorOverlayData(model: model)
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                Canvas { ctx, _ in
                    if let data = scene.data {
                        ctx.withCGContext { (cg: CGContext) -> Void in
                            VectorSceneDrawer.draw(data, in: cg)
                        }
                    }
                    overlay.draw(in: &ctx)
                }
                .accessibilityLabel("Vector drawing")
                if interactive { VectorInputView(model: model) }
                if let issue = scene.issue {
                    Text(issue)
                        .font(.caption)
                        .padding(6)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6))
                        .padding(8)
                        .allowsHitTesting(false)
                }
            }
            .onAppear { layout(geo.size) }
            .onChange(of: geo.size) { (_: CGSize, size: CGSize) -> Void in layout(size) }
        }
        .background(Color(white: 0.9))
        .clipped()
    }

    private func layout(_ size: CGSize) {
        model.viewSize = (Double(size.width), Double(size.height))
        model.fitOnce()
    }
}

/// What the overlay draws, read from the model once per frame (view space).
struct VectorOverlayData {
    var box: CGRect?
    var handles: [CGPoint] = []
    var anchors: [(point: CGPoint, picked: Bool)] = []
    var marquee: CGRect?
    var stroke: [CGPoint] = []
    var strokeWidth: CGFloat = 0
    var pen: [CGPoint] = []
    var blendStart: CGRect?
    var accent: Color
    var handleSize: CGFloat

    @MainActor
    init(model: VectorEditorModel) {
        let g = model.gesture!
        let theme = model.tables.overlayTheme
        accent = Color(cgColor: parseCSSColor(theme.accent) ?? CGColor(red: 0.05, green: 0.65, blue: 0.9, alpha: 1))
        handleSize = CGFloat(theme.transformHandleSize)
        let zoom: Double = model.viewport.zoom
        func screen(_ p: Vec2) -> CGPoint {
            let s = g.toScreen(p)
            return CGPoint(x: s.x, y: s.y)
        }
        func rect(_ b: VectorBounds) -> CGRect {
            let a = screen(Vec2(b.x, b.y))
            return CGRect(x: a.x, y: a.y, width: CGFloat(b.width * zoom), height: CGFloat(b.height * zoom))
        }
        let tool = model.tool
        if tool == "select" || tool == "direct", let b = g.selectionBounds() {
            box = rect(b)
            if tool == "select" {
                handles = VectorBoxHandle.allCases.map { (h: VectorBoxHandle) -> CGPoint in
                    let u = h.unit
                    return screen(Vec2(b.x + b.width * u.x, b.y + b.height * u.y))
                }
            }
        }
        let picked = Set(g.anchors)
        anchors = g.visibleAnchors().map { (a: (ref: VectorAnchorRef, point: Vec2)) -> (point: CGPoint, picked: Bool) in
            (screen(a.point), picked.contains(a.ref))
        }
        let o = g.overlay
        marquee = o.marquee.map(rect)
        stroke = o.stroke.map(screen)
        strokeWidth = CGFloat(o.strokeWidth * zoom)
        pen = o.pen.map { (a: VectorAnchor) -> CGPoint in screen(Vec2(a.x, a.y)) }
        if let id = o.blendStart, let node = model.controller.getNode(id), let b = try? vectorNodeBounds(node) {
            blendStart = rect(b)
        }
    }

    func draw(in ctx: inout GraphicsContext) {
        let line = GraphicsContext.Shading.color(accent)
        if let box {
            ctx.stroke(Path(box), with: line, lineWidth: 1)
        }
        let half = handleSize / 2
        for h in handles {
            let r = CGRect(x: h.x - half, y: h.y - half, width: handleSize, height: handleSize)
            ctx.fill(Path(r), with: .color(.white))
            ctx.stroke(Path(r), with: line, lineWidth: 1)
        }
        let a = handleSize * 0.85
        for anchor in anchors {
            let r = CGRect(x: anchor.point.x - a / 2, y: anchor.point.y - a / 2, width: a, height: a)
            ctx.fill(Path(r), with: anchor.picked ? line : .color(.white))
            ctx.stroke(Path(r), with: line, lineWidth: 1)
        }
        if let marquee {
            ctx.fill(Path(marquee), with: .color(accent.opacity(0.08)))
            ctx.stroke(Path(marquee), with: line, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
        if stroke.count > 1 {
            var p = Path()
            p.addLines(stroke)
            let width: CGFloat = strokeWidth > 0 ? strokeWidth : 1.5
            let color: Color = strokeWidth > 0 ? Color.red.opacity(0.25) : accent
            ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
        }
        for (i, q) in pen.enumerated() {
            let size: CGFloat = i == 0 ? a * 1.2 : a
            let r = CGRect(x: q.x - size / 2, y: q.y - size / 2, width: size, height: size)
            ctx.fill(Path(r), with: i == pen.count - 1 ? line : .color(.white))
            ctx.stroke(Path(r), with: line, lineWidth: 1)
        }
        if let blendStart {
            ctx.stroke(Path(blendStart), with: line, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
        }
    }
}

// MARK: - Input

#if canImport(AppKit) && !targetEnvironment(macCatalyst)

/// Mouse, tablet, trackpad and keyboard input over the canvas (macOS).
struct VectorInputView: NSViewRepresentable {
    let model: VectorEditorModel

    func makeNSView(context: Context) -> VectorInputNSView {
        let v = VectorInputNSView()
        v.model = model
        return v
    }

    func updateNSView(_ v: VectorInputNSView, context: Context) { v.model = model }
}

final class VectorInputNSView: NSView {
    var model: VectorEditorModel?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func pointer(_ e: NSEvent, button: Int = 0) -> VectorPointerEvent {
        let p = convert(e.locationInWindow, from: nil)
        let pen = e.subtype == .tabletPoint
        let f = e.modifierFlags
        return VectorPointerEvent(x: Double(p.x), y: Double(p.y), button: button, shift: f.contains(.shift), alt: f.contains(.option), mod: f.contains(.command),
                                  pointerType: pen ? "pen" : "mouse", pressure: pen ? Double(e.pressure) : nil, clickCount: e.type == .leftMouseDown ? e.clickCount : 1)
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
        if e.hasPreciseScrollingDeltas && !e.modifierFlags.contains(.command) {
            // Trackpad: two fingers pan; pinch zooms (magnify).
            g.pan(dx: Double(e.scrollingDeltaX), dy: Double(e.scrollingDeltaY))
        } else {
            let lines: Double = e.hasPreciseScrollingDeltas ? Double(e.scrollingDeltaY) / 10 : Double(e.scrollingDeltaY)
            let factor: Double = Foundation.pow(1.1, lines)
            g.zoom(by: factor, aboutX: Double(p.x), y: Double(p.y))
        }
    }

    override func magnify(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        model?.gesture.zoom(by: 1 + Double(e.magnification), aboutX: Double(p.x), y: Double(p.y))
    }

    /// A key as the model names it.
    private func keyName(_ e: NSEvent) -> String? {
        switch e.keyCode {
        case 53: return "Escape"
        case 36, 76: return "Return"
        case 51: return "Backspace"
        case 117: return "Delete"
        case 123: return "ArrowLeft"
        case 124: return "ArrowRight"
        case 125: return "ArrowDown"
        case 126: return "ArrowUp"
        case 100: return "F8"
        case 49: return " "
        default: return e.charactersIgnoringModifiers
        }
    }

    private func handle(_ e: NSEvent) -> Bool {
        guard let model, let key = keyName(e) else { return false }
        if key == " " {
            model.setSpaceHeld(true)
            return true
        }
        let f = e.modifierFlags
        return model.handleKey(key, mod: f.contains(.command), shift: f.contains(.shift), alt: f.contains(.option))
    }

    override func keyDown(with e: NSEvent) {
        if !handle(e) { super.keyDown(with: e) }
    }

    override func keyUp(with e: NSEvent) {
        if e.keyCode == 49 { model?.setSpaceHeld(false) } else { super.keyUp(with: e) }
    }

    /// Command shortcuts (undo, group, …) reach the canvas before the menu bar while it has focus.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        guard window?.firstResponder === self else { return super.performKeyEquivalent(with: e) }
        if handle(e) { return true }
        return super.performKeyEquivalent(with: e)
    }
}

#elseif canImport(UIKit)

/// Touch, Apple Pencil, pinch, two-finger pan and hardware-keyboard input over the canvas (iOS).
struct VectorInputView: UIViewRepresentable {
    let model: VectorEditorModel

    func makeUIView(context: Context) -> VectorInputUIView {
        let v = VectorInputUIView()
        v.model = model
        return v
    }

    func updateUIView(_ v: VectorInputUIView, context: Context) { v.model = model }
}

final class VectorInputUIView: UIView, UIGestureRecognizerDelegate {
    var model: VectorEditorModel?
    private var lastScale: CGFloat = 1
    private var lastPan: CGPoint = .zero
    private var active: UITouch?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        // Two fingers: only touches, so the Pencil keeps drawing.
        let direct = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        pinch.allowedTouchTypes = direct
        pan.allowedTouchTypes = direct
        pinch.delegate = self
        pan.delegate = self
        addGestureRecognizer(pinch)
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var canBecomeFirstResponder: Bool { true }

    private func pointer(_ t: UITouch, _ event: UIEvent?) -> VectorPointerEvent {
        let p = t.preciseLocation(in: self)
        let type: String = t.type == .pencil ? "pen" : t.type == .indirectPointer ? "mouse" : "touch"
        let pressure: Double? = t.type == .pencil && t.maximumPossibleForce > 0 ? Double(t.force / t.maximumPossibleForce) : nil
        let flags: UIKeyModifierFlags = event?.modifierFlags ?? []
        return VectorPointerEvent(x: Double(p.x), y: Double(p.y), shift: flags.contains(.shift), alt: flags.contains(.alternate), mod: flags.contains(.command),
                                  pointerType: type, pressure: pressure, clickCount: t.tapCount)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        becomeFirstResponder()
        if let a = active {
            // A second finger joining a finger's drag makes it a pinch or pan, not a drawing.
            if a.type == .direct && touches.contains(where: { (t: UITouch) -> Bool in t.type == .direct }) {
                model?.pointerCancel()
                active = nil
            }
            return
        }
        let fingers: Int = event?.allTouches?.filter { (t: UITouch) -> Bool in t.type == .direct }.count ?? 0
        let pencil: UITouch? = touches.first { (t: UITouch) -> Bool in t.type == .pencil }
        guard let t = pencil ?? (fingers <= 1 ? touches.first : nil) else { return }
        active = t
        model?.pointerDown(pointer(t, event))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let a = active, touches.contains(a) else { return }
        let samples: [UITouch] = event?.coalescedTouches(for: a) ?? [a]
        for s in samples { model?.pointerMove(pointer(s, event)) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let a = active, touches.contains(a) else { return }
        active = nil
        model?.pointerUp(pointer(a, event))
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active != nil else { return }
        active = nil
        model?.pointerCancel()
    }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        if g.state == .began {
            lastScale = 1
            if active != nil { model?.pointerCancel(); active = nil }
        }
        guard g.state == .changed else { return }
        let p = g.location(in: self)
        model?.gesture.zoom(by: Double(g.scale / lastScale), aboutX: Double(p.x), y: Double(p.y))
        lastScale = g.scale
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        if g.state == .began {
            lastPan = .zero
            if active != nil { model?.pointerCancel(); active = nil }
        }
        guard g.state == .changed else { return }
        let t = g.translation(in: self)
        model?.gesture.pan(dx: Double(t.x - lastPan.x), dy: Double(t.y - lastPan.y))
        lastPan = t
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key, let model else { continue }
            let name: String
            switch key.keyCode {
            case .keyboardEscape: name = "Escape"
            case .keyboardReturnOrEnter: name = "Return"
            case .keyboardDeleteOrBackspace: name = "Backspace"
            case .keyboardDeleteForward: name = "Delete"
            case .keyboardLeftArrow: name = "ArrowLeft"
            case .keyboardRightArrow: name = "ArrowRight"
            case .keyboardUpArrow: name = "ArrowUp"
            case .keyboardDownArrow: name = "ArrowDown"
            case .keyboardF8: name = "F8"
            case .keyboardSpacebar:
                model.setSpaceHeld(true)
                handled = true
                continue
            default: name = key.charactersIgnoringModifiers
            }
            let f = key.modifierFlags
            if model.handleKey(name, mod: f.contains(.command), shift: f.contains(.shift), alt: f.contains(.alternate)) { handled = true }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.key?.keyCode == .keyboardSpacebar }) { model?.setSpaceHeld(false) }
        super.pressesEnded(presses, with: event)
    }
}

#endif
