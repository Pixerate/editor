import Foundation
import PixerateCore
import PixerateRaster

/// Data labels are skipped on series with more points than this.
public let MAX_CHART_DATA_LABELS = 200
/// Lines with more points than this are thinned per pixel column.
public let MAX_CHART_LINE_POINTS = 2000
/// Markers beyond this many are thinned to one per 2px cell.
public let MAX_CHART_MARKERS = 1000

internal struct ValueAxisInput {
    var lo: Double
    var hi: Double
    var axis: ChartAxis
    var format: ChartNumberFormat
    var frozen: ChartDomainBounds? = nil
    var headroom: Bool = false
    var key: ChartSelectionAxis
}

internal struct ScaleInfo {
    var scale: NiceScale
    var range: (Double, Double)
    var px: (Double) -> Double
    var raw: (Double) -> Double
    var zero: Double
    var format: ChartNumberFormat
    var tickText: (Double) -> String
    var logBase: Double?
}

internal struct CategoryFrame {
    var plot: ChartRect
    var horizontal: Bool
    var n: Int
    var band: Double
    var catStart: Double
    var catLen: Double
    var catCenter: (Double) -> Double
    var map: (Pt) -> (Double, Double)
    var value: ScaleInfo
    var value2: ScaleInfo?
}

internal struct CategoryFrameInput {
    var labels: [String]
    var horizontal: Bool
    var primary: ValueAxisInput
    var secondary: ValueAxisInput? = nil
    var labelTarget: ((Int) -> ChartSelection?)? = nil
    var categoryAxis: ChartAxis? = nil
}

/// Value ↔ pixel for one axis: logarithmic when `axis.scale` is `log` (values of 0 or less
/// clamp to the lower end), and running the other way when `axis.reverse` is set.
internal func scaleInfo(
    _ scale: NiceScale,
    _ range: (Double, Double),
    _ format: ChartNumberFormat,
    _ axis: ChartAxis? = nil
) -> ScaleInfo {
    let logBase: Double? = (axis?.scale == .log) ? (axis?.logBase ?? 10.0) : nil
    let r: (Double, Double) = (axis?.reverse == true) ? (range.1, range.0) : range
    let vs = ChartValueScale(domain: (scale.min, scale.max), range: r, ticks: scale.ticks, logBase: logBase)
    let raw: (Double) -> Double = { v in chartScaleToPixel(v, vs) }
    let px: (Double) -> Double = { v in
        if logBase != nil && !(v > 0) { return r.0 }
        return raw(Swift.min(scale.max, Swift.max(scale.min, v)))
    }
    let fallbackDec: Int? = logBase != nil ? format.decimals : (format.decimals ?? stepDecimals(scale.step))
    let tickText: (Double) -> String = { t in
        formatChartNumber(t, format, fallbackDec)
    }
    return ScaleInfo(
        scale: scale,
        range: r,
        px: px,
        raw: raw,
        zero: px(0),
        format: format,
        tickText: tickText,
        logBase: logBase
    )
}

/// The axes of a category chart: category labels along one side (rotated, thinned or read as
/// dates as space allows), one or two value axes, grid lines and axis titles. Returns the plot
/// box and value ↔ pixel maps.
internal func categoryFrame(_ ctx: LayoutCtx, _ area: ChartRect, _ input: CategoryFrameInput) -> CategoryFrame {
    let spec = ctx.spec
    let theme = ctx.theme
    let measure = ctx.measure
    let fs = ctx.fs
    let labels = input.labels
    let horizontal = input.horizontal
    let primary = input.primary
    let secondary = input.secondary
    let xAxis = input.categoryAxis ?? spec.xAxis
    let n = Swift.max(1, labels.count)
    let titleBand = fs * 1.3 + 6.0
    let labelTarget = input.labelTarget ?? { i in .category(index: i) }

    func estimate(_ v: ValueAxisInput, _ length: Double) -> Double {
        let s = axisScale(v.lo, v.hi, length, v.axis, v.frozen, v.headroom)
        let info = scaleInfo(s, (0, 1), v.format, v.axis)
        return s.ticks.reduce(0.0) { Swift.max($0, measure(info.tickText($1), fs, nil)) }
    }
    let valueLen0 = horizontal ? area.width : area.height
    let valueLabelWidth = primary.axis.show ? estimate(primary, valueLen0) : 0
    let valueLabelWidth2 = (secondary?.axis.show == true) ? estimate(secondary!, valueLen0) : 0
    let catLabelWidth = labels.reduce(0.0) { Swift.max($0, measure($1, fs, nil)) }

    var left: Double = 0
    var bottom: Double = 0
    var right: Double = 8.0
    var top: Double = horizontal ? 4.0 : fs / 2.0 + 2.0
    var rotate: Double = 0
    var dateLabels: ChartDateLabels? = nil
    var rotatedMax: Double = 0
    if horizontal {
        left = (xAxis.show ? Swift.min(catLabelWidth, area.width * 0.35) + 8.0 : 2.0) + (!xAxis.title.isEmpty ? titleBand : 0)
        bottom = (primary.axis.show ? fs * 1.6 : 2.0) + (!primary.axis.title.isEmpty ? titleBand : 0)
        right = Swift.max(8.0, valueLabelWidth / 2.0)
        if let secondary {
            top = (secondary.axis.show ? fs * 1.6 : 4.0) + (!secondary.axis.title.isEmpty ? titleBand : 0)
        }
    } else {
        left = (primary.axis.show ? valueLabelWidth + 8.0 : 2.0) + (!primary.axis.title.isEmpty ? titleBand : 0)
        if let secondary {
            right = (secondary.axis.show ? valueLabelWidth2 + 8.0 : 8.0) + (!secondary.axis.title.isEmpty ? titleBand : 0)
        }
        let band0 = (area.width - left - right) / Double(n)
        if xAxis.show && xAxis.kind == .date {
            dateLabels = chartDateLabels(labels, band0, { t in measure(t, fs, nil) })
        }
        if xAxis.show && dateLabels == nil && catLabelWidth > band0 * 0.92 {
            rotate = -40
        }
        let sinVal = JS.sin(.pi / 4.5)
        let catHeight = rotate != 0 ? Swift.min(catLabelWidth * sinVal + fs, area.height * 0.4) : fs * 1.6
        if rotate != 0 {
            rotatedMax = (catHeight - fs) / sinVal
        }
        bottom = (xAxis.show ? catHeight : 2.0) + (!xAxis.title.isEmpty ? titleBand : 0)
    }

    let plot = ChartRect(
        x: area.x + left,
        y: area.y + top,
        width: Swift.max(1.0, area.width - left - right),
        height: Swift.max(1.0, area.height - bottom - top)
    )
    let valueLen = horizontal ? plot.width : plot.height
    let range: (Double, Double) = horizontal ? (plot.x, plot.x + plot.width) : (plot.y + plot.height, plot.y)
    let value = scaleInfo(
        axisScale(primary.lo, primary.hi, valueLen, primary.axis, primary.frozen, primary.headroom),
        range,
        primary.format,
        primary.axis
    )
    let value2: ScaleInfo? = secondary.map { sec in
        scaleInfo(
            axisScale(sec.lo, sec.hi, valueLen, sec.axis, sec.frozen, sec.headroom),
            range,
            sec.format,
            sec.axis
        )
    }

    let catStart = horizontal ? plot.y : plot.x
    let catLen = horizontal ? plot.height : plot.width
    let band = catLen / Double(n)
    let reverseX = xAxis.reverse == true
    let catCenter: (Double) -> Double = { i in
        catStart + band * (reverseX ? Double(n) - i - 0.5 : i + 0.5)
    }
    let map: (Pt) -> (Double, Double) = { p in
        horizontal ? (p.v, p.c) : (p.c, p.v)
    }

    // Grid lines
    func gridAt(_ info: ScaleInfo, _ key: String) {
        for (i, t) in info.scale.ticks.enumerated() {
            let p = info.px(t)
            let (x1, y1) = map(Pt(c: catStart, v: p))
            let (x2, y2) = map(Pt(c: catStart + catLen, v: p))
            ctx.marks.append(.line(
                key: "grid-\(key)-\(i)",
                role: .grid,
                x1: x1,
                y1: y1,
                x2: x2,
                y2: y2,
                stroke: theme.grid,
                strokeWidth: 1
            ))
        }
    }
    if primary.axis.gridlines { gridAt(value, "y") }
    if let value2, secondary?.axis.gridlines == true { gridAt(value2, "y2") }
    if xAxis.gridlines && n > 1 {
        for i in 1..<n {
            let c = catStart + band * Double(i)
            let (x1, y1) = map(Pt(c: c, v: range.0))
            let (x2, y2) = map(Pt(c: c, v: range.1))
            ctx.marks.append(.line(
                key: "grid-x-\(i)",
                role: .grid,
                x1: x1,
                y1: y1,
                x2: x2,
                y2: y2,
                stroke: theme.grid,
                strokeWidth: 1
            ))
        }
    }

    // Value tick labels
    func ticksFor(_ info: ScaleInfo, _ v: ValueAxisInput, _ far: Bool) {
        guard v.axis.show else { return }
        let target: ChartSelection = .axis(v.key)
        for (i, t) in info.scale.ticks.enumerated() {
            let p = info.px(t)
            let label = info.tickText(t)
            let key = "tick-\(v.key.rawValue)-\(i)"
            if horizontal {
                if far {
                    ctx.marks.append(.text(key: key, role: .tickLabel, x: p, y: plot.y - 6.0, text: label, anchor: .middle, baseline: .bottom, size: fs, fill: theme.mutedText, target: target))
                } else {
                    ctx.marks.append(.text(key: key, role: .tickLabel, x: p, y: plot.y + plot.height + 6.0, text: label, anchor: .middle, baseline: .top, size: fs, fill: theme.mutedText, target: target))
                }
            } else if far {
                ctx.marks.append(.text(key: key, role: .tickLabel, x: plot.x + plot.width + 8.0, y: p, text: label, anchor: .start, baseline: .middle, size: fs, fill: theme.mutedText, target: target))
            } else {
                ctx.marks.append(.text(key: key, role: .tickLabel, x: plot.x - 8.0, y: p, text: label, anchor: .end, baseline: .middle, size: fs, fill: theme.mutedText, target: target))
            }
        }
    }
    ticksFor(value, primary, false)
    if let value2, let secondary { ticksFor(value2, secondary, true) }

    // Category axis line and labels
    let xTarget: ChartSelection = .axis(.x)
    if xAxis.show {
        let (x1, y1) = map(Pt(c: catStart, v: value.zero))
        let (x2, y2) = map(Pt(c: catStart + catLen, v: value.zero))
        ctx.marks.append(.line(
            key: "axis-x",
            role: .axis,
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2,
            stroke: theme.axis,
            strokeWidth: 1,
            target: xTarget
        ))
        let every: Int
        if dateLabels != nil {
            every = 1
        } else if horizontal {
            every = Swift.max(1, Int(ceil((fs * 1.3) / band)))
        } else if rotate != 0 {
            every = Swift.max(1, Int(ceil((fs * 1.4) / band)))
        } else {
            every = 1
        }
        var hidden = 0
        var truncated = 0
        for (i, c) in labels.enumerated() {
            let text0: String?
            if let dateLabels {
                text0 = dateLabels.labels[i]
            } else if i % every != 0 {
                text0 = nil
            } else {
                text0 = c
            }
            guard let text0 else {
                hidden += 1
                continue
            }
            let target = labelTarget(i)
            let selected = target != nil ? ctx.isSelected(target!) : false
            let fill = selected ? theme.selection : theme.mutedText
            let markTarget = target
            let markSelected: Bool? = target != nil ? selected : nil
            if horizontal {
                let maxW = left - (!xAxis.title.isEmpty ? titleBand : 0) - 8.0
                let text = truncate(text0, maxW, fs, measure)
                if text != text0 { truncated += 1 }
                ctx.marks.append(.text(
                    key: "tick-x-\(i)",
                    role: .tickLabel,
                    x: plot.x - 8.0,
                    y: catCenter(Double(i)),
                    text: text,
                    anchor: .end,
                    baseline: .middle,
                    size: fs,
                    fill: fill,
                    target: markTarget,
                    selected: markSelected
                ))
            } else if rotate != 0 {
                let room = (catCenter(Double(i)) - 2.0) / JS.cos(.pi / 4.5)
                let text = truncate(text0, Swift.max(fs, Swift.min(rotatedMax, room)), fs, measure)
                if text != text0 { truncated += 1 }
                ctx.marks.append(.text(
                    key: "tick-x-\(i)",
                    role: .tickLabel,
                    x: catCenter(Double(i)),
                    y: plot.y + plot.height + 8.0,
                    text: text,
                    anchor: .end,
                    baseline: .middle,
                    size: fs,
                    fill: fill,
                    rotate: rotate,
                    target: markTarget,
                    selected: markSelected
                ))
            } else {
                let text = dateLabels != nil ? text0 : truncate(text0, Swift.max(band - 4.0, fs * 2.0), fs, measure)
                if text != text0 { truncated += 1 }
                ctx.marks.append(.text(
                    key: "tick-x-\(i)",
                    role: .tickLabel,
                    x: catCenter(Double(i)),
                    y: plot.y + plot.height + 6.0,
                    text: text,
                    anchor: dateLabels != nil ? .start : .middle,
                    baseline: .top,
                    size: fs,
                    fill: fill,
                    target: markTarget,
                    selected: markSelected
                ))
            }
        }
        if let dateLabels {
            for i in dateLabels.indexes {
                let x = catCenter(Double(i))
                ctx.marks.append(.line(
                    key: "tick-mark-x-\(i)",
                    role: .tick,
                    x1: x,
                    y1: plot.y + plot.height,
                    x2: x,
                    y2: plot.y + plot.height + 4.0,
                    stroke: theme.axis,
                    strokeWidth: 1
                ))
            }
        }
        if hidden > 0 && dateLabels == nil {
            ctx.warn(.labelsHidden, "\(hidden) of \(labels.count) category labels are hidden so the rest do not overlap.")
        }
        if truncated > 0 {
            ctx.warn(.labelsTruncated, "\(truncated) category label\(truncated == 1 ? " was" : "s were") shortened to fit.")
        }
    }

    // Axis titles
    let yTarget: ChartSelection = .axis(.y)
    let valueTitle = primary.axis.title
    let catTitle = xAxis.title
    let bottomTitle = horizontal ? valueTitle : catTitle
    let leftTitle = horizontal ? catTitle : valueTitle
    if !bottomTitle.isEmpty {
        ctx.marks.append(.text(
            key: "axis-title-\(horizontal ? "y" : "x")",
            role: .axisTitle,
            x: plot.x + plot.width / 2.0,
            y: area.y + area.height,
            text: bottomTitle,
            anchor: .middle,
            baseline: .bottom,
            size: fs + 1.0,
            weight: 500,
            fill: theme.text,
            target: horizontal ? yTarget : xTarget
        ))
    }
    if !leftTitle.isEmpty {
        ctx.marks.append(.text(
            key: "axis-title-\(horizontal ? "x" : "y")",
            role: .axisTitle,
            x: area.x,
            y: plot.y + plot.height / 2.0,
            text: leftTitle,
            anchor: .middle,
            baseline: .top,
            size: fs + 1.0,
            weight: 500,
            fill: theme.text,
            rotate: -90,
            target: horizontal ? xTarget : yTarget
        ))
    }
    if let secondary, !secondary.axis.title.isEmpty {
        let target: ChartSelection = .axis(.y2)
        if horizontal {
            ctx.marks.append(.text(
                key: "axis-title-y2",
                role: .axisTitle,
                x: plot.x + plot.width / 2.0,
                y: area.y,
                text: secondary.axis.title,
                anchor: .middle,
                baseline: .top,
                size: fs + 1.0,
                weight: 500,
                fill: theme.text,
                target: target
            ))
        } else {
            ctx.marks.append(.text(
                key: "axis-title-y2",
                role: .axisTitle,
                x: area.x + area.width,
                y: plot.y + plot.height / 2.0,
                text: secondary.axis.title,
                anchor: .middle,
                baseline: .top,
                size: fs + 1.0,
                weight: 500,
                fill: theme.text,
                rotate: 90,
                target: target
            ))
        }
    }

    for axis in [ChartSelectionAxis.x, .y, .y2] {
        guard ctx.isSelected(.axis(axis)) else { continue }
        if axis == .y2 && secondary == nil { continue }
        let box: ChartRect
        if axis == .y2 {
            box = horizontal
                ? ChartRect(x: plot.x - 4.0, y: area.y, width: plot.width + 8.0, height: plot.y - area.y - 2.0)
                : ChartRect(x: plot.x + plot.width + 2.0, y: plot.y - fs / 2.0, width: area.x + area.width - plot.x - plot.width - 2.0, height: plot.height + fs)
        } else {
            let onLeft = (axis == .y) != horizontal
            box = onLeft
                ? ChartRect(x: area.x, y: plot.y - fs / 2.0, width: left - 2.0, height: plot.height + fs)
                : ChartRect(x: plot.x - 4.0, y: plot.y + plot.height + 2.0, width: plot.width + 8.0, height: area.y + area.height - plot.y - plot.height - 2.0)
        }
        ctx.outline("axis-\(axis.rawValue)-selection", box)
    }

    return CategoryFrame(
        plot: plot,
        horizontal: horizontal,
        n: n,
        band: band,
        catStart: catStart,
        catLen: catLen,
        catCenter: catCenter,
        map: map,
        value: value,
        value2: value2
    )
}

internal func toValueScale(_ info: ScaleInfo, _ axis: ChartScaleAxis) -> ChartValueScale {
    ChartValueScale(
        axis: axis,
        domain: (info.scale.min, info.scale.max),
        range: info.range,
        ticks: info.scale.ticks,
        logBase: (info.logBase != nil && info.logBase != 0) ? info.logBase : nil
    )
}

private struct ErrorSpan {
    var center: Double
    var lo: Double
    var hi: Double
}

private func errorBarPath(
    _ map: (Pt) -> (Double, Double),
    _ c: Double,
    _ a: Double,
    _ b: Double,
    _ width: Double,
    _ capA: Bool,
    _ capB: Bool
) -> String {
    if !a.isFinite || !b.isFinite || !c.isFinite || (abs(a - b) < 0.01 && !capA && !capB) {
        return ""
    }
    func at(_ across: Double, _ along: Double) -> String {
        let (x, y) = map(Pt(c: across, v: along))
        return "\(r2s(x)),\(r2s(y))"
    }
    var d = "M\(at(c, a))L\(at(c, b))"
    if capA { d += "M\(at(c - width / 2.0, a))L\(at(c + width / 2.0, a))" }
    if capB { d += "M\(at(c - width / 2.0, b))L\(at(c + width / 2.0, b))" }
    return d
}

private struct Stack {
    var segments: [(Double, Double)?]
}

private func seriesDrawOrder(_ t: ChartSeriesType) -> Int {
    switch t {
    case .area: return 0
    case .bar: return 1
    case .line: return 2
    case .scatter: return 3
    }
}

internal enum PointShapeOrHit: Equatable {
    case marker(ChartMarker)
    case hit
}

/// A point marker: a circle mark, or a path for other shapes.
internal func pointMark(
    key: String,
    target: ChartSelection? = nil,
    selected: Bool? = nil,
    opacity: Double? = nil,
    shape: PointShapeOrHit,
    cx: Double,
    cy: Double,
    r: Double,
    fill: String,
    stroke: String? = nil,
    strokeWidth: Double? = nil
) -> ChartMark {
    switch shape {
    case .hit, .marker(.circle), .marker(.none):
        return .circle(
            key: key,
            role: .point,
            cx: cx,
            cy: cy,
            r: r,
            fill: fill,
            stroke: stroke,
            strokeWidth: stroke != nil ? strokeWidth : nil,
            opacity: opacity,
            target: target,
            selected: selected
        )
    case .marker(let m):
        let closed = m != .cross
        return .path(
            key: key,
            role: .point,
            d: markerPath(m, cx, cy, r),
            fill: closed ? fill : "none",
            stroke: stroke ?? fill,
            strokeWidth: strokeWidth ?? 2,
            opacity: opacity,
            target: target,
            selected: selected
        )
    }
}

internal struct TrendLabel {
    var text: String
    var color: String
    var target: ChartSelection
}

private func drawTrendlines(
    _ ctx: LayoutCtx,
    _ plot: ChartRect,
    _ series: ChartSeries,
    _ color: String,
    _ points: [(Double, Double)],
    _ toPx: (Double, Double) -> (Double, Double),
    _ labels: inout [TrendLabel],
    _ logAxis: Bool = false
) {
    for (ti, t) in (series.trendlines ?? []).enumerated() {
        let target: ChartSelection = .trendline(seriesId: series.id, index: ti)
        let selected = ctx.isSelected(target)
        let stroke = t.color ?? color
        var px: [(Double, Double)] = []
        func finitePx(_ q: (Double, Double)) -> Bool {
            q.0.isFinite && q.1.isFinite
        }
        if t.type == .movingAverage {
            px = chartMovingAverage(points, Double(t.period ?? 2)).map { toPx($0.0, $0.1) }.filter(finitePx)
        } else {
            guard let fit = fitChartTrendline(t, points) else {
                ctx.warn(.valuesSkipped, "The \(t.type.rawValue) trendline on \"\(series.name)\" could not be fitted (too few usable points).")
                continue
            }
            let xs = points.map { $0.0 }
            let lo = (xs.min() ?? .infinity) - (t.backward ?? 0)
            let hi = (xs.max() ?? -.infinity) + (t.forward ?? 0)
            let steps = (t.type == .linear && !logAxis) ? 1 : 200
            for k in 0...steps {
                let x = lo + ((hi - lo) * Double(k)) / Double(steps)
                if let y = fit.evaluate(x) {
                    let q = toPx(x, y)
                    if finitePx(q) { px.append(q) }
                }
            }
            if t.showEquation == true {
                labels.append(TrendLabel(text: fit.equation, color: stroke, target: target))
            }
            if t.showR2 == true {
                let r2Text = fit.r2 == nil ? "R² = #N/A" : "R² = \(trendNumberText(fit.r2!))"
                labels.append(TrendLabel(text: r2Text, color: stroke, target: target))
            }
        }
        let d = clippedPolyline(px, plot)
        guard !d.isEmpty else { continue }
        ctx.marks.append(.path(
            key: "trendline-\(series.id)-\(ti)",
            role: .trendline,
            d: d,
            fill: "none",
            stroke: stroke,
            strokeWidth: selected ? 3 : 1.5,
            dash: "6 4",
            target: target,
            selected: selected
        ))
    }
}

private func drawTrendLabels(_ ctx: LayoutCtx, _ plot: ChartRect, _ labels: [TrendLabel]) {
    for (i, l) in labels.enumerated() {
        ctx.marks.append(.text(
            key: "trendline-label-\(i)",
            role: .trendlineLabel,
            x: plot.x + plot.width - 4.0,
            y: plot.y + 4.0 + Double(i) * (ctx.fs + 3.0),
            text: l.text,
            anchor: .end,
            baseline: .top,
            size: ctx.fs - 1.0,
            fill: l.color,
            target: l.target
        ))
    }
}

private struct BarLabelPlacement {
    var x: Double
    var y: Double
    var anchor: ChartTextAnchor
    var baseline: ChartTextBaseline
    var fill: String
}

private func barLabel(
    _ ctx: LayoutCtx,
    _ text: String,
    _ rect: ChartRect,
    _ horizontal: Bool,
    _ positive: Bool,
    _ stacked: Bool,
    _ fill: String,
    _ plot: ChartRect
) -> BarLabelPlacement? {
    let measure = ctx.measure
    let fs = ctx.fs
    let spec = ctx.spec
    let theme = ctx.theme
    let size = fs - 1.0
    let tw = measure(text, size, nil)
    let th = size + 2.0
    let along = horizontal ? rect.width : rect.height
    let across = horizontal ? rect.height : rect.width
    let need = horizontal ? tw + 6.0 : th + 2.0
    let fitsInside = along >= need && across >= (horizontal ? th : Swift.min(tw, across + 1.0))
    var position = spec.labelPosition
    if position == .auto { position = stacked ? .center : .outside }
    let cx = rect.x + rect.width / 2.0
    let cy = rect.y + rect.height / 2.0
    let inner = contrastingTextColor(fill)
    func centre() -> BarLabelPlacement {
        BarLabelPlacement(x: cx, y: cy, anchor: .middle, baseline: .middle, fill: inner)
    }
    func insideEnd() -> BarLabelPlacement {
        if horizontal {
            return BarLabelPlacement(
                x: positive ? rect.x + rect.width - 4.0 : rect.x + 4.0,
                y: cy,
                anchor: positive ? .end : .start,
                baseline: .middle,
                fill: inner
            )
        } else {
            return BarLabelPlacement(
                x: cx,
                y: positive ? rect.y + 3.0 : rect.y + rect.height - 3.0,
                anchor: .middle,
                baseline: positive ? .top : .bottom,
                fill: inner
            )
        }
    }
    func outside() -> BarLabelPlacement {
        if horizontal {
            return BarLabelPlacement(
                x: positive ? rect.x + rect.width + 4.0 : rect.x - 4.0,
                y: cy,
                anchor: positive ? .start : .end,
                baseline: .middle,
                fill: theme.text
            )
        } else {
            return BarLabelPlacement(
                x: cx,
                y: positive ? rect.y - 4.0 : rect.y + rect.height + 4.0,
                anchor: .middle,
                baseline: positive ? .bottom : .top,
                fill: theme.text
            )
        }
    }
    func outsideFits() -> Bool {
        if horizontal {
            return positive
                ? rect.x + rect.width + 4.0 + tw <= plot.x + plot.width + 8.0
                : rect.x - 4.0 - tw >= plot.x - 8.0
        }
        return positive
            ? rect.y - 4.0 - th >= plot.y - fs
            : rect.y + rect.height + 4.0 + th <= plot.y + plot.height + fs
    }
    if position == .center { return fitsInside ? centre() : nil }
    if position == .inside { return fitsInside ? insideEnd() : (stacked ? nil : outside()) }
    if stacked { return fitsInside ? centre() : nil }
    if outsideFits() { return outside() }
    return fitsInside ? insideEnd() : nil
}

private struct DecimatablePt: ChartXYPoint {
    var x: Double
    var y: Double
    var p: Pt
}

/// Bar, line, area and scatter series over categories (a combo chart when they mix).
internal func layoutCartesian(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let horizontal = spec.orientation == .horizontal
    let n = spec.categories.count
    var types: [String: ChartSeriesType] = [:]
    for s in visible {
        types[s.id] = chartSeriesType(spec, s)
    }
    let stacked = spec.stacking != .none
    let percent = spec.stacking == .percent
    func onSecondary(_ s: ChartSeries) -> Bool {
        s.axis == .secondary
    }
    let useSecondary = visible.contains(where: onSecondary)

    var stacks: [String: Stack] = [:]
    if stacked {
        for kind in [ChartSeriesType.bar, .area] {
            for secondary in [false, true] {
                let group = visible.filter { types[$0.id] == kind && onSecondary($0) == secondary }
                if group.isEmpty { continue }
                let totals: [Double] = (0..<n).map { i in
                    group.reduce(0.0) { t, s in
                        let v = i < s.values.count ? (s.values[i] ?? 0) : 0
                        return t + abs(v)
                    }
                }
                var pos = Array(repeating: 0.0, count: n)
                var neg = Array(repeating: 0.0, count: n)
                for s in group {
                    let segments: [(Double, Double)?] = s.values.enumerated().map { i, raw in
                        if raw == nil && kind == .bar { return nil }
                        var v = raw ?? 0
                        let tot = i < totals.count ? totals[i] : 0
                        if percent { v = tot != 0 ? v / tot : 0 }
                        let base = v >= 0 ? (i < pos.count ? pos[i] : 0) : (i < neg.count ? neg[i] : 0)
                        let seg = (base, base + v)
                        if i < n {
                            if v >= 0 { pos[i] += v }
                            else { neg[i] += v }
                        }
                        return seg
                    }
                    stacks[s.id] = Stack(segments: segments)
                }
            }
        }
    }

    func logOf(_ secondary: Bool) -> Bool {
        (secondary ? spec.yAxis2 : spec.yAxis).scale == .log
    }
    var errors: [String: [ErrorSpan?]] = [:]
    for s in visible {
        guard let eb = s.errorBars else { continue }
        let stack = stacks[s.id]
        errors[s.id] = chartErrorAmounts(eb, s.values).enumerated().map { i, e in
            let raw = i < s.values.count ? s.values[i] : nil
            let seg = (stack != nil && i < stack!.segments.count) ? stack!.segments[i] : nil
            guard let e, let raw, !(stack != nil && seg == nil) else { return nil }
            let k: Double
            if let seg, percent {
                k = raw != 0 ? (seg.1 - seg.0) / raw : 0
            } else {
                k = 1.0
            }
            let center = (seg != nil ? seg!.1 : raw) + (e.center - raw) * k
            return ErrorSpan(center: center, lo: center - e.minus * k, hi: center + e.plus * k)
        }
    }

    func calcRange(_ secondary: Bool) -> (lo: Double, hi: Double, lineLike: Bool) {
        var lo = Double.infinity
        var hi = -Double.infinity
        let log = logOf(secondary)
        func see(_ v: Double) {
            if !v.isFinite || (log && !(v > 0)) { return }
            lo = Swift.min(lo, v)
            hi = Swift.max(hi, v)
        }
        let group = visible.filter { onSecondary($0) == secondary }
        for s in group {
            if let stack = stacks[s.id] {
                for seg in stack.segments {
                    if let seg {
                        see(seg.0)
                        see(seg.1)
                    }
                }
            } else {
                for v in s.values {
                    if let v { see(v) }
                }
            }
            if let sErr = errors[s.id] {
                for e in sErr {
                    if let e {
                        see(e.lo)
                        see(e.hi)
                    }
                }
            }
        }
        for v in referenceValues(spec, secondary ? .y2 : .y) {
            see(v)
        }
        if log {
            let skipped = group.reduce(0) { t, s in
                t + s.values.filter { $0 != nil && $0!.isFinite && $0! <= 0 }.count
            }
            if skipped > 0 {
                ctx.warn(
                    .valuesSkipped,
                    "\(skipped) value\(skipped == 1 ? "" : "s") of 0 or less cannot be drawn on the logarithmic \(secondary ? "secondary " : "")value axis and \(skipped == 1 ? "was" : "were") skipped."
                )
            }
        }
        if !lo.isFinite {
            lo = log ? 1 : 0
            hi = log ? 10 : 1
        }
        if !log && group.contains(where: { types[$0.id] == .bar || types[$0.id] == .area }) {
            lo = Swift.min(lo, 0)
            hi = Swift.max(hi, 0)
        }
        let lineLike = group.contains { types[$0.id] == .line || types[$0.id] == .scatter }
        return (lo, hi, lineLike)
    }

    func pctFormat(_ f: ChartNumberFormat) -> ChartNumberFormat {
        if percent && f.style == nil && (f.code == nil || f.code!.isEmpty) {
            var copy = f
            copy.style = .percent
            return copy
        }
        return f
    }

    let p = calcRange(false)
    let s2 = useSecondary ? calcRange(true) : nil
    let frame = categoryFrame(
        ctx,
        area,
        CategoryFrameInput(
            labels: spec.categories,
            horizontal: horizontal,
            primary: ValueAxisInput(
                lo: p.lo,
                hi: p.hi,
                axis: spec.yAxis,
                format: pctFormat(spec.yAxis.format),
                frozen: ctx.options.valueDomain,
                headroom: p.lineLike,
                key: .y
            ),
            secondary: s2.map { sec in
                ValueAxisInput(
                    lo: sec.lo,
                    hi: sec.hi,
                    axis: spec.yAxis2,
                    format: pctFormat(spec.yAxis2.format),
                    frozen: ctx.options.valueDomain2,
                    headroom: sec.lineLike,
                    key: .y2
                )
            }
        )
    )
    let plot = frame.plot
    let band = frame.band
    let catCenter = frame.catCenter
    let map = frame.map
    let catStart = frame.catStart
    func infoOf(_ s: ChartSeries) -> ScaleInfo {
        if onSecondary(s), let v2 = frame.value2 { return v2 }
        return frame.value
    }
    var refAxes: [ChartReferenceAxis: ReferenceAxis] = [
        .y: ReferenceAxis(info: frame.value, vertical: !horizontal)
    ]
    if let v2 = frame.value2 {
        refAxes[.y2] = ReferenceAxis(info: v2, vertical: !horizontal)
    }
    drawReferences(ctx, plot, refAxes, .bands)

    let bars = visible.filter { types[$0.id] == .bar }
    var barAxes: [Bool] = []
    for s in bars {
        let sec = onSecondary(s)
        if !barAxes.contains(sec) { barAxes.append(sec) }
    }
    let slots = stacked ? barAxes.count : bars.count
    let groupWidth = band * (1.0 - spec.gapWidth)
    let o = Swift.max(-1.0, Swift.min(0.99, spec.overlap))
    let barWidth = slots > 0 ? groupWidth / (Double(slots) - Double(slots - 1) * o) : 0
    func slotOf(_ s: ChartSeries) -> Int {
        if stacked {
            return barAxes.firstIndex(of: onSecondary(s)) ?? 0
        }
        return bars.firstIndex(of: s) ?? 0
    }
    var labelMarks: [ChartMark] = []
    var errorMarks: [ChartMark] = []
    var trendLabels: [TrendLabel] = []
    var hiddenLabels = 0
    let trendsAllowed = chartSupportsTrendlines(spec.type.rawValue, spec.stacking.rawValue)

    let drawOrder = visible.sorted { seriesDrawOrder(types[$0.id]!) < seriesDrawOrder(types[$1.id]!) }
    for s in drawOrder {
        let si = spec.series.firstIndex(of: s) ?? 0
        let color = chartSeriesColor(spec, si)
        let type = types[s.id]!
        let stack = stacks[s.id]
        let selSeries = ctx.seriesSelected(s.id)
        let seriesTarget: ChartSelection = .series(seriesId: s.id)
        let info = infoOf(s)
        let valuePx = info.px
        let log = logOf(onSecondary(s))
        let wantLabels = s.dataLabels ?? spec.dataLabels
        let labelsOn = wantLabels && s.values.count <= MAX_CHART_DATA_LABELS
        if wantLabels && !labelsOn {
            ctx.warn(.dataLabelsHidden, "Data labels are off for \"\(s.name)\": it has more than \(MAX_CHART_DATA_LABELS) points.")
        }
        let labelFormat = s.format ?? info.format
        func dataLabel(_ v: Double) -> String {
            formatChartNumber(v, labelFormat, labelFormat.decimals)
        }

        if type == .bar {
            let slot = slotOf(s)
            for (i, raw) in s.values.enumerated() {
                let seg: (Double, Double)? = stack != nil
                    ? (i < stack!.segments.count ? stack!.segments[i] : nil)
                    : (raw == nil ? nil : (0.0, raw!))
                guard let seg, let raw, raw.isFinite else { continue }
                if log && (raw <= 0 || seg.1 <= 0) { continue }
                let a = valuePx(seg.0)
                let b = valuePx(seg.1)
                let c0 = catCenter(Double(i)) - groupWidth / 2.0 + Double(slot) * barWidth * (1.0 - o)
                let cw = barWidth
                let target: ChartSelection = .point(seriesId: s.id, index: i)
                let selected = ctx.isSelected(target)
                let (x, y) = map(Pt(c: c0, v: Swift.min(a, b)))
                let rect = horizontal
                    ? ChartRect(x: Swift.min(a, b), y: c0, width: abs(b - a), height: cw)
                    : ChartRect(x: x, y: y, width: cw, height: abs(b - a))
                let fill = chartPointColor(spec, si, i)
                ctx.marks.append(.rect(
                    key: "bar-\(s.id)-\(i)",
                    role: .bar,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    fill: fill,
                    stroke: selSeries ? theme.selection : nil,
                    strokeWidth: selSeries ? 1.5 : nil,
                    radius: Swift.min(2.0, cw / 4.0),
                    target: target,
                    selected: selected || selSeries
                ))
                if selected {
                    ctx.outline("bar-\(s.id)-\(i)-selection", ChartRect(x: rect.x - 2.0, y: rect.y - 2.0, width: rect.width + 4.0, height: rect.height + 4.0))
                }
                if labelsOn {
                    let v = percent ? seg.1 - seg.0 : raw
                    let text = dataLabel(v)
                    let grows = horizontal ? b >= a : b <= a
                    guard let at = barLabel(ctx, text, rect, horizontal, grows, stacked, fill, plot) else {
                        hiddenLabels += 1
                        continue
                    }
                    labelMarks.append(.text(
                        key: "label-\(s.id)-\(i)",
                        role: .dataLabel,
                        x: at.x,
                        y: at.y,
                        text: text,
                        anchor: at.anchor,
                        baseline: at.baseline,
                        size: fs - 1.0,
                        fill: at.fill,
                        target: target
                    ))
                }
            }
        } else {
            let curve = s.curve ?? spec.curve
            func pointValue(_ i: Int) -> Double? {
                let v: Double?
                if let stack {
                    v = i < stack.segments.count ? stack.segments[i]?.1 : nil
                } else {
                    v = i < s.values.count ? s.values[i] : nil
                }
                let rawVal = (i < s.values.count ? s.values[i] : nil) ?? 0
                if let v, v.isFinite, !(log && (v <= 0 || rawVal <= 0)) {
                    return v
                }
                return nil
            }
            var runs: [[Pt]] = []
            var run: [Pt] = []
            for i in 0..<n {
                guard let v = pointValue(i) else {
                    if !run.isEmpty { runs.append(run) }
                    run = []
                    continue
                }
                run.append(Pt(c: catCenter(Double(i)), v: valuePx(v), i: i))
            }
            if !run.isEmpty { runs.append(run) }
            func thin(_ r: [Pt]) -> [Pt] {
                if r.count <= MAX_CHART_LINE_POINTS { return r }
                let pts = decimateChartPoints(r.map { DecimatablePt(x: $0.c, y: $0.v, p: $0) }, MAX_CHART_LINE_POINTS).map { $0.p }
                ctx.warn(.pointsDecimated, "\"\(s.name)\" has \(r.count) points; its line is drawn with \(pts.count) (one column of pixels each).")
                return pts
            }
            let drawn = runs.map(thin)

            if type == .area {
                let parts = drawn.map { r -> String in
                    let baseline: [Pt]
                    if let stack {
                        baseline = r.map { pt in
                            let idx = pt.i!
                            let b0 = (idx < stack.segments.count ? stack.segments[idx]?.0 : nil) ?? 0
                            return Pt(c: pt.c, v: valuePx(b0))
                        }.reversed()
                    } else {
                        baseline = [
                            Pt(c: r[r.count - 1].c, v: info.zero),
                            Pt(c: r[0].c, v: info.zero)
                        ]
                    }
                    let baseStr: String
                    if stack != nil {
                        baseStr = curvePath(baseline, curve, map, false)
                    } else {
                        baseStr = baseline.map { pt in
                            let (bx, by) = map(pt)
                            return "L\(r2s(bx)),\(r2s(by))"
                        }.joined()
                    }
                    return "\(curvePath(r, curve, map))\(baseStr)Z"
                }
                ctx.marks.append(.path(
                    key: "area-\(s.id)",
                    role: .area,
                    d: parts.joined(),
                    fill: color,
                    opacity: 0.22,
                    target: seriesTarget,
                    selected: selSeries
                ))
            }
            if type == .line || type == .area {
                ctx.marks.append(.path(
                    key: "line-\(s.id)",
                    role: .line,
                    d: drawn.map { curvePath($0, curve, map) }.joined(),
                    fill: "none",
                    stroke: color,
                    strokeWidth: selSeries ? 3.5 : 2,
                    target: seriesTarget,
                    selected: selSeries
                ))
            }
            let marker: ChartMarker = s.marker ?? (type == .scatter || spec.points ? .circle : .none)
            let showDots = marker != .none
            let thinMarkers = n > MAX_CHART_MARKERS
            var cells = Set<String>()
            for i in 0..<n {
                guard let v = pointValue(i), i < s.values.count, s.values[i] != nil else { continue }
                let (cx, cy) = map(Pt(c: catCenter(Double(i)), v: valuePx(v)))
                if thinMarkers {
                    let cell = "\(JSONValue.jsString(JS.round(cx / 2.0))),\(JSONValue.jsString(JS.round(cy / 2.0)))"
                    if cells.contains(cell) { continue }
                    cells.insert(cell)
                }
                let target: ChartSelection = .point(seriesId: s.id, index: i)
                let selected = ctx.isSelected(target)
                let r = type == .scatter ? 4.5 : 3.5
                let pointColor = chartPointColor(spec, si, i)
                let fill = showDots ? (type == .scatter ? pointColor : theme.surface) : "transparent"
                ctx.marks.append(pointMark(
                    key: "point-\(s.id)-\(i)",
                    target: target,
                    selected: selected || selSeries,
                    opacity: type == .scatter ? 0.85 : nil,
                    shape: showDots ? .marker(marker) : .hit,
                    cx: cx,
                    cy: cy,
                    r: showDots ? r : 6.0,
                    fill: fill,
                    stroke: showDots ? pointColor : nil,
                    strokeWidth: 2
                ))
                if selected {
                    ctx.marks.append(.circle(
                        key: "point-\(s.id)-\(i)-selection",
                        role: .selection,
                        cx: cx,
                        cy: cy,
                        r: r + 3.5,
                        fill: "none",
                        stroke: theme.selection,
                        strokeWidth: 1.5
                    ))
                }
                if labelsOn {
                    let raw = s.values[i]!
                    let shown = (percent && stack != nil && i < stack!.segments.count && stack!.segments[i] != nil)
                        ? stack!.segments[i]!.1 - stack!.segments[i]!.0
                        : raw
                    labelMarks.append(.text(
                        key: "label-\(s.id)-\(i)",
                        role: .dataLabel,
                        x: horizontal ? cx + 8.0 : cx,
                        y: horizontal ? cy : cy - 8.0,
                        text: dataLabel(shown),
                        anchor: horizontal ? .start : .middle,
                        baseline: horizontal ? .middle : .bottom,
                        size: fs - 1.0,
                        fill: theme.text,
                        target: target
                    ))
                }
            }
        }
        if let errs = errors[s.id] {
            let slot = type == .bar ? slotOf(s) : 0
            let capWidth = type == .bar ? Swift.min(10.0, barWidth * 0.5) : 8.0
            let cap = s.errorBars?.cap != false
            for (i, eOpt) in errs.enumerated() {
                let rawVal = (i < s.values.count ? s.values[i] : nil) ?? 0
                guard let e = eOpt, !(log && !(rawVal > 0)) else { continue }
                let c = type == .bar
                    ? catCenter(Double(i)) - groupWidth / 2.0 + Double(slot) * barWidth * (1.0 - o) + barWidth / 2.0
                    : catCenter(Double(i))
                let d = errorBarPath(map, c, valuePx(e.lo), valuePx(e.hi), capWidth, cap && e.lo < e.center, cap && e.hi > e.center)
                if !d.isEmpty {
                    errorMarks.append(.path(
                        key: "error-bar-\(s.id)-\(i)",
                        role: .errorBar,
                        d: d,
                        fill: "none",
                        stroke: type == .bar ? theme.text : color,
                        strokeWidth: selSeries ? 2 : 1.25,
                        target: seriesTarget,
                        selected: selSeries
                    ))
                }
            }
        }
        if trendsAllowed, let trendlines = s.trendlines, !trendlines.isEmpty {
            var points: [(Double, Double)] = []
            for (i, v) in s.values.enumerated() {
                if let v, v.isFinite {
                    points.append((Double(i + 1), v))
                }
            }
            let toPx: (Double, Double) -> (Double, Double) = { x, y in
                map(Pt(c: catCenter(x - 1.0), v: info.raw(y)))
            }
            drawTrendlines(ctx, plot, s, color, points, toPx, &trendLabels, info.logBase != nil)
        }
    }

    drawReferences(ctx, plot, refAxes, .lines)
    ctx.marks.append(contentsOf: errorMarks)
    ctx.marks.append(contentsOf: labelMarks)
    drawTrendLabels(ctx, plot, trendLabels)
    if hiddenLabels > 0 {
        ctx.warn(.dataLabelsHidden, "\(hiddenLabels) data label\(hiddenLabels == 1 ? "" : "s") did not fit and \(hiddenLabels == 1 ? "is" : "are") hidden.")
    }
    return FamilyResult(
        plot: plot,
        valueScale: toValueScale(frame.value, horizontal ? .x : .y),
        valueScale2: frame.value2.map { toValueScale($0, horizontal ? .x : .y) },
        categoryScale: ChartCategoryScale(
            axis: horizontal ? .y : .x,
            start: catStart,
            length: frame.catLen,
            count: frame.n,
            reverse: spec.xAxis.reverse == true
        ),
        percent: percent
    )
}

/// Scatter (with x values) and bubble charts: numeric x against numeric y.
internal func layoutXy(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let measure = ctx.measure
    let fs = ctx.fs
    let bubble = spec.type == .bubble
    let yAxis = spec.yAxis
    let xAxis = spec.xAxis
    let xLog = xAxis.scale == .log
    let yLog = yAxis.scale == .log
    var skipped = 0

    struct XyPoint {
        var i: Int
        var x: Double
        var y: Double
        var size: Double?
    }

    var all: [(s: ChartSeries, pts: [XyPoint])] = []
    for s in visible {
        var out: [XyPoint] = []
        for (i, yOpt) in s.values.enumerated() {
            let xOpt: Double?
            if let sx = s.x, i < sx.count, let xv = sx[i] {
                xOpt = xv
            } else if bubble || s.x == nil {
                xOpt = Double(i + 1)
            } else {
                xOpt = nil
            }
            let sizeOpt: Double? = (s.sizes != nil && i < s.sizes!.count) ? s.sizes![i] : nil
            guard let x = xOpt, let y = yOpt, x.isFinite, y.isFinite else { continue }
            if (xLog && x <= 0) || (yLog && y <= 0) {
                skipped += 1
                continue
            }
            out.append(XyPoint(i: i, x: x, y: y, size: sizeOpt))
        }
        all.append((s: s, pts: out))
    }
    if skipped > 0 {
        let axisLabel = (xLog && yLog) ? "axes" : (xLog ? "x axis" : "value axis")
        ctx.warn(
            .valuesSkipped,
            "\(skipped) point\(skipped == 1 ? "" : "s") with a value of 0 or less cannot be drawn on the logarithmic \(axisLabel) and \(skipped == 1 ? "was" : "were") skipped."
        )
    }

    var yErrors: [String: [ChartErrorAmount?]] = [:]
    var xErrors: [String: [ChartErrorAmount?]] = [:]
    for item in all {
        let s = item.s
        if let eb = s.errorBars {
            yErrors[s.id] = chartErrorAmounts(eb, s.values)
        }
        if let xeb = s.xErrorBars {
            let xVals: [ChartValue] = s.values.indices.map { i in
                if let sx = s.x, i < sx.count, let xv = sx[i] {
                    return xv
                }
                return (bubble || s.x == nil) ? Double(i + 1) : nil
            }
            xErrors[s.id] = chartErrorAmounts(xeb, xVals)
        }
    }

    var xlo = Double.infinity
    var xhi = -Double.infinity
    var ylo = Double.infinity
    var yhi = -Double.infinity
    var maxSize = 0.0
    func seeX(_ v: Double) {
        if !v.isFinite || (xLog && !(v > 0)) { return }
        xlo = Swift.min(xlo, v)
        xhi = Swift.max(xhi, v)
    }
    func seeY(_ v: Double) {
        if !v.isFinite || (yLog && !(v > 0)) { return }
        ylo = Swift.min(ylo, v)
        yhi = Swift.max(yhi, v)
    }
    for (s, pts) in all {
        for p in pts {
            seeX(p.x)
            seeY(p.y)
            if let sz = p.size, sz > maxSize { maxSize = sz }
            if let eyArr = yErrors[s.id], p.i < eyArr.count, let ey = eyArr[p.i] {
                seeY(ey.center - ey.minus)
                seeY(ey.center + ey.plus)
            }
            if let exArr = xErrors[s.id], p.i < exArr.count, let ex = exArr[p.i] {
                seeX(ex.center - ex.minus)
                seeX(ex.center + ex.plus)
            }
        }
        for t in s.trendlines ?? [] {
            guard !pts.isEmpty else { continue }
            let minX = pts.map { $0.x }.min()!
            let maxX = pts.map { $0.x }.max()!
            seeX(minX - (t.backward ?? 0))
            seeX(maxX + (t.forward ?? 0))
        }
    }
    for v in referenceValues(spec, .y) { seeY(v) }
    for v in referenceValues(spec, .x) { seeX(v) }
    if !xlo.isFinite {
        xlo = xLog ? 1 : 0
        xhi = xLog ? 10 : 1
    }
    if !ylo.isFinite {
        ylo = yLog ? 1 : 0
        yhi = yLog ? 10 : 1
    }

    let titleBand = fs * 1.3 + 6.0
    let yEst = axisScale(ylo, yhi, area.height, yAxis, ctx.options.valueDomain, true)
    func yText(_ t: Double, _ step: Double) -> String {
        let fb = yAxis.format.decimals ?? (yLog ? nil : stepDecimals(step))
        return formatChartNumber(t, yAxis.format, fb)
    }
    let maxYLabelW = yEst.ticks.reduce(0.0) { Swift.max($0, measure(yText($1, yEst.step), fs, nil)) }
    let left = (yAxis.show ? maxYLabelW + 8.0 : 2.0) + (!yAxis.title.isEmpty ? titleBand : 0)
    let bottom = (xAxis.show ? fs * 1.6 : 2.0) + (!xAxis.title.isEmpty ? titleBand : 0)
    let plot = ChartRect(
        x: area.x + left,
        y: area.y + fs / 2.0 + 2.0,
        width: Swift.max(1.0, area.width - left - 12.0),
        height: Swift.max(1.0, area.height - bottom - fs / 2.0 - 2.0)
    )
    let maxR = bubble ? Swift.max(4.0, Swift.min(plot.width, plot.height) * 0.08) : 0
    let inset = bubble ? maxR : 0
    let yScale = axisScale(ylo, yhi, plot.height, yAxis, ctx.options.valueDomain, true)
    let xScale = axisScale(xlo, xhi, plot.width, xAxis, ctx.options.xDomain, true)
    let xRange: (Double, Double) = (plot.x + inset, plot.x + plot.width - inset)
    let yRange: (Double, Double) = (plot.y + plot.height - inset, plot.y + inset)
    let xInfo = scaleInfo(xScale, xRange, xAxis.format, xAxis)
    let yInfo = scaleInfo(yScale, yRange, yAxis.format, yAxis)
    let xRaw = xInfo.raw
    let xPx = xInfo.px
    let yRaw = yInfo.raw
    let yPx = yInfo.px
    let xTarget: ChartSelection = .axis(.x)
    let yTarget: ChartSelection = .axis(.y)

    if yAxis.gridlines {
        for (i, t) in yScale.ticks.enumerated() {
            ctx.marks.append(.line(key: "grid-y-\(i)", role: .grid, x1: plot.x, y1: yPx(t), x2: plot.x + plot.width, y2: yPx(t), stroke: theme.grid, strokeWidth: 1))
        }
    }
    if xAxis.gridlines {
        for (i, t) in xScale.ticks.enumerated() {
            ctx.marks.append(.line(key: "grid-x-\(i)", role: .grid, x1: xPx(t), y1: plot.y, x2: xPx(t), y2: plot.y + plot.height, stroke: theme.grid, strokeWidth: 1))
        }
    }
    if yAxis.show {
        for (i, t) in yScale.ticks.enumerated() {
            ctx.marks.append(.text(key: "tick-y-\(i)", role: .tickLabel, x: plot.x - 8.0, y: yPx(t), text: yText(t, yScale.step), anchor: .end, baseline: .middle, size: fs, fill: theme.mutedText, target: yTarget))
        }
    }
    if xAxis.show {
        let y0 = (!yLog && yScale.min <= 0 && yScale.max >= 0) ? yPx(0) : (yAxis.reverse == true ? plot.y : plot.y + plot.height)
        ctx.marks.append(.line(key: "axis-x", role: .axis, x1: plot.x, y1: y0, x2: plot.x + plot.width, y2: y0, stroke: theme.axis, strokeWidth: 1, target: xTarget))
        let xFb = xAxis.format.decimals ?? (xLog ? nil : stepDecimals(xScale.step))
        let texts = xScale.ticks.map { formatChartNumber($0, xAxis.format, xFb) }
        let widest = texts.reduce(0.0) { Swift.max($0, measure($1, fs, nil)) }
        var spacing = Double.infinity
        if xScale.ticks.count > 1 {
            for i in 0..<(xScale.ticks.count - 1) {
                spacing = Swift.min(spacing, abs(xPx(xScale.ticks[i + 1]) - xPx(xScale.ticks[i])))
            }
        }
        let every = Swift.max(1, spacing.isFinite && spacing > 0 ? Int(ceil((widest + 8.0) / spacing)) : 1)
        for (i, t) in xScale.ticks.enumerated() {
            if i % every != 0 { continue }
            ctx.marks.append(.text(key: "tick-x-\(i)", role: .tickLabel, x: xPx(t), y: plot.y + plot.height + 6.0, text: texts[i], anchor: .middle, baseline: .top, size: fs, fill: theme.mutedText, target: xTarget))
        }
    }
    if !xAxis.title.isEmpty {
        ctx.marks.append(.text(key: "axis-title-x", role: .axisTitle, x: plot.x + plot.width / 2.0, y: area.y + area.height, text: xAxis.title, anchor: .middle, baseline: .bottom, size: fs + 1.0, weight: 500, fill: theme.text, target: xTarget))
    }
    if !yAxis.title.isEmpty {
        ctx.marks.append(.text(key: "axis-title-y", role: .axisTitle, x: area.x, y: plot.y + plot.height / 2.0, text: yAxis.title, anchor: .middle, baseline: .top, size: fs + 1.0, weight: 500, fill: theme.text, rotate: -90, target: yTarget))
    }
    for axis in [ChartSelectionAxis.x, .y] {
        guard ctx.isSelected(.axis(axis)) else { continue }
        let box = axis == .y
            ? ChartRect(x: area.x, y: plot.y - fs / 2.0, width: left - 2.0, height: plot.height + fs)
            : ChartRect(x: plot.x - 4.0, y: plot.y + plot.height + 2.0, width: plot.width + 8.0, height: area.y + area.height - plot.y - plot.height - 2.0)
        ctx.outline("axis-\(axis.rawValue)-selection", box)
    }

    let refAxes: [ChartReferenceAxis: ReferenceAxis] = [
        .y: ReferenceAxis(info: yInfo, vertical: true),
        .x: ReferenceAxis(info: xInfo, vertical: false)
    ]
    drawReferences(ctx, plot, refAxes, .bands)

    var labelMarks: [ChartMark] = []
    var errorMarks: [ChartMark] = []
    var trendLabels: [TrendLabel] = []
    for (s, pts) in all {
        let si = spec.series.firstIndex(of: s) ?? 0
        let color = chartSeriesColor(spec, si)
        let type = chartSeriesType(spec, s)
        let selSeries = ctx.seriesSelected(s.id)
        let seriesTarget: ChartSelection = .series(seriesId: s.id)
        if type == .line || type == .area {
            let xy = pts.map { ChartPoint2D(x: xPx($0.x), y: yPx($0.y)) }
            let thinned = xy.count > MAX_CHART_LINE_POINTS ? decimateChartPoints(xy, MAX_CHART_LINE_POINTS) : xy
            if thinned.count < xy.count {
                ctx.warn(.pointsDecimated, "\"\(s.name)\" has \(xy.count) points; its line is drawn with \(thinned.count).")
            }
            let d = curvePath(thinned.map { Pt(c: $0.x, v: $0.y) }, s.curve ?? spec.curve, { ($0.c, $0.v) })
            if !d.isEmpty {
                ctx.marks.append(.path(
                    key: "line-\(s.id)",
                    role: .line,
                    d: d,
                    fill: "none",
                    stroke: color,
                    strokeWidth: selSeries ? 3.5 : 2,
                    target: seriesTarget,
                    selected: selSeries
                ))
            }
        }
        let marker: ChartMarker = bubble ? .circle : (s.marker ?? (type == .scatter || spec.points ? .circle : .none))
        let ordered = bubble ? pts.sorted { ($0.size ?? 0) > ($1.size ?? 0) } : pts
        let labelsOn = (s.dataLabels ?? spec.dataLabels) && pts.count <= MAX_CHART_DATA_LABELS
        let labelFormat = s.format ?? yAxis.format
        var cells = Set<String>()
        for p in ordered {
            let cx = xPx(p.x)
            let cy = yPx(p.y)
            if pts.count > MAX_CHART_MARKERS {
                let cell = "\(JSONValue.jsString(JS.round(cx / 2.0))),\(JSONValue.jsString(JS.round(cy / 2.0)))"
                if cells.contains(cell) { continue }
                cells.insert(cell)
            }
            let target: ChartSelection = .point(seriesId: s.id, index: p.i)
            let selected = ctx.isSelected(target)
            let pointColor = chartPointColor(spec, si, p.i)
            let r: Double
            if bubble {
                if maxSize > 0, let sz = p.size, sz > 0 {
                    r = Swift.max(2.0, sqrt(sz / maxSize) * maxR)
                } else {
                    r = 2.0
                }
            } else {
                r = 4.5
            }
            if bubble {
                ctx.marks.append(.circle(
                    key: "point-\(s.id)-\(p.i)",
                    role: .point,
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: pointColor,
                    stroke: pointColor,
                    strokeWidth: 1,
                    opacity: 0.6,
                    target: target,
                    selected: selected || selSeries
                ))
            } else {
                ctx.marks.append(pointMark(
                    key: "point-\(s.id)-\(p.i)",
                    target: target,
                    selected: selected || selSeries,
                    opacity: 0.85,
                    shape: marker == .none ? .hit : .marker(marker),
                    cx: cx,
                    cy: cy,
                    r: marker == .none ? 6.0 : r,
                    fill: marker == .none ? "transparent" : pointColor,
                    stroke: marker == .none ? nil : pointColor,
                    strokeWidth: 2
                ))
            }
            if selected {
                ctx.marks.append(.circle(
                    key: "point-\(s.id)-\(p.i)-selection",
                    role: .selection,
                    cx: cx,
                    cy: cy,
                    r: r + 3.5,
                    fill: "none",
                    stroke: theme.selection,
                    strokeWidth: 1.5
                ))
            }
            if labelsOn {
                labelMarks.append(.text(
                    key: "label-\(s.id)-\(p.i)",
                    role: .dataLabel,
                    x: cx,
                    y: cy - r - 4.0,
                    text: formatChartNumber(p.y, labelFormat),
                    anchor: .middle,
                    baseline: .bottom,
                    size: fs - 1.0,
                    fill: theme.text,
                    target: target
                ))
            }
        }
        let stroke = color
        func addErrorBar(_ key: String, _ d: String) {
            guard !d.isEmpty else { return }
            errorMarks.append(.path(
                key: key,
                role: .errorBar,
                d: d,
                fill: "none",
                stroke: stroke,
                strokeWidth: selSeries ? 2 : 1.25,
                target: seriesTarget,
                selected: selSeries
            ))
        }
        for p in pts {
            if let eyArr = yErrors[s.id], p.i < eyArr.count, let ey = eyArr[p.i] {
                let lo = ey.center - ey.minus
                let hi = ey.center + ey.plus
                let cap = s.errorBars?.cap != false
                addErrorBar(
                    "error-bar-\(s.id)-\(p.i)",
                    errorBarPath({ ($0.c, $0.v) }, xPx(p.x), yPx(lo), yPx(hi), 8.0, cap && lo < ey.center, cap && hi > ey.center)
                )
            }
            if let exArr = xErrors[s.id], p.i < exArr.count, let ex = exArr[p.i] {
                let lo = ex.center - ex.minus
                let hi = ex.center + ex.plus
                let cap = s.xErrorBars?.cap != false
                addErrorBar(
                    "error-bar-x-\(s.id)-\(p.i)",
                    errorBarPath({ ($0.v, $0.c) }, yPx(p.y), xPx(lo), xPx(hi), 8.0, cap && lo < ex.center, cap && hi > ex.center)
                )
            }
        }
        if let trendlines = s.trendlines, !trendlines.isEmpty {
            drawTrendlines(
                ctx,
                plot,
                s,
                color,
                pts.map { ($0.x, $0.y) },
                { x, y in (xRaw(x), yRaw(y)) },
                &trendLabels,
                xLog || yLog
            )
        }
    }

    drawReferences(ctx, plot, refAxes, .lines)
    ctx.marks.append(contentsOf: errorMarks)
    ctx.marks.append(contentsOf: labelMarks)
    drawTrendLabels(ctx, plot, trendLabels)
    return FamilyResult(
        plot: plot,
        valueScale: toValueScale(yInfo, .y),
        xScale: toValueScale(xInfo, .x)
    )
}

internal struct TrendlineLegendItem {
    var label: String
    var color: String
    var target: ChartSelection
    var after: String
}

/// Legend entries for trendlines (dashed lines after their series).
internal func trendlineLegendItems(_ spec: ChartSpec, _ color: (Int) -> String) -> [TrendlineLegendItem] {
    guard chartSupportsTrendlines(spec.type.rawValue, spec.stacking.rawValue) else { return [] }
    var out: [TrendlineLegendItem] = []
    for (si, s) in spec.series.enumerated() {
        if s.hidden ?? false { continue }
        for (ti, t) in (s.trendlines ?? []).enumerated() {
            out.append(TrendlineLegendItem(
                label: chartTrendlineName(t, s.name),
                color: t.color ?? color(si),
                target: .trendline(seriesId: s.id, index: ti),
                after: s.id
            ))
        }
    }
    return out
}
