import PixerateChart
import PixerateCore
import SwiftUI

/// Renders a `ChartScene` on a SwiftUI `Canvas` with interactive hit-testing, point dragging,
/// hover tooltips, and keyboard navigation (`← → ↑ ↓`, `Delete`, `Escape`, `⌘Z`, `⇧⌘Z`).
public struct ChartView: View {
    private let model: ChartEditorModel
    private let interactive: Bool
    @FocusState private var isFocused: Bool
    @State private var dragStarted = false

    public init(model: ChartEditorModel, interactive: Bool = true) {
        self.model = model
        self.interactive = interactive
    }

    public var body: some View {
        let _ = model.revision
        let scene = model.scene
        let tooltip = model.tooltip
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Canvas { ctx, _ in
                    drawChartSceneInCanvas(scene, context: &ctx)
                }
                .accessibilityLabel(model.spec.title.isEmpty ? "Chart" : model.spec.title)
                .accessibilityValue(describeChart(model.spec))

                if let tooltip, !model.isDraggingPoint {
                    ChartTooltipOverlay(tooltip: tooltip, viewport: geo.size)
                        .allowsHitTesting(false)
                }
            }
            .contentShape(Rectangle())
            .focusable(interactive)
            .focused($isFocused)
            .modifier(ChartInputModifier(
                model: model,
                interactive: interactive,
                dragStarted: $dragStarted,
                requestFocus: { isFocused = true }
            ))
            .onAppear { updateSize(geo.size) }
            .onChange(of: geo.size) { _, newSize in updateSize(newSize) }
        }
        .background(chartSwiftUIColor(scene.theme.background) ?? Color.white)
        .clipped()
    }

    private func updateSize(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        model.viewport = (width: Double(size.width), height: Double(size.height))
    }
}

/// Draws every mark of a `ChartScene` onto a SwiftUI `GraphicsContext`.
public func drawChartSceneInCanvas(_ scene: ChartScene, context ctx: inout GraphicsContext) {
    for mark in scene.marks {
        // SVG's `opacity` composites the mark's fill and stroke as one group: draw them into a layer
        // that the context composites at that opacity.
        if let group = chartMarkGroupOpacity(mark) {
            var outer = ctx
            outer.opacity *= group
            outer.drawLayer { layer in
                var inner = layer
                drawChartMarkInCanvas(mark, context: &inner)
            }
        } else {
            drawChartMarkInCanvas(mark, context: &ctx)
        }
    }
}

private func drawChartMarkInCanvas(_ mark: ChartMark, context ctx: inout GraphicsContext) {
    switch mark {
    case .rect(let m):
        let rect = CGRect(x: m.x, y: m.y, width: m.width, height: m.height)
        let path: Path
        if let r = m.radius, r > 0 {
            let cr = CGFloat(Swift.min(r, Swift.min(m.width, m.height) / 2.0))
            path = Path(roundedRect: rect, cornerRadius: cr)
        } else {
            path = Path(rect)
        }
        if let fill = chartSwiftUIColor(m.fill) {
            ctx.fill(path, with: .color(fill))
        }
        if let stroke = chartSwiftUIColor(m.stroke) {
            let dash: [CGFloat] = m.role == .selection ? [3, 2] : []
            ctx.stroke(
                path,
                with: .color(stroke),
                style: StrokeStyle(lineWidth: CGFloat(m.strokeWidth ?? 1.0), dash: dash)
            )
        }

    case .path(let m):
        let path = parseChartPath(m.d)
        if let fill = chartSwiftUIColor(m.fill) {
            ctx.fill(path, with: .color(fill))
        }
        if let stroke = chartSwiftUIColor(m.stroke) {
            // chartSceneToSvg strokes every path with round joins and caps.
            let dash = parseChartDash(m.dash)
            ctx.stroke(
                path,
                with: .color(stroke),
                style: StrokeStyle(
                    lineWidth: CGFloat(m.strokeWidth ?? 1.0),
                    lineCap: .round,
                    lineJoin: .round,
                    dash: dash
                )
            )
        }

    case .circle(let m):
        let rect = CGRect(x: m.cx - m.r, y: m.cy - m.r, width: m.r * 2.0, height: m.r * 2.0)
        let path = Path(ellipseIn: rect)
        if let fill = chartSwiftUIColor(m.fill) {
            ctx.fill(path, with: .color(fill))
        }
        if let stroke = chartSwiftUIColor(m.stroke) {
            ctx.stroke(
                path,
                with: .color(stroke),
                style: StrokeStyle(lineWidth: CGFloat(m.strokeWidth ?? 1.0))
            )
        }

    case .line(let m):
        guard let stroke = chartSwiftUIColor(m.stroke) else { break }
        var path = Path()
        path.move(to: CGPoint(x: m.x1, y: m.y1))
        path.addLine(to: CGPoint(x: m.x2, y: m.y2))
        ctx.stroke(
            path,
            with: .color(stroke),
            style: StrokeStyle(
                lineWidth: CGFloat(m.strokeWidth ?? 1.0),
                dash: parseChartDash(m.dash)
            )
        )

    case .text(let m):
        guard !m.text.isEmpty, let fill = chartSwiftUIColor(m.fill) else { break }
        let weight: Font.Weight = {
            guard let w = m.weight else { return .regular }
            if w >= 700 { return .bold }
            if w >= 600 { return .semibold }
            if w >= 500 { return .medium }
            return .regular
        }()
        let tabular = m.role == .tickLabel || m.role == .dataLabel || m.role == .dragReadout || m.role == .raceTime
        var textView = Text(m.text)
            .font(.system(size: CGFloat(m.size), weight: weight))
            .foregroundColor(fill)
        if tabular {
            textView = textView.monospacedDigit()
        }
        let resolved = ctx.resolve(textView)
        let anchorX: CGFloat = m.anchor == .start ? 0.0 : (m.anchor == .end ? 1.0 : 0.5)
        let anchorY: CGFloat = m.baseline == .top ? 0.0 : (m.baseline == .bottom ? 1.0 : 0.5)
        let unitAnchor = UnitPoint(x: anchorX, y: anchorY)
        if let rot = m.rotate, rot != 0 {
            ctx.drawLayer { layer in
                layer.translateBy(x: CGFloat(m.x), y: CGFloat(m.y))
                layer.rotate(by: .degrees(rot))
                layer.draw(resolved, at: .zero, anchor: unitAnchor)
            }
        } else {
            ctx.draw(resolved, at: CGPoint(x: m.x, y: m.y), anchor: unitAnchor)
        }
    }
}

private struct ChartInputModifier: ViewModifier {
    let model: ChartEditorModel
    let interactive: Bool
    @Binding var dragStarted: Bool
    let requestFocus: () -> Void
    /// Resets when the drag ends *or is cancelled*; SwiftUI skips `onEnded` on cancel.
    @GestureState private var gestureActive = false

    func body(content: Content) -> some View {
        if interactive {
            content
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .updating($gestureActive) { _, active, _ in active = true }
                        .onChanged { value in
                            requestFocus()
                            let x = Double(value.location.x)
                            let y = Double(value.location.y)
                            if !dragStarted {
                                dragStarted = true
                                _ = model.pointerDown(x: x, y: y)
                            } else {
                                model.pointerMove(x: x, y: y)
                            }
                        }
                        .onEnded { _ in
                            dragStarted = false
                            model.pointerUp()
                        }
                )
                .onChange(of: gestureActive) { _, active in
                    guard !active else { return }
                    // onEnded runs after the gesture state resets; if it hasn't by the next
                    // turn of the run loop, the gesture was cancelled.
                    DispatchQueue.main.async {
                        if dragStarted {
                            dragStarted = false
                            model.pointerCancel()
                        }
                    }
                }
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let pt):
                        if !dragStarted {
                            model.pointerMove(x: Double(pt.x), y: Double(pt.y))
                        }
                    case .ended:
                        model.pointerLeave()
                    }
                }
                .onKeyPress { press in
                    let keyName = mapSwiftUIKey(press.key)
                    let shift = press.modifiers.contains(.shift)
                    let alt = press.modifiers.contains(.option)
                    let mod = press.modifiers.contains(.command) || press.modifiers.contains(.control)
                    return model.handleKey(keyName, shift: shift, alt: alt, mod: mod) ? .handled : .ignored
                }
        } else {
            content
        }
    }

    private func mapSwiftUIKey(_ key: KeyEquivalent) -> String {
        switch key {
        case .escape: return "Escape"
        case .delete, .deleteForward: return "Delete"
        case .leftArrow: return "ArrowLeft"
        case .rightArrow: return "ArrowRight"
        case .upArrow: return "ArrowUp"
        case .downArrow: return "ArrowDown"
        default: return String(key.character)
        }
    }
}

/// Floating tooltip card displayed over the chart canvas on hover.
public struct ChartTooltipOverlay: View {
    public let tooltip: ChartTooltip
    public let viewport: CGSize

    public init(tooltip: ChartTooltip, viewport: CGSize) {
        self.tooltip = tooltip
        self.viewport = viewport
    }

    public var body: some View {
        let clampedX = Swift.max(12.0, Swift.min(Double(viewport.width) - 180.0, tooltip.x + 12.0))
        let clampedY = Swift.max(12.0, Swift.min(Double(viewport.height) - 90.0, tooltip.y + 12.0))
        VStack(alignment: .leading, spacing: 4) {
            if !tooltip.title.isEmpty {
                Text(tooltip.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            ForEach(Array(tooltip.items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 6) {
                    Circle()
                        .fill(chartSwiftUIColor(item.color) ?? .blue)
                        .frame(width: 8, height: 8)
                    Text(item.name)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Text(item.text)
                        .font(.caption2.monospacedDigit().weight(.medium))
                        .foregroundStyle(.primary)
                }
            }
        }
        .padding(8)
        .frame(width: 168, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.primary.opacity(0.12), lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 4, x: 0, y: 2)
        .offset(x: CGFloat(clampedX), y: CGFloat(clampedY))
    }
}
