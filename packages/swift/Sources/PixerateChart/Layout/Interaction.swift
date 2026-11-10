// Drag behaviour follows effectcraft-main/crates/ui-egui/src/panels/graph.rs and graph_tools.rs (the value axis
// is frozen while a key is dragged, Shift locks to the axis that moved most, `snap_px` picks the nearest
// candidate within a few screen pixels) and lightcraft-main's curve tests (Alt moves a tenth as far)
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore
import PixerateRaster

/// Scene coordinates of a pointer, given the rendered element's box (the scene is scaled to fit it).
public func chartClientToScene(
    _ scene: (width: Double, height: Double),
    _ box: (left: Double, top: Double, width: Double, height: Double),
    _ clientX: Double,
    _ clientY: Double
) -> (x: Double, y: Double) {
    let sx = box.width != 0 ? scene.width / box.width : 1.0
    let sy = box.height != 0 ? scene.height / box.height : 1.0
    return (x: (clientX - box.left) * sx, y: (clientY - box.top) * sy)
}

/// Whether a point can be dragged to a new value in this scene.
public func canDragChartPoint(_ spec: ChartSpec, _ scene: ChartScene, _ target: ChartSelection?) -> Bool {
    guard case .point(let seriesId, let index) = target,
          scene.valueScale != nil,
          !scene.percent else { return false }
    let family = chartFamily(spec)
    guard family == .cartesian || family == .xy || family == .waterfall else { return false }
    guard let series = spec.series.first(where: { $0.id == seriesId }),
          !(series.hidden ?? false),
          index >= 0,
          index < series.values.count,
          series.values[index] != nil else { return false }
    return true
}

public struct ChartDragMoveOptions: Sendable, Equatable {
    public var fine: Bool?
    public var lockAxis: Bool?
    public var noSnap: Bool?

    public init(fine: Bool? = nil, lockAxis: Bool? = nil, noSnap: Bool? = nil) {
        self.fine = fine
        self.lockAxis = lockAxis
        self.noSnap = noSnap
    }
}

public struct ChartSnapOptions: Sendable, Equatable {
    public var candidates: [Double]?
    public var tolerancePx: Double?
    public var step: Double?
    public var scale: ChartValueScale?

    public init(
        candidates: [Double]? = nil,
        tolerancePx: Double? = nil,
        step: Double? = nil,
        scale: ChartValueScale? = nil
    ) {
        self.candidates = candidates
        self.tolerancePx = tolerancePx
        self.step = step
        self.scale = scale
    }
}

/// Snaps a dragged value: to the nearest candidate within `tolerancePx` screen pixels, or
/// else to a tenth of the tick step.
public func snapChartDragValue(
    _ scene: ChartScene,
    _ value: Double,
    _ options: ChartSnapOptions = ChartSnapOptions()
) -> Double {
    let scale = options.scale ?? scene.valueScale
    let tolerance = options.tolerancePx ?? 6.0
    if let scale {
        let px: (Double) -> Double = { v in chartScaleToPixel(v, scale) }
        let at = px(value)
        var best: Double? = nil
        var bestDist = tolerance
        let allCandidates = (options.candidates ?? []) + scale.ticks
        for c in allCandidates {
            guard c.isFinite else { continue }
            let d = abs(px(c) - at)
            guard d.isFinite else { continue }
            if d <= bestDist {
                best = c
                bestDist = d
            }
        }
        if let best { return best }
    }
    return snapChartValue(scene, value, options.step, scale?.ticks, scale?.logBase)
}

public struct ChartKeyInput: Sendable, Equatable {
    public var key: String
    public var shiftKey: Bool?
    public var altKey: Bool?
    public var metaKey: Bool?
    public var ctrlKey: Bool?

    public init(
        key: String,
        shiftKey: Bool? = nil,
        altKey: Bool? = nil,
        metaKey: Bool? = nil,
        ctrlKey: Bool? = nil
    ) {
        self.key = key
        self.shiftKey = shiftKey
        self.altKey = altKey
        self.metaKey = metaKey
        self.ctrlKey = ctrlKey
    }
}

/// A short description of the selection for an inspector heading or a screen reader.
public func describeChartSelection(_ spec: ChartSpec, _ selection: ChartSelection?) -> String {
    guard let selection else { return "Nothing selected" }
    switch selection {
    case .chart:
        return "Chart"
    case .title:
        return "Title"
    case .subtitle:
        return "Subtitle"
    case .legend:
        return "Legend"
    case .axis(let axis):
        if axis == .x {
            return chartFamily(spec) == .xy ? "X axis" : "Category axis"
        }
        return axis == .y ? "Value axis" : "Secondary value axis"
    case .series(let seriesId):
        let name = spec.series.first(where: { $0.id == seriesId })?.name ?? seriesId
        return "Series \"\(name)\""
    case .category(let index):
        let label = (index >= 0 && index < spec.categories.count) ? spec.categories[index] : String(index)
        return "Category \"\(label)\""
    case .trendline(let seriesId, let index):
        let series = spec.series.first(where: { $0.id == seriesId })
        let line: ChartTrendline? = (series?.trendlines != nil && index >= 0 && index < series!.trendlines!.count)
            ? series!.trendlines![index]
            : nil
        let prefix = line.map { $0.type.rawValue.replacingOccurrences(of: "-", with: " ") } ?? "Trendline"
        return "\(prefix) trendline on \"\(series?.name ?? seriesId)\""
    case .point(let seriesId, let index):
        let series = spec.series.first(where: { $0.id == seriesId })
        let value: Double? = (series != nil && index >= 0 && index < series!.values.count) ? series!.values[index] : nil
        let x: Double? = (series?.x != nil && index >= 0 && index < series!.x!.count) ? series!.x![index] : nil
        let valText = value.map(JSONValue.jsNumber) ?? "blank"
        if let x, chartFamily(spec) == .xy {
            return "\(series?.name ?? seriesId): (\(JSONValue.jsNumber(x)), \(valText))"
        }
        let cat = (index >= 0 && index < spec.categories.count) ? spec.categories[index] : String(index)
        return "\(series?.name ?? seriesId) · \(cat): \(valText)"
    }
}

/// The mark under a scene point (topmost first), for hosts without DOM events and for agents
/// that drive the pointer: rects, circles, lines (within 4 px) and text boxes. Returns the
/// mark's `target`, or `.chart` over the background, or `nil` outside.
public func chartHitTest(
    _ scene: ChartScene,
    _ point: (x: Double, y: Double),
    _ measure: ChartTextMeasure = { t, s, w in Double(t.utf16.count) * s * ((w ?? 400) >= 600 ? 0.6 : 0.56) }
) -> ChartSelection? {
    for m in scene.marks.reversed() {
        guard let target = m.target, m.role != .selection, m.role != .background else { continue }
        var hit = false
        switch m {
        case .rect(let r):
            hit = point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height
        case .circle(let c):
            hit = JS.hypot(point.x - c.cx, point.y - c.cy) <= Swift.max(c.r, 4.0) + 2.0
        case .line(let l):
            let dx = l.x2 - l.x1
            let dy = l.y2 - l.y1
            let len2 = dx * dx + dy * dy
            let t = len2 != 0 ? Swift.max(0.0, Swift.min(1.0, ((point.x - l.x1) * dx + (point.y - l.y1) * dy) / len2)) : 0.0
            hit = JS.hypot(point.x - (l.x1 + t * dx), point.y - (l.y1 + t * dy)) <= 4.0
        case .text(let t):
            if t.rotate != nil && t.rotate != 0 { break }
            let w = measure(t.text, t.size, t.weight)
            let x0 = t.anchor == .start ? t.x : (t.anchor == .end ? t.x - w : t.x - w / 2.0)
            let y0 = t.baseline == .top ? t.y : (t.baseline == .bottom ? t.y - t.size : t.y - t.size / 2.0)
            hit = point.x >= x0 - 2.0 && point.x <= x0 + w + 2.0 && point.y >= y0 - 2.0 && point.y <= y0 + t.size + 2.0
        case .path:
            break
        }
        if hit { return target }
    }
    return (point.x >= 0 && point.y >= 0 && point.x <= scene.width && point.y <= scene.height) ? .chart : nil
}
