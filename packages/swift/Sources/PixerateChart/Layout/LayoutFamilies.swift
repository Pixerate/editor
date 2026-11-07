// Waterfall, funnel, radar, histogram, box-and-whisker and treemap layouts follow
// gridcraft-main/crates/chart/src/render.rs (`waterfall`, `funnel`, `radar`, `histogram`, `box_whisker`,
// `treemap`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore
import PixerateRaster

private func sliceColor(_ ctx: LayoutCtx, _ series: ChartSeries, _ i: Int) -> String {
    if let pc = series.pointColors, i < pc.count, let c = pc[i], !c.isEmpty {
        return c
    }
    return chartSliceColor(ctx.spec, i)
}

/// Pie and donut: the first visible series, one slice per category.
internal func layoutPie(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let selection = ctx.selection
    let values: [Double] = (0..<spec.categories.count).map { i in
        let v: Double? = i < series.values.count ? series.values[i] : nil
        return (v != nil && v!.isFinite) ? Swift.max(0.0, v!) : 0.0
    }
    let total = values.reduce(0.0, +)
    let labelsOn = series.dataLabels ?? spec.dataLabels
    let labelRoom = labelsOn ? fs * 2.2 : 4.0
    let outer = Swift.max(4.0, Swift.min(area.width, area.height) / 2.0 - labelRoom)
    let inner = spec.type == .donut ? outer * spec.innerRadius : 0.0
    let cx = area.x + area.width / 2.0
    let cy = area.y + area.height / 2.0
    let plot = ChartRect(x: cx - outer, y: cy - outer, width: outer * 2.0, height: outer * 2.0)
    if total <= 0 {
        ctx.marks.append(.text(
            key: "empty",
            role: .empty,
            x: cx,
            y: cy,
            text: "No positive values",
            anchor: .middle,
            baseline: .middle,
            size: fs + 1.0,
            fill: theme.mutedText
        ))
        return FamilyResult(plot: plot)
    }
    var angle = 0.0
    let format = series.format ?? spec.yAxis.format
    var hidden = 0
    for (i, v) in values.enumerated() {
        if v <= 0 { continue }
        let sweep = (v / total) * .pi * 2.0
        let start = angle
        let end = angle + sweep
        angle = end
        let target: ChartSelection = .point(seriesId: series.id, index: i)
        let selected = ctx.isSelected(target) || ctx.isSelected(.category(index: i))
        let seriesSel: Bool
        if case .series(let sid) = selection, sid == series.id {
            seriesSel = true
        } else {
            seriesSel = false
        }
        // The selected slice pops out a little.
        let mid = (start + end) / 2.0
        let off = selected ? 6.0 : 0.0
        let ox = cx + off * JS.sin(mid)
        let oy = cy - off * JS.cos(mid)
        ctx.marks.append(.path(
            key: "slice-\(i)",
            role: .slice,
            d: arcPath(ox, oy, outer, inner, start, end),
            fill: sliceColor(ctx, series, i),
            stroke: (selected || seriesSel) ? theme.selection : theme.surface,
            strokeWidth: (selected || seriesSel) ? 2 : 1,
            target: target,
            selected: selected || seriesSel
        ))
        if !labelsOn { continue }
        if sweep <= 0.12 {
            hidden += 1
            continue
        }
        let share = v / total
        let hasFormat = format.style != nil || (format.code != nil && !format.code!.isEmpty)
        let text = hasFormat ? formatChartNumber(v, format) : "\(Int(JS.round(share * 100.0)))%"
        let lr = outer + fs * 1.1
        let lx = ox + lr * JS.sin(mid)
        let ly = oy - lr * JS.cos(mid)
        let sinMid = JS.sin(mid)
        let anchor: ChartTextAnchor = abs(sinMid) < 0.2 ? .middle : (sinMid > 0 ? .start : .end)
        ctx.marks.append(.text(
            key: "label-slice-\(i)",
            role: .dataLabel,
            x: lx,
            y: ly,
            text: text,
            anchor: anchor,
            baseline: .middle,
            size: fs,
            fill: theme.text,
            target: target
        ))
    }
    if hidden > 0 {
        ctx.warn(.dataLabelsHidden, "\(hidden) slice label\(hidden == 1 ? " is" : "s are") hidden: the slices are too thin.")
    }
    if spec.type == .donut && inner > fs * 2.0 {
        ctx.marks.append(.text(
            key: "donut-total",
            role: .dataLabel,
            x: cx,
            y: cy,
            text: formatChartNumber(total, format),
            anchor: .middle,
            baseline: .middle,
            size: Swift.min(theme.titleSize + 4.0, inner / 2.0),
            weight: 600,
            fill: theme.text,
            target: .series(seriesId: series.id)
        ))
    }
    return FamilyResult(plot: plot)
}

/// Radar: one spoke per category, one polygon per series.
internal func layoutRadar(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let n = spec.categories.count
    let maxCatW = spec.categories.reduce(0.0) { Swift.max($0, measure($1, fs, nil)) }
    let labelW = Swift.min(area.width * 0.25, maxCatW)
    let radius = Swift.max(8.0, Swift.min(area.width / 2.0 - labelW - 8.0, area.height / 2.0 - fs * 1.6))
    let cx = area.x + area.width / 2.0
    let cy = area.y + area.height / 2.0
    var lo = 0.0
    var hi = -Double.infinity
    for s in visible {
        for vOpt in s.values {
            if let v = vOpt, v.isFinite {
                lo = Swift.min(lo, v)
                hi = Swift.max(hi, v)
            }
        }
    }
    if !hi.isFinite { hi = 1.0 }
    var scale = axisScale(lo, hi, radius, spec.yAxis, ctx.options.valueDomain)
    if let radarTicks = spec.radarTicks, spec.yAxis.scale != .log {
        let step = (scale.max - scale.min) / Double(radarTicks)
        let ticks = (0...radarTicks).map { k -> Double in
            let raw = scale.min + step * Double(k)
            return Double(jsToPrecision(raw, 12)) ?? raw
        }
        scale = NiceScale(min: scale.min, max: scale.max, step: step, ticks: ticks)
    }
    func rOf(_ v: Double) -> Double {
        linearMap(Swift.min(scale.max, Swift.max(scale.min, v)), (scale.min, scale.max), (0.0, radius))
    }
    func angle(_ i: Int) -> Double {
        (Double(i) / Double(n)) * .pi * 2.0
    }
    func at(_ i: Int, _ r: Double) -> (Double, Double) {
        let a = angle(i)
        return (cx + r * JS.sin(a), cy - r * JS.cos(a))
    }
    let yTarget: ChartSelection = .axis(.y)
    if spec.yAxis.gridlines {
        for (k, t) in scale.ticks.enumerated() {
            let r = rOf(t)
            if r <= 0 { continue }
            if spec.radarGraticule == .circle {
                ctx.marks.append(.circle(
                    key: "grid-ring-\(k)",
                    role: .grid,
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: "none",
                    stroke: theme.grid,
                    strokeWidth: 1
                ))
                continue
            }
            let d = (0..<n).map { i -> String in
                let (x, y) = at(i, r)
                return "\(i > 0 ? "L" : "M")\(r2s(x)),\(r2s(y))"
            }.joined() + "Z"
            ctx.marks.append(.path(
                key: "grid-ring-\(k)",
                role: .grid,
                d: d,
                fill: "none",
                stroke: theme.grid,
                strokeWidth: 1
            ))
        }
    }
    for i in 0..<n {
        let (x, y) = at(i, radius)
        ctx.marks.append(.line(
            key: "spoke-\(i)",
            role: .axis,
            x1: cx,
            y1: cy,
            x2: x,
            y2: y,
            stroke: theme.grid,
            strokeWidth: 1,
            target: .axis(.x)
        ))
        if spec.xAxis.show {
            let (lx, ly) = at(i, radius + 8.0)
            let s = JS.sin(angle(i))
            let c = JS.cos(angle(i))
            let target: ChartSelection = .category(index: i)
            let selected = ctx.isSelected(target)
            let anchor: ChartTextAnchor = abs(s) < 0.2 ? .middle : (s > 0 ? .start : .end)
            let baseline: ChartTextBaseline = abs(c) < 0.2 ? .middle : (c > 0 ? .bottom : .top)
            ctx.marks.append(.text(
                key: "tick-x-\(i)",
                role: .tickLabel,
                x: lx,
                y: ly,
                text: truncate(spec.categories[i], labelW, fs, measure),
                anchor: anchor,
                baseline: baseline,
                size: fs,
                fill: selected ? theme.selection : theme.mutedText,
                target: target,
                selected: selected
            ))
        }
    }
    if spec.yAxis.show {
        for (k, t) in scale.ticks.enumerated() {
            let r = rOf(t)
            ctx.marks.append(.text(
                key: "tick-y-\(k)",
                role: .tickLabel,
                x: cx + 4.0,
                y: cy - r,
                text: formatChartNumber(t, spec.yAxis.format, spec.yAxis.format.decimals ?? stepDecimals(scale.step)),
                anchor: .start,
                baseline: .bottom,
                size: fs - 1.0,
                fill: theme.mutedText,
                target: yTarget
            ))
        }
    }
    for s in visible {
        let si = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
        let color = chartSeriesColor(spec, si)
        let selSeries = ctx.seriesSelected(s.id)
        let pts: [(Double, Double)?] = s.values.enumerated().map { i, vOpt in
            guard let v = vOpt, v.isFinite else { return nil }
            return at(i, rOf(v))
        }
        let present = pts.compactMap { $0 }
        if present.isEmpty { continue }
        let d = present.enumerated().map { i, pt in
            "\(i > 0 ? "L" : "M")\(r2s(pt.0)),\(r2s(pt.1))"
        }.joined() + "Z"
        let sTarget: ChartSelection = .series(seriesId: s.id)
        ctx.marks.append(.path(
            key: "area-\(s.id)",
            role: .area,
            d: d,
            fill: color,
            opacity: s.type == .line ? 0 : 0.15,
            target: sTarget,
            selected: selSeries
        ))
        ctx.marks.append(.path(
            key: "line-\(s.id)",
            role: .line,
            d: d,
            fill: "none",
            stroke: color,
            strokeWidth: selSeries ? 3.5 : 2,
            target: sTarget,
            selected: selSeries
        ))
        for (i, pOpt) in pts.enumerated() {
            guard let p = pOpt else { continue }
            let target: ChartSelection = .point(seriesId: s.id, index: i)
            let selected = ctx.isSelected(target)
            ctx.marks.append(.circle(
                key: "point-\(s.id)-\(i)",
                role: .point,
                cx: p.0,
                cy: p.1,
                r: spec.points ? 3.5 : 6,
                fill: spec.points ? theme.surface : "transparent",
                stroke: spec.points ? color : nil,
                strokeWidth: spec.points ? 2 : nil,
                target: target,
                selected: selected || selSeries
            ))
            if selected {
                ctx.marks.append(.circle(
                    key: "point-\(s.id)-\(i)-selection",
                    role: .selection,
                    cx: p.0,
                    cy: p.1,
                    r: 7,
                    fill: "none",
                    stroke: theme.selection,
                    strokeWidth: 1.5
                ))
            }
            if s.dataLabels ?? spec.dataLabels {
                ctx.marks.append(.text(
                    key: "label-\(s.id)-\(i)",
                    role: .dataLabel,
                    x: p.0,
                    y: p.1 - 6.0,
                    text: formatChartNumber(s.values[i], s.format ?? spec.yAxis.format),
                    anchor: .middle,
                    baseline: .bottom,
                    size: fs - 1.0,
                    fill: theme.text,
                    target: target
                ))
            }
        }
    }
    return FamilyResult(plot: ChartRect(x: cx - radius, y: cy - radius, width: radius * 2.0, height: radius * 2.0))
}

/// Waterfall: the first series as running increases (positive colour) and decreases (negative colour).
internal func layoutWaterfall(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    func isTotal(_ label: String) -> Bool {
        label.range(of: #"\b(sub)?total\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
    struct Step {
        var label: String
        var index: Int?
        var from: Double
        var to: Double
        var total: Bool
    }
    var steps: [Step] = []
    var running = 0.0
    for (i, label) in spec.categories.enumerated() {
        let v: Double? = i < series.values.count ? series.values[i] : nil
        if isTotal(label) {
            steps.append(Step(label: label, index: i, from: 0, to: running, total: true))
            continue
        }
        let delta: Double = (v != nil && v!.isFinite) ? v! : 0.0
        steps.append(Step(label: label, index: i, from: running, to: running + delta, total: false))
        running += delta
    }
    if spec.showTotal && !(steps.last?.total == true) {
        steps.append(Step(label: "Total", index: nil, from: 0, to: running, total: true))
    }
    var lo = 0.0
    var hi = 0.0
    for s in steps {
        lo = Swift.min(lo, s.from, s.to)
        hi = Swift.max(hi, s.from, s.to)
    }
    let horizontal = spec.orientation == .horizontal
    let frame = categoryFrame(
        ctx,
        area,
        CategoryFrameInput(
            labels: steps.map { $0.label },
            horizontal: horizontal,
            primary: ValueAxisInput(
                lo: lo,
                hi: hi,
                axis: spec.yAxis,
                format: spec.yAxis.format,
                frozen: ctx.options.valueDomain,
                key: .y
            ),
            labelTarget: { k in
                guard k < steps.count, let idx = steps[k].index else { return nil }
                return .category(index: idx)
            }
        )
    )
    let band = frame.band
    let catCenter = frame.catCenter
    let map = frame.map
    let value = frame.value
    let w = band * (1.0 - spec.gapWidth)
    let origIdx = spec.series.firstIndex(where: { $0.id == series.id }) ?? 0
    let color = chartSeriesColor(spec, origIdx)
    let format = series.format ?? spec.yAxis.format
    let labelsOn = series.dataLabels ?? spec.dataLabels
    var prevEnd: Double? = nil
    for (k, s) in steps.enumerated() {
        let a = value.px(s.from)
        let b = value.px(s.to)
        let c0 = catCenter(Double(k)) - w / 2.0
        let (x, y) = map(Pt(c: c0, v: Swift.min(a, b)))
        let rect = horizontal
            ? ChartRect(x: Swift.min(a, b), y: c0, width: Swift.max(1.0, abs(b - a)), height: w)
            : ChartRect(x: x, y: y, width: w, height: Swift.max(1.0, abs(b - a)))
        let fill = s.total ? color : (s.to >= s.from ? theme.positive : theme.negative)
        let target: ChartSelection = s.index != nil
            ? .point(seriesId: series.id, index: s.index!)
            : .series(seriesId: series.id)
        let selected = ctx.isSelected(target)
        let idxKey = s.index.map(String.init) ?? "total"
        ctx.marks.append(.rect(
            key: "bar-\(series.id)-\(idxKey)",
            role: .bar,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            fill: fill,
            radius: Swift.min(2.0, w / 4.0),
            target: target,
            selected: selected
        ))
        if selected {
            ctx.outline(
                "bar-\(series.id)-\(idxKey)-selection",
                ChartRect(x: rect.x - 2.0, y: rect.y - 2.0, width: rect.width + 4.0, height: rect.height + 4.0)
            )
        }
        if let prevEnd {
            let (x1, y1) = map(Pt(c: catCenter(Double(k - 1)) + w / 2.0, v: value.px(prevEnd)))
            let (x2, y2) = map(Pt(c: c0, v: value.px(prevEnd)))
            ctx.marks.append(.line(
                key: "connector-\(k)",
                role: .connector,
                x1: x1,
                y1: y1,
                x2: x2,
                y2: y2,
                stroke: theme.axis,
                strokeWidth: 1,
                dash: "3 3"
            ))
        }
        prevEnd = s.to
        if labelsOn {
            let text = formatChartNumber(s.total ? s.to : s.to - s.from, format)
            let up = s.to >= s.from
            let vPos = horizontal
                ? Swift.max(a, b) + 4.0
                : (up ? Swift.min(a, b) - 4.0 : Swift.max(a, b) + 4.0)
            let (lx, ly) = map(Pt(c: catCenter(Double(k)), v: vPos))
            ctx.marks.append(.text(
                key: "label-\(series.id)-\(idxKey)",
                role: .dataLabel,
                x: lx,
                y: ly,
                text: text,
                anchor: horizontal ? .start : .middle,
                baseline: horizontal ? .middle : (up ? .bottom : .top),
                size: fs - 1.0,
                fill: theme.text,
                target: target
            ))
        }
    }
    return FamilyResult(
        plot: frame.plot,
        valueScale: toValueScale(value, horizontal ? .x : .y)
    )
}

/// Histogram: every value of the visible series, binned; one bar per series in each bin.
internal func layoutHistogram(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let fs = ctx.fs
    let theme = ctx.theme
    let pooled = visible.flatMap { $0.values }
    let bins = chartHistogram(pooled, spec.bins)
    if bins.isEmpty { return FamilyResult(plot: area) }
    let edgeFormat = spec.xAxis.format
    func edges(_ b: ChartHistogramBin, _ k: Int) -> String {
        "\(k == 0 ? "[" : "(")\(formatChartNumber(b.from, edgeFormat)), \(formatChartNumber(b.to, edgeFormat))]"
    }
    let counts: [[Int]] = visible.map { s in
        var c = Array(repeating: 0, count: bins.count)
        for vOpt in s.values {
            guard let v = vOpt, v.isFinite else { continue }
            var k = bins.firstIndex(where: { v <= $0.to }) ?? -1
            if k < 0 { k = bins.count - 1 }
            c[k] += 1
        }
        return c
    }
    let maxCount = Double(Swift.max(1, counts.flatMap { $0 }.max() ?? 1))
    let hasCustomY = (spec.yAxis.format.code != nil && !spec.yAxis.format.code!.isEmpty) || spec.yAxis.format.style != nil
    let histFmt = hasCustomY ? spec.yAxis.format : ChartNumberFormat(decimals: 0)
    var yAxis = spec.yAxis
    yAxis.format = histFmt
    let frame = categoryFrame(
        ctx,
        area,
        CategoryFrameInput(
            labels: bins.enumerated().map { k, b in edges(b, k) },
            horizontal: false,
            primary: ValueAxisInput(
                lo: 0,
                hi: maxCount,
                axis: yAxis,
                format: histFmt,
                frozen: nil,
                key: .y
            ),
            labelTarget: { _ in nil }
        )
    )
    let band = frame.band
    let catCenter = frame.catCenter
    let value = frame.value
    let plot = frame.plot
    let k = visible.count
    let gap = k > 1 ? band * spec.gapWidth * 0.5 : 0.0
    let w = (band - gap) / Double(k)
    for (si, s) in visible.enumerated() {
        let origIdx = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
        let color = chartSeriesColor(spec, origIdx)
        let target: ChartSelection = .series(seriesId: s.id)
        let selected = ctx.seriesSelected(s.id)
        for (b, c) in counts[si].enumerated() {
            if c == 0 { continue }
            let top = value.px(Double(c))
            let x = catCenter(Double(b)) - band / 2.0 + gap / 2.0 + Double(si) * w
            ctx.marks.append(.rect(
                key: "bar-\(s.id)-\(b)",
                role: .bar,
                x: x,
                y: top,
                width: w,
                height: value.zero - top,
                fill: color,
                stroke: theme.surface,
                strokeWidth: 0.75,
                opacity: k > 1 ? 0.85 : nil,
                target: target,
                selected: selected
            ))
            if s.dataLabels ?? spec.dataLabels {
                ctx.marks.append(.text(
                    key: "label-\(s.id)-\(b)",
                    role: .dataLabel,
                    x: x + w / 2.0,
                    y: top - 3.0,
                    text: String(c),
                    anchor: .middle,
                    baseline: .bottom,
                    size: fs - 1.0,
                    fill: theme.text,
                    target: target
                ))
            }
        }
    }
    return FamilyResult(plot: plot)
}

/// Box and whiskers: one box per visible series (quartiles, median, mean ×, whiskers at 1.5 × IQR, outliers).
internal func layoutBox(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let stats = visible.map { chartBoxStats($0.values) }
    var lo = Double.infinity
    var hi = -Double.infinity
    for st in stats {
        if let st {
            lo = Swift.min(lo, st.min)
            hi = Swift.max(hi, st.max)
        }
    }
    if !lo.isFinite {
        lo = 0
        hi = 1
    }
    let frame = categoryFrame(
        ctx,
        area,
        CategoryFrameInput(
            labels: visible.map { $0.name },
            horizontal: false,
            primary: ValueAxisInput(
                lo: lo,
                hi: hi,
                axis: spec.yAxis,
                format: spec.yAxis.format,
                frozen: ctx.options.valueDomain,
                headroom: true,
                key: .y
            ),
            labelTarget: { i in .series(seriesId: visible[i].id) }
        )
    )
    let band = frame.band
    let catCenter = frame.catCenter
    let value = frame.value
    let plot = frame.plot
    let bw = Swift.min(80.0, band * (1.0 - spec.gapWidth) * 0.6)
    for (i, s) in visible.enumerated() {
        guard let st = stats[i] else { continue }
        let origIdx = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
        let color = chartSeriesColor(spec, origIdx)
        let target: ChartSelection = .series(seriesId: s.id)
        let selected = ctx.seriesSelected(s.id)
        let c = catCenter(Double(i))
        let y = value.px
        func line(_ key: String, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ width: Double = 1.25, _ stroke: String? = nil) {
            ctx.marks.append(.line(
                key: key,
                role: .whisker,
                x1: x1,
                y1: y1,
                x2: x2,
                y2: y2,
                stroke: stroke ?? color,
                strokeWidth: width,
                target: target
            ))
        }
        line("whisker-hi-\(s.id)", c, y(st.upperWhisker), c, y(st.q3))
        line("whisker-lo-\(s.id)", c, y(st.q1), c, y(st.lowerWhisker))
        line("cap-hi-\(s.id)", c - bw / 4.0, y(st.upperWhisker), c + bw / 4.0, y(st.upperWhisker))
        line("cap-lo-\(s.id)", c - bw / 4.0, y(st.lowerWhisker), c + bw / 4.0, y(st.lowerWhisker))
        let top = y(st.q3)
        let bottom = y(st.q1)
        ctx.marks.append(.rect(
            key: "box-\(s.id)",
            role: .box,
            x: c - bw / 2.0,
            y: top,
            width: bw,
            height: Swift.max(0.5, bottom - top),
            fill: color,
            stroke: selected ? theme.selection : color,
            strokeWidth: selected ? 2.5 : 1.5,
            opacity: 0.3,
            target: target,
            selected: selected
        ))
        line("median-\(s.id)", c - bw / 2.0, y(st.median), c + bw / 2.0, y(st.median), 2.5)
        let my = y(st.mean)
        ctx.marks.append(.path(
            key: "mean-\(s.id)",
            role: .whisker,
            d: "M\(r2s(c - 3.0)),\(r2s(my - 3.0))L\(r2s(c + 3.0)),\(r2s(my + 3.0))M\(r2s(c - 3.0)),\(r2s(my + 3.0))L\(r2s(c + 3.0)),\(r2s(my - 3.0))",
            fill: "none",
            stroke: color,
            strokeWidth: 1.25,
            target: target
        ))
        for (k, o) in st.outliers.prefix(500).enumerated() {
            ctx.marks.append(.circle(
                key: "outlier-\(s.id)-\(k)",
                role: .outlier,
                cx: c,
                cy: y(o),
                r: 2.5,
                fill: "none",
                stroke: color,
                strokeWidth: 1,
                target: target
            ))
        }
        if s.dataLabels ?? spec.dataLabels {
            ctx.marks.append(.text(
                key: "label-\(s.id)-median",
                role: .dataLabel,
                x: c + bw / 2.0 + 4.0,
                y: y(st.median),
                text: formatChartNumber(st.median, s.format ?? spec.yAxis.format),
                anchor: .start,
                baseline: .middle,
                size: fs - 1.0,
                fill: theme.text,
                target: target
            ))
        }
    }
    return FamilyResult(plot: plot, valueScale: toValueScale(value, .y))
}

/// Funnel: the first series, one centred bar per category, widths proportional to the values.
internal func layoutFunnel(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let n = spec.categories.count
    let maxCatW = spec.categories.reduce(0.0) { Swift.max($0, measure($1, fs, nil)) }
    let labelW = spec.xAxis.show ? Swift.min(area.width * 0.3, maxCatW) + 10.0 : 0.0
    let plot = ChartRect(x: area.x + labelW, y: area.y, width: Swift.max(1.0, area.width - labelW), height: area.height)
    let maxVal = series.values.reduce(0.0) { acc, vOpt in
        guard let v = vOpt, v.isFinite else { return acc }
        return Swift.max(acc, abs(v))
    }
    let band = plot.height / Double(Swift.max(1, n))
    let h = band * (1.0 - Swift.min(0.5, spec.gapWidth * 0.5))
    let format = series.format ?? spec.yAxis.format
    let labelsOn = series.dataLabels ?? true
    let cx = plot.x + plot.width / 2.0
    for (i, label) in spec.categories.enumerated() {
        let v: Double? = i < series.values.count ? series.values[i] : nil
        let cy = plot.y + band * (Double(i) + 0.5)
        let target: ChartSelection = .point(seriesId: series.id, index: i)
        let selected = ctx.isSelected(target)
        if spec.xAxis.show {
            let catTarget: ChartSelection = .category(index: i)
            ctx.marks.append(.text(
                key: "tick-x-\(i)",
                role: .tickLabel,
                x: plot.x - 8.0,
                y: cy,
                text: truncate(label, labelW - 10.0, fs, measure),
                anchor: .end,
                baseline: .middle,
                size: fs,
                fill: ctx.isSelected(catTarget) ? theme.selection : theme.mutedText,
                target: catTarget
            ))
        }
        guard let v, v.isFinite, maxVal > 0 else { continue }
        let w = Swift.max(1.0, (abs(v) / maxVal) * plot.width)
        let fill = sliceColor(ctx, series, i)
        ctx.marks.append(.rect(
            key: "bar-\(series.id)-\(i)",
            role: .bar,
            x: cx - w / 2.0,
            y: cy - h / 2.0,
            width: w,
            height: h,
            fill: fill,
            radius: 2,
            target: target,
            selected: selected
        ))
        if selected {
            ctx.outline(
                "bar-\(series.id)-\(i)-selection",
                ChartRect(x: cx - w / 2.0 - 2.0, y: cy - h / 2.0 - 2.0, width: w + 4.0, height: h + 4.0)
            )
        }
        if labelsOn {
            let text = formatChartNumber(v, format)
            let fits = measure(text, fs, nil) + 8.0 <= w && fs + 2.0 <= h
            ctx.marks.append(.text(
                key: "label-\(series.id)-\(i)",
                role: .dataLabel,
                x: fits ? cx : cx + w / 2.0 + 4.0,
                y: cy,
                text: text,
                anchor: fits ? .middle : .start,
                baseline: .middle,
                size: fs,
                fill: fits ? contrastingTextColor(fill) : theme.text,
                target: target
            ))
        }
    }
    return FamilyResult(plot: plot)
}

/// Treemap: the first series' positive values as nested rectangles (squarified), labelled where they fit.
internal func layoutTreemap(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let values: [Double] = (0..<spec.categories.count).map { i in
        let v: Double? = i < series.values.count ? series.values[i] : nil
        return (v != nil && v!.isFinite) ? v! : 0.0
    }
    let rects = chartSquarify(values, area)
    let format = series.format ?? spec.yAxis.format
    let labelsOn = series.dataLabels ?? true
    var unlabelled = 0
    for (i, r) in rects.enumerated() {
        if r.width <= 0 || r.height <= 0 { continue }
        let target: ChartSelection = .point(seriesId: series.id, index: i)
        let selected = ctx.isSelected(target) || ctx.isSelected(.category(index: i))
        let fill = sliceColor(ctx, series, i)
        ctx.marks.append(.rect(
            key: "cell-\(i)",
            role: .cell,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            fill: fill,
            stroke: selected ? theme.selection : theme.surface,
            strokeWidth: selected ? 2.5 : 1.5,
            target: target,
            selected: selected
        ))
        if !labelsOn { continue }
        let room = r.width - 8.0
        if room < fs * 2.0 || r.height < fs * 1.5 {
            unlabelled += 1
            continue
        }
        let color = contrastingTextColor(fill)
        ctx.marks.append(.text(
            key: "label-cell-\(i)",
            role: .dataLabel,
            x: r.x + 4.0,
            y: r.y + 4.0,
            text: truncate(spec.categories[i], room, fs, measure),
            anchor: .start,
            baseline: .top,
            size: fs,
            weight: 600,
            fill: color,
            target: target
        ))
        if r.height >= fs * 3.0 {
            ctx.marks.append(.text(
                key: "label-value-\(i)",
                role: .dataLabel,
                x: r.x + 4.0,
                y: r.y + 6.0 + fs * 1.2,
                text: truncate(formatChartNumber(values[i], format), room, fs - 1.0, measure),
                anchor: .start,
                baseline: .top,
                size: fs - 1.0,
                fill: color,
                target: target
            ))
        }
    }
    if unlabelled > 0 {
        ctx.warn(.dataLabelsHidden, "\(unlabelled) treemap cell\(unlabelled == 1 ? " is" : "s are") too small for a label.")
    }
    return FamilyResult(plot: area)
}

/// Spreads label centres (sorted top to bottom) at least `gap` apart, kept within [top, bottom].
private func dodge(_ ys: [Double], _ gap: Double, _ top: Double, _ bottom: Double) -> [Double] {
    var out = ys
    if out.count > 1 {
        for k in 1..<out.count {
            out[k] = Swift.max(out[k], out[k - 1] + gap)
        }
    }
    let over = out.isEmpty ? 0.0 : out[out.count - 1] - bottom
    if over > 0 {
        var k = out.count - 1
        while k >= 0 {
            let cap = k < out.count - 1 ? out[k + 1] - gap : Double.infinity
            out[k] = Swift.max(top, Swift.min(out[k] - over, cap))
            k -= 1
        }
    }
    return out
}

/// Slope: each category's value in the first series (left) joined to the second (right), labelled at both ends.
internal func layoutSlope(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let a = visible[0]
    let b = visible[1]
    if visible.count > 2 {
        ctx.warn(.valuesSkipped, "A slope chart joins two series; \(visible.count - 2) more \(visible.count == 3 ? "is" : "are") not drawn.")
    }
    func at(_ s: ChartSeries, _ i: Int) -> Double? {
        guard i < s.values.count, let v = s.values[i], v.isFinite else { return nil }
        return v
    }
    var all: [Double] = []
    for i in 0..<spec.categories.count {
        if let va = at(a, i) { all.append(va) }
        if let vb = at(b, i) { all.append(vb) }
    }
    let lo = all.min() ?? Double.infinity
    let hi = all.max() ?? -Double.infinity
    let labelsOn = a.dataLabels ?? b.dataLabels ?? spec.dataLabels
    let fmtA: (Double) -> String = { v in formatChartNumber(v, a.format ?? spec.yAxis.format) }
    let fmtB: (Double) -> String = { v in formatChartNumber(v, b.format ?? spec.yAxis.format) }
    let leftText: (Int) -> String = { i in
        if labelsOn, let v = at(a, i) {
            return "\(spec.categories[i])  \(fmtA(v))"
        }
        return spec.categories[i]
    }
    let rightText: (Int) -> String = { i in
        if labelsOn, let v = at(b, i) {
            return "\(fmtB(v))  \(spec.categories[i])"
        }
        return spec.categories[i]
    }
    let maxW = area.width * 0.3
    let leftW = Swift.min(maxW, (0..<spec.categories.count).reduce(0.0) { Swift.max($0, measure(leftText($1), fs, nil)) })
    let rightW = Swift.min(maxW, (0..<spec.categories.count).reduce(0.0) { Swift.max($0, measure(rightText($1), fs, nil)) })
    let headerH = fs * 1.8
    let plot = ChartRect(
        x: area.x + leftW + 10.0,
        y: area.y + headerH + fs / 2.0,
        width: Swift.max(1.0, area.width - leftW - rightW - 20.0),
        height: Swift.max(1.0, area.height - headerH - fs)
    )
    let scale = axisScale(lo, hi, plot.height, spec.yAxis, ctx.options.valueDomain, true)
    func yOf(_ v: Double) -> Double {
        linearMap(Swift.min(scale.max, Swift.max(scale.min, v)), (scale.min, scale.max), (plot.y + plot.height, plot.y))
    }
    let xL = plot.x
    let xR = plot.x + plot.width
    for (s, x, anchor) in [(a, xL, ChartTextAnchor.end), (b, xR, ChartTextAnchor.start)] {
        let target: ChartSelection = .series(seriesId: s.id)
        let selected = ctx.seriesSelected(s.id)
        ctx.marks.append(.line(
            key: "axis-slope-\(s.id)",
            role: .axis,
            x1: x,
            y1: plot.y,
            x2: x,
            y2: plot.y + plot.height,
            stroke: theme.axis,
            strokeWidth: 1,
            target: target
        ))
        ctx.marks.append(.text(
            key: "axis-title-\(s.id)",
            role: .axisTitle,
            x: x,
            y: area.y,
            text: truncate(s.name, maxW + plot.width / 2.0, fs + 1.0, measure),
            anchor: anchor,
            baseline: .top,
            size: fs + 1.0,
            weight: 600,
            fill: selected ? theme.selection : theme.text,
            target: target,
            selected: selected
        ))
    }
    struct SlopeLabel {
        var i: Int
        var y: Double
    }
    var leftLabels: [SlopeLabel] = []
    var rightLabels: [SlopeLabel] = []
    for i in 0..<spec.categories.count {
        let va = at(a, i)
        let vb = at(b, i)
        let color = sliceColor(ctx, a, i)
        let catTarget: ChartSelection = .category(index: i)
        let catSelected = ctx.isSelected(catTarget)
        if let va, let vb {
            ctx.marks.append(.line(
                key: "line-slope-\(i)",
                role: .line,
                x1: xL,
                y1: yOf(va),
                x2: xR,
                y2: yOf(vb),
                stroke: color,
                strokeWidth: catSelected ? 3.5 : 2,
                target: catTarget,
                selected: catSelected
            ))
        }
        for (isRight, s, vOpt, x) in [(false, a, va, xL), (true, b, vb, xR)] {
            guard let v = vOpt else { continue }
            let target: ChartSelection = .point(seriesId: s.id, index: i)
            let selected = ctx.isSelected(target)
            ctx.marks.append(.circle(
                key: "point-\(s.id)-\(i)",
                role: .point,
                cx: x,
                cy: yOf(v),
                r: 4,
                fill: color,
                stroke: theme.surface,
                strokeWidth: 1.5,
                target: target,
                selected: selected || catSelected || ctx.seriesSelected(s.id)
            ))
            if selected {
                ctx.marks.append(.circle(
                    key: "point-\(s.id)-\(i)-selection",
                    role: .selection,
                    cx: x,
                    cy: yOf(v),
                    r: 7.5,
                    fill: "none",
                    stroke: theme.selection,
                    strokeWidth: 1.5
                ))
            }
            if isRight {
                rightLabels.append(SlopeLabel(i: i, y: yOf(v)))
            } else {
                leftLabels.append(SlopeLabel(i: i, y: yOf(v)))
            }
        }
    }
    var moved = 0
    for (rawLabels, x, anchor, textFn, width) in [
        (leftLabels, xL - 8.0, ChartTextAnchor.end, leftText, leftW),
        (rightLabels, xR + 8.0, ChartTextAnchor.start, rightText, rightW)
    ] {
        let labels = rawLabels.sorted { $0.y < $1.y }
        let ys = dodge(labels.map { $0.y }, fs * 1.15, plot.y - fs / 2.0, plot.y + plot.height + fs / 2.0)
        for (k, l) in labels.enumerated() {
            if abs(ys[k] - l.y) > 0.5 { moved += 1 }
            let target: ChartSelection = .category(index: l.i)
            let selected = ctx.isSelected(target)
            ctx.marks.append(.text(
                key: "label-slope-\(anchor == .end ? "left" : "right")-\(l.i)",
                role: .dataLabel,
                x: x,
                y: ys[k],
                text: truncate(textFn(l.i), width, fs, measure),
                anchor: anchor,
                baseline: .middle,
                size: fs,
                weight: selected ? 600 : nil,
                fill: selected ? theme.selection : theme.text,
                target: target,
                selected: selected
            ))
        }
    }
    if moved > 0 {
        ctx.warn(.labelsTruncated, "\(moved) slope label\(moved == 1 ? " was" : "s were") moved off its point so the labels do not overlap.")
    }
    return FamilyResult(
        plot: plot,
        valueScale: ChartValueScale(
            axis: .y,
            domain: (scale.min, scale.max),
            range: (plot.y + plot.height, plot.y),
            ticks: scale.ticks
        )
    )
}

/// Likert: one diverging bar per category (a question), the series (answers) from most negative
/// to most positive, as shares of the question's total.
internal func layoutLikert(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let n = visible.count
    let side = n / 2
    let neutral = n % 2 == 1 ? side : -1
    let separate = neutral >= 0 && spec.likertNeutral == .separate
    if spec.likertNeutral == .separate && neutral < 0 {
        ctx.warn(.typeFallback, "A separate neutral column needs an odd number of answers; the middle answer is not set apart.")
    }
    let shares: [[Double]] = (0..<spec.categories.count).map { i in
        let raw: [Double] = visible.map { s in
            let v: Double? = i < s.values.count ? s.values[i] : nil
            return (v != nil && v!.isFinite) ? Swift.max(0.0, v!) : 0.0
        }
        let total = raw.reduce(0.0, +)
        return raw.map { v in total != 0 ? v / total : 0.0 }
    }
    func sum(_ p: [Double], _ from: Int, _ to: Int) -> Double {
        guard from < to, from >= 0, to <= p.count else { return 0 }
        return p[from..<to].reduce(0.0, +)
    }
    func negOf(_ p: [Double]) -> Double {
        sum(p, 0, side) + (neutral >= 0 && !separate ? p[neutral] / 2.0 : 0.0)
    }
    func posOf(_ p: [Double]) -> Double {
        sum(p, n - side, n) + (neutral >= 0 && !separate ? p[neutral] / 2.0 : 0.0)
    }
    var rows = Array(0..<spec.categories.count)
    if spec.likertSort == .positive {
        rows.sort { p, q in
            let sp = sum(shares[p], n - side, n)
            let sq = sum(shares[q], n - side, n)
            return sq != sp ? sq > sp : p < q
        }
    } else if spec.likertSort == .negative {
        rows.sort { p, q in
            let sp = sum(shares[p], 0, side)
            let sq = sum(shares[q], 0, side)
            return sq != sp ? sq > sp : p < q
        }
    }
    let extent = shares.reduce(0.01) { acc, p in Swift.max(acc, negOf(p), posOf(p)) }
    let maxCatW = spec.categories.reduce(0.0) { Swift.max($0, measure($1, fs, nil)) }
    let labelW = spec.xAxis.show ? Swift.min(area.width * 0.35, maxCatW) + 10.0 : 4.0
    let neutralW = separate ? Swift.max(40.0, area.width * 0.18) : 0.0
    let axisH = spec.yAxis.show ? fs * 1.6 : 2.0
    let headH = separate ? fs * 1.5 : 0.0
    let plot = ChartRect(
        x: area.x + labelW,
        y: area.y + headH,
        width: Swift.max(1.0, area.width - labelW - (separate ? neutralW + 14.0 : 0.0)),
        height: Swift.max(1.0, area.height - axisH - headH)
    )
    var likertYAxis = spec.yAxis
    likertYAxis.min = 0
    likertYAxis.max = nil
    likertYAxis.scale = nil
    likertYAxis.reverse = nil
    let half = axisScale(0, extent, plot.width / 2.0, likertYAxis)
    let m = half.max
    func xOf(_ v: Double) -> Double {
        plot.x + ((v + m) / (2.0 * m)) * plot.width
    }
    let percent = ChartNumberFormat(style: .percent, decimals: spec.yAxis.format.decimals)
    let ticks = Array(half.ticks.dropFirst().map { -$0 }.reversed()) + half.ticks
    let axisTarget: ChartSelection = .axis(.y)
    for (k, t) in ticks.enumerated() {
        let x = xOf(t)
        if spec.yAxis.gridlines && t != 0 {
            ctx.marks.append(.line(
                key: "grid-y-\(k)",
                role: .grid,
                x1: x,
                y1: plot.y,
                x2: x,
                y2: plot.y + plot.height,
                stroke: theme.grid,
                strokeWidth: 1
            ))
        }
        if spec.yAxis.show {
            ctx.marks.append(.text(
                key: "tick-y-\(k)",
                role: .tickLabel,
                x: x,
                y: plot.y + plot.height + 6.0,
                text: formatChartNumber(abs(t), percent, percent.decimals ?? stepDecimals(half.step * 100.0)),
                anchor: .middle,
                baseline: .top,
                size: fs,
                fill: theme.mutedText,
                target: axisTarget
            ))
        }
    }
    let band = plot.height / Double(Swift.max(1, rows.count))
    let barH = Swift.max(2.0, band * (1.0 - Swift.min(0.9, spec.gapWidth)))
    let neutralMax = separate ? shares.reduce(0.01) { Swift.max($0, $1[neutral]) } : 1.0
    let neutralX = plot.x + plot.width + 14.0
    if separate {
        let s = visible[neutral]
        ctx.marks.append(.text(
            key: "likert-neutral-title",
            role: .axisTitle,
            x: neutralX,
            y: area.y,
            text: truncate(s.name, neutralW, fs, measure),
            anchor: .start,
            baseline: .top,
            size: fs,
            weight: 600,
            fill: theme.mutedText,
            target: .series(seriesId: s.id)
        ))
    }
    var hidden = 0
    for (r, i) in rows.enumerated() {
        let p = shares[i]
        let y = plot.y + Double(r) * band + (band - barH) / 2.0
        let catTarget: ChartSelection = .category(index: i)
        let catSelected = ctx.isSelected(catTarget)
        if spec.xAxis.show {
            ctx.marks.append(.text(
                key: "tick-x-\(i)",
                role: .tickLabel,
                x: plot.x - 8.0,
                y: y + barH / 2.0,
                text: truncate(spec.categories[i], labelW - 10.0, fs, measure),
                anchor: .end,
                baseline: .middle,
                size: fs,
                fill: catSelected ? theme.selection : theme.mutedText,
                target: catTarget,
                selected: catSelected
            ))
        }
        func segment(_ j: Int, _ x0: Double, _ x1: Double, _ key: String) {
            let s = visible[j]
            if x1 - x0 <= 0 { return }
            let target: ChartSelection = .point(seriesId: s.id, index: i)
            let selected = ctx.isSelected(target)
            let origIdx = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
            let fill: String
            if let pc = s.pointColors, i < pc.count, let c = pc[i], !c.isEmpty {
                fill = c
            } else {
                fill = chartSeriesColor(spec, origIdx)
            }
            let rect = ChartRect(x: x0, y: y, width: x1 - x0, height: barH)
            ctx.marks.append(.rect(
                key: key,
                role: .bar,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                fill: fill,
                target: target,
                selected: selected || ctx.seriesSelected(s.id) || catSelected
            ))
            if selected {
                ctx.outline(
                    "\(key)-selection",
                    ChartRect(x: rect.x - 2.0, y: rect.y - 2.0, width: rect.width + 4.0, height: rect.height + 4.0)
                )
            }
            guard s.dataLabels ?? spec.dataLabels else { return }
            let text = formatChartNumber(p[j], percent, percent.decimals ?? 0)
            if measure(text, fs - 1.0, nil) + 6.0 > rect.width || barH < fs {
                hidden += 1
                return
            }
            ctx.marks.append(.text(
                key: "label-\(s.id)-\(i)",
                role: .dataLabel,
                x: rect.x + rect.width / 2.0,
                y: y + barH / 2.0,
                text: text,
                anchor: .middle,
                baseline: .middle,
                size: fs - 1.0,
                fill: contrastingTextColor(fill),
                target: target
            ))
        }
        var cursor = -negOf(p)
        for (j, s) in visible.enumerated() {
            if separate && j == neutral { continue }
            segment(j, xOf(cursor), xOf(cursor + p[j]), "bar-\(s.id)-\(i)")
            cursor += p[j]
        }
        if separate {
            segment(neutral, neutralX, neutralX + (p[neutral] / neutralMax) * neutralW, "bar-\(visible[neutral].id)-\(i)")
        }
    }
    ctx.marks.append(.line(
        key: "axis-likert-centre",
        role: .axis,
        x1: xOf(0),
        y1: plot.y,
        x2: xOf(0),
        y2: plot.y + plot.height,
        stroke: theme.axis,
        strokeWidth: 1.25,
        target: axisTarget
    ))
    if hidden > 0 {
        ctx.warn(.dataLabelsHidden, "\(hidden) data label\(hidden == 1 ? "" : "s") did not fit and \(hidden == 1 ? "is" : "are") hidden.")
    }
    return FamilyResult(plot: plot, percent: true)
}

/// Parliament: the first series as seats in a hemicycle (rows of dots), one colour per category, with the majority line and the total.
internal func layoutParliament(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let seats: [Int] = (0..<spec.categories.count).map { i in
        let v: Double? = i < series.values.count ? series.values[i] : nil
        return (v != nil && v!.isFinite) ? Swift.max(0, Int(JS.round(v!))) : 0
    }
    if series.values.contains(where: { vOpt in
        guard let v = vOpt, v.isFinite else { return false }
        return v < 0 || v != floor(v)
    }) {
        ctx.warn(.valuesSkipped, "Seats are whole numbers of 0 or more; other values were rounded.")
    }
    let total = seats.reduce(0, +)
    func empty(_ text: String) -> FamilyResult {
        ctx.marks.append(.text(
            key: "empty",
            role: .empty,
            x: area.x + area.width / 2.0,
            y: area.y + area.height / 2.0,
            text: text,
            anchor: .middle,
            baseline: .middle,
            size: fs + 1.0,
            fill: theme.mutedText
        ))
        return FamilyResult(plot: area)
    }
    if total == 0 { return empty("No seats") }
    if total > 2000 { return empty("Too many seats to draw (more than 2,000)") }
    let arc = (spec.parliamentArc * .pi) / 180.0
    let start = .pi / 2.0 + arc / 2.0
    let cardinals = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5].map { $0 * .pi }.filter { $0 < start && $0 > start - arc }
    let angles = [start, start - arc] + cardinals
    let xs = [0.0] + angles.map { JS.cos($0) }
    let ys = [0.0] + angles.map { JS.sin($0) }
    let minX = xs.min() ?? 0.0
    let maxX = xs.max() ?? 0.0
    let minY = ys.min() ?? 0.0
    let maxY = ys.max() ?? 0.0
    let pad = fs * 1.2
    let radius = Swift.max(
        8.0,
        Swift.min((area.width - pad * 2.0) / (maxX - minX), (area.height - pad * 2.0) / (maxY - minY))
    )
    let cx = area.x + area.width / 2.0 - ((maxX + minX) / 2.0) * radius
    let cy = area.y + area.height / 2.0 + ((maxY + minY) / 2.0) * radius
    let inner = radius * 0.4
    var rows = 1
    while rows < 60 {
        let gap = (radius - inner) / Double(rows)
        let length = (0..<rows).reduce(0.0) { acc, k in
            acc + (inner + gap * (Double(k) + 0.5)) * arc
        }
        if length / Double(total) >= gap * 0.9 { break }
        rows += 1
    }
    let gap = (radius - inner) / Double(rows)
    let radii = (0..<rows).map { k in inner + gap * (Double(k) + 0.5) }
    let lengths = radii.map { $0 * arc }
    let all = lengths.reduce(0.0, +)
    let exact = lengths.map { ($0 / all) * Double(total) }
    var counts = exact.map { Int(floor($0)) }
    let remCount = total - counts.reduce(0, +)
    var remainders: [(k: Int, rest: Double)] = []
    for (k, e) in exact.enumerated() {
        remainders.append((k: k, rest: e - Double(counts[k])))
    }
    remainders.sort { p, q in
        if q.rest != p.rest { return q.rest < p.rest }
        return p.k < q.k
    }
    for item in remainders.prefix(Swift.max(0, remCount)) {
        counts[item.k] += 1
    }
    struct SeatPlace {
        var angle: Double
        var r: Double
        var idx: Int
    }
    var places: [SeatPlace] = []
    for (k, r) in radii.enumerated() {
        let c = counts[k]
        for j in 0..<c {
            let a = c == 1 ? .pi / 2.0 : start - (arc * (Double(j) + 0.5)) / Double(c)
            places.append(SeatPlace(angle: a, r: r, idx: places.count))
        }
    }
    places.sort { p, q in
        if q.angle != p.angle { return q.angle < p.angle }
        if p.r != q.r { return p.r < q.r }
        return p.idx < q.idx
    }
    let dot = Swift.max(1.0, Swift.min(gap, all / Double(total)) * 0.42)
    var next = 0
    for (i, count) in seats.enumerated() {
        let target: ChartSelection = .point(seriesId: series.id, index: i)
        let selected = ctx.isSelected(target) || ctx.isSelected(.category(index: i)) || ctx.seriesSelected(series.id)
        let fill = sliceColor(ctx, series, i)
        for k in 0..<count {
            let place = places[next]
            next += 1
            ctx.marks.append(.circle(
                key: "seat-\(i)-\(k)",
                role: .point,
                cx: cx + place.r * JS.cos(place.angle),
                cy: cy - place.r * JS.sin(place.angle),
                r: dot,
                fill: fill,
                stroke: selected ? theme.selection : nil,
                strokeWidth: selected ? 1.5 : nil,
                target: target,
                selected: selected
            ))
        }
    }
    let majority = spec.parliamentMajority ?? (total / 2 + 1)
    if majority <= total {
        let angle = start - arc * (Double(majority) / Double(total))
        let r0 = inner - gap * 0.3
        let r1 = radius + gap * 0.3
        ctx.marks.append(.line(
            key: "majority-line",
            role: .referenceLine,
            x1: cx + r0 * JS.cos(angle),
            y1: cy - r0 * JS.sin(angle),
            x2: cx + r1 * JS.cos(angle),
            y2: cy - r1 * JS.sin(angle),
            stroke: theme.text,
            strokeWidth: 1.25,
            dash: "4 3",
            opacity: 0.8
        ))
        let lr = r1 + fs * 0.4
        let lx = cx + lr * JS.cos(angle)
        let ly = cy - lr * JS.sin(angle)
        let cosA = JS.cos(angle)
        let sinA = JS.sin(angle)
        ctx.marks.append(.text(
            key: "majority-label",
            role: .referenceLabel,
            x: lx,
            y: ly,
            text: "Majority \(majority)",
            anchor: abs(cosA) < 0.25 ? .middle : (cosA > 0 ? .start : .end),
            baseline: sinA >= 0 ? .bottom : .top,
            size: fs - 1.0,
            weight: 500,
            fill: theme.text
        ))
    } else {
        ctx.warn(.valuesSkipped, "The majority of \(majority) is more than the \(total) seats; the majority line is not drawn.")
    }
    if inner > fs * 2.2 {
        let size = Swift.min(theme.titleSize + 8.0, inner * 0.6)
        let ty = spec.parliamentArc <= 200 ? cy - size * 0.2 : cy
        let totalTarget: ChartSelection = .series(seriesId: series.id)
        ctx.marks.append(.text(
            key: "parliament-total",
            role: .dataLabel,
            x: cx,
            y: ty,
            text: formatChartNumber(Double(total), ChartNumberFormat()),
            anchor: .middle,
            baseline: spec.parliamentArc <= 200 ? .bottom : .middle,
            size: size,
            weight: 700,
            fill: theme.text,
            target: totalTarget
        ))
        ctx.marks.append(.text(
            key: "parliament-caption",
            role: .dataLabel,
            x: cx,
            y: spec.parliamentArc <= 200 ? ty + 2.0 : ty + size * 0.6,
            text: spec.parliamentLabel.isEmpty ? "seats" : spec.parliamentLabel,
            anchor: .middle,
            baseline: .top,
            size: fs,
            fill: theme.mutedText,
            target: totalTarget
        ))
    }
    return FamilyResult(plot: ChartRect(x: cx - radius, y: cy - radius, width: radius * 2.0, height: radius * 2.0))
}

/// The colour of a tree node: its own, else its top-level group's palette colour, shaded by `shade`.
private func treeColor(
    _ ctx: LayoutCtx,
    _ series: ChartSeries?,
    _ node: ChartTreeNode,
    _ group: Int,
    _ base: String?,
    _ shade: Double
) -> String {
    if let c = node.color, !c.isEmpty { return c }
    if base == nil {
        if let pc = series?.pointColors, group < pc.count, let c = pc[group], !c.isEmpty {
            return c
        }
        return chartSliceColor(ctx.spec, group)
    }
    return shadeChartColor(base!, shade)
}

/// Treemap of `spec.tree`: each group a rectangle sized by its total, its children squarified
/// inside under a header with its name, down to the leaves.
internal func layoutTreemapTree(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries?) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let format = series?.format ?? spec.yAxis.format
    let labelsOn = series?.dataLabels ?? true
    var unlabelled = 0
    func draw(_ nodes: [ChartTreeNode], _ rect: ChartRect, _ key: String, _ group: Int?, _ base: String?) {
        let rects = chartSquarify(nodes.map { chartTreeTotal($0) }, rect)
        for (k, node) in nodes.enumerated() {
            let r = rects[k]
            if r.width <= 0.5 || r.height <= 0.5 { continue }
            let g = group ?? k
            let target: ChartSelection = .category(index: g)
            let selected = ctx.isSelected(target) || ctx.isSelected(.point(seriesId: series?.id ?? "", index: g))
            let id = "\(key)-\(k)"
            let fill = treeColor(ctx, series, node, g, base, base == nil ? 0.0 : (Double(k % 4) - 1.5) * 0.14)
            if let children = node.children {
                let header = (r.height > fs * 3.2 && r.width > fs * 3.0) ? fs * 1.5 : 0.0
                ctx.marks.append(.rect(
                    key: "group-\(id)",
                    role: .cell,
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                    fill: fill,
                    stroke: selected ? theme.selection : theme.surface,
                    strokeWidth: selected ? 2.5 : 2,
                    target: target,
                    selected: selected
                ))
                if header > 0 {
                    ctx.marks.append(.text(
                        key: "label-group-\(id)",
                        role: .dataLabel,
                        x: r.x + 5.0,
                        y: r.y + 4.0,
                        text: truncate(node.name, r.width - 10.0, fs, measure),
                        anchor: .start,
                        baseline: .top,
                        size: fs,
                        weight: 700,
                        fill: contrastingTextColor(fill),
                        target: target
                    ))
                }
                let yOff = header > 0 ? header : 2.0
                let inner = ChartRect(
                    x: r.x + 2.0,
                    y: r.y + yOff,
                    width: Swift.max(0.0, r.width - 4.0),
                    height: Swift.max(0.0, r.height - yOff - 2.0)
                )
                draw(children, inner, id, g, base ?? fill)
                continue
            }
            ctx.marks.append(.rect(
                key: "cell-\(id)",
                role: .cell,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                fill: fill,
                stroke: selected ? theme.selection : theme.surface,
                strokeWidth: selected ? 2.5 : 1,
                target: target,
                selected: selected
            ))
            if !labelsOn { continue }
            let room = r.width - 8.0
            if room < fs * 2.0 || r.height < fs * 1.5 {
                unlabelled += 1
                continue
            }
            let color = contrastingTextColor(fill)
            ctx.marks.append(.text(
                key: "label-cell-\(id)",
                role: .dataLabel,
                x: r.x + 4.0,
                y: r.y + 4.0,
                text: truncate(node.name, room, fs, measure),
                anchor: .start,
                baseline: .top,
                size: fs,
                weight: 600,
                fill: color,
                target: target
            ))
            if r.height >= fs * 3.0 {
                ctx.marks.append(.text(
                    key: "label-value-\(id)",
                    role: .dataLabel,
                    x: r.x + 4.0,
                    y: r.y + 6.0 + fs * 1.2,
                    text: truncate(formatChartNumber(node.value ?? 0.0, format), room, fs - 1.0, measure),
                    anchor: .start,
                    baseline: .top,
                    size: fs - 1.0,
                    fill: color,
                    target: target
                ))
            }
        }
    }
    draw(spec.tree, area, "n", nil, nil)
    if unlabelled > 0 {
        ctx.warn(.dataLabelsHidden, "\(unlabelled) treemap cell\(unlabelled == 1 ? " is" : "s are") too small for a label.")
    }
    return FamilyResult(plot: area)
}

/// Sunburst: `spec.tree` as rings from the centre out, each node an arc sized by its total
/// inside its parent's arc.
internal func layoutSunburst(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries?) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let tree = !spec.tree.isEmpty ? spec.tree : chartTreeFromSeries(spec.categories, series?.values ?? [])
    var indexOf: [String: Int] = [:]
    for (i, c) in spec.categories.enumerated() {
        let key = c.jsTrimmed.isEmpty ? "\(i + 1)" : c.jsTrimmed
        indexOf[key] = i
    }
    let depth = chartTreeDepth(tree)
    let total = tree.reduce(0.0) { $0 + chartTreeTotal($1) }
    let cx = area.x + area.width / 2.0
    let cy = area.y + area.height / 2.0
    let outer = Swift.max(8.0, Swift.min(area.width, area.height) / 2.0 - 4.0)
    let plot = ChartRect(x: cx - outer, y: cy - outer, width: outer * 2.0, height: outer * 2.0)
    if !(total > 0) {
        ctx.marks.append(.text(
            key: "empty",
            role: .empty,
            x: cx,
            y: cy,
            text: "No positive values",
            anchor: .middle,
            baseline: .middle,
            size: fs + 1.0,
            fill: theme.mutedText
        ))
        return FamilyResult(plot: plot)
    }
    let hole = outer * 0.28
    let ring = (outer - hole) / Double(Swift.max(1, depth))
    let format = series?.format ?? spec.yAxis.format
    var unlabelled = 0
    func walk(_ nodes: [ChartTreeNode], _ start: Double, _ sweep: Double, _ level: Int, _ key: String, _ group: Int?, _ base: String?) {
        let sum = nodes.reduce(0.0) { $0 + chartTreeTotal($1) }
        var at = start
        for (k, node) in nodes.enumerated() {
            let value = chartTreeTotal(node)
            if !(value > 0) || sum == 0 { continue }
            let a0 = at
            let a1 = at + (sweep * value) / sum
            at = a1
            let g = group ?? indexOf[node.name] ?? k
            let target: ChartSelection = .category(index: g)
            let selected = ctx.isSelected(target) || ctx.isSelected(.point(seriesId: series?.id ?? "", index: g))
            let fill = treeColor(ctx, series, node, g, base, 0.22 * Double(level))
            let id = "\(key)-\(k)"
            let r0 = hole + ring * Double(level)
            let r1 = r0 + ring
            ctx.marks.append(.path(
                key: "slice-\(id)",
                role: .slice,
                d: arcPath(cx, cy, r1, r0, a0, a1),
                fill: fill,
                stroke: selected ? theme.selection : theme.surface,
                strokeWidth: selected ? 2 : 1,
                target: target,
                selected: selected
            ))
            let mid = (a0 + a1) / 2.0
            let rm = (r0 + r1) / 2.0
            let text = node.name
            let width = measure(text, fs - 1.0, nil)
            if ring >= fs * 1.3 && 2.0 * rm * JS.sin(Swift.min(.pi / 2.0, (a1 - a0) / 2.0)) >= width + 6.0 {
                ctx.marks.append(.text(
                    key: "label-slice-\(id)",
                    role: .dataLabel,
                    x: cx + rm * JS.sin(mid),
                    y: cy - rm * JS.cos(mid),
                    text: text,
                    anchor: .middle,
                    baseline: .middle,
                    size: fs - 1.0,
                    weight: level == 0 ? 600 : nil,
                    fill: contrastingTextColor(fill),
                    target: target
                ))
            } else {
                unlabelled += 1
            }
            if let children = node.children {
                walk(children, a0, a1 - a0, level + 1, id, g, base ?? fill)
            }
        }
    }
    walk(tree, 0, .pi * 2.0, 0, "n", nil, nil)
    if unlabelled > 0 {
        ctx.warn(.dataLabelsHidden, "\(unlabelled) sunburst arc\(unlabelled == 1 ? " is" : "s are") too narrow for a label.")
    }
    if hole > fs * 2.0 {
        let size = Swift.min(theme.titleSize + 4.0, hole * 0.45)
        let centre: ChartSelection? = series.map { .series(seriesId: $0.id) }
        let caption = spec.sunburstLabel
        let hasCaption = !caption.isEmpty
        ctx.marks.append(.text(
            key: "sunburst-total",
            role: .dataLabel,
            x: cx,
            y: hasCaption ? cy - 2.0 : cy,
            text: formatChartNumber(total, format),
            anchor: .middle,
            baseline: hasCaption ? .bottom : .middle,
            size: size,
            weight: 700,
            fill: theme.text,
            target: centre
        ))
        if hasCaption {
            ctx.marks.append(.text(
                key: "sunburst-caption",
                role: .dataLabel,
                x: cx,
                y: cy + 2.0,
                text: truncate(caption, hole * 1.8, fs - 1.0, measure),
                anchor: .middle,
                baseline: .top,
                size: fs - 1.0,
                fill: theme.mutedText,
                target: centre
            ))
        }
    }
    return FamilyResult(plot: plot)
}

/// Sankey: `spec.links` as flows between columns of nodes.
internal func layoutSankey(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries?) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let nodes = spec.sankeyNodes
    let links = spec.links
    var at: [String: Int] = [:]
    for (i, n) in nodes.enumerated() { at[n] = i }
    var incoming: [[Int]] = Array(repeating: [], count: nodes.count)
    var outgoing: [[Int]] = Array(repeating: [], count: nodes.count)
    for (k, l) in links.enumerated() {
        if let sIdx = at[l.source], let tIdx = at[l.target] {
            outgoing[sIdx].append(k)
            incoming[tIdx].append(k)
        }
    }
    var column = Array(repeating: -1, count: nodes.count)
    func depth(_ i: Int) -> Int {
        if column[i] >= 0 { return column[i] }
        column[i] = 0
        column[i] = incoming[i].reduce(0) { d, k in
            guard let srcIdx = at[links[k].source] else { return d }
            return Swift.max(d, depth(srcIdx) + 1)
        }
        return column[i]
    }
    for i in 0..<nodes.count { _ = depth(i) }
    let last = column.max() ?? 0
    for i in 0..<nodes.count {
        if outgoing[i].isEmpty { column[i] = last }
    }
    let value: [Double] = series != nil
        ? (0..<nodes.count).map { i in (i < series!.values.count ? series!.values[i] : nil) ?? 0.0 }
        : Array(repeating: 0.0, count: nodes.count)
    let nodeW = Swift.max(6.0, Swift.min(16.0, area.width * 0.02))
    let gap = last > 0 ? (area.width - nodeW) / Double(last) : 0.0
    func xOf(_ c: Int) -> Double {
        last > 0 ? area.x + Double(c) * gap : area.x + area.width / 2.0 - nodeW / 2.0
    }
    let columns: [[Int]] = (0...Swift.max(0, last)).map { c in
        (0..<nodes.count).filter { column[$0] == c }
    }
    let maxColLen = columns.map { $0.count }.max() ?? 1
    let pad = Swift.max(4.0, Swift.min(fs * 1.2, area.height / Double(Swift.max(1, maxColLen)) / 3.0))
    let ky = columns.filter { !$0.isEmpty }.map { col -> Double in
        let colSum = col.reduce(0.0) { $0 + value[$1] }
        return (area.height - pad * Double(col.count - 1)) / Swift.max(1e-9, colSum)
    }.min() ?? 1.0
    var top = Array(repeating: 0.0, count: nodes.count)
    for col in columns {
        let used = col.reduce(0.0) { $0 + value[$1] * ky } + pad * Double(Swift.max(0, col.count - 1))
        var y = area.y + (area.height - used) / 2.0
        for i in col {
            top[i] = y
            y += value[i] * ky + pad
        }
    }
    func color(_ i: Int) -> String {
        if let pc = series?.pointColors, i < pc.count, let c = pc[i], !c.isEmpty {
            return c
        }
        return chartSliceColor(spec, i)
    }
    let named = Set(spec.highlight)
    let lit = nodes.map { named.contains($0) }
    let dimLinks = lit.contains(true)
    var outOffset = Array(repeating: 0.0, count: nodes.count)
    var inOffset = Array(repeating: 0.0, count: nodes.count)
    var startY: [Int: Double] = [:]
    var endY: [Int: Double] = [:]
    for i in 0..<nodes.count {
        let sortedOut = outgoing[i].sorted { a, b in
            let ta = top[at[links[a].target]!]
            let tb = top[at[links[b].target]!]
            return ta != tb ? ta < tb : a < b
        }
        for k in sortedOut {
            startY[k] = top[i] + outOffset[i]
            outOffset[i] += links[k].value * ky
        }
        let sortedIn = incoming[i].sorted { a, b in
            let sa = top[at[links[a].source]!]
            let sb = top[at[links[b].source]!]
            return sa != sb ? sa < sb : a < b
        }
        for k in sortedIn {
            endY[k] = top[i] + inOffset[i]
            inOffset[i] += links[k].value * ky
        }
    }
    func selectedNode(_ i: Int) -> Bool {
        ctx.isSelected(.category(index: i)) || ctx.isSelected(.point(seriesId: series?.id ?? "", index: i))
    }
    for (k, l) in links.enumerated() {
        let s = at[l.source]!
        let t = at[l.target]!
        let w = l.value * ky
        let x0 = xOf(column[s]) + nodeW
        let x1 = xOf(column[t])
        let y0 = startY[k]!
        let y1 = endY[k]!
        let xm = (x0 + x1) / 2.0
        let d = "M\(r2s(x0)),\(r2s(y0))C\(r2s(xm)),\(r2s(y0)) \(r2s(xm)),\(r2s(y1)) \(r2s(x1)),\(r2s(y1))L\(r2s(x1)),\(r2s(y1 + w))C\(r2s(xm)),\(r2s(y1 + w)) \(r2s(xm)),\(r2s(y0 + w)) \(r2s(x0)),\(r2s(y0 + w))Z"
        let fill = l.color ?? (spec.sankeyLinkColor == .gray ? theme.mutedText : color(spec.sankeyLinkColor == .target ? t : s))
        let emphasis = (selectedNode(s) || selectedNode(t)) ? 0.6 : 0.35
        let opacity = (dimLinks && !lit[s] && !lit[t]) ? emphasis * 0.25 : emphasis
        ctx.marks.append(.path(
            key: "link-\(k)",
            role: .link,
            d: d,
            fill: fill,
            opacity: opacity
        ))
    }
    let labelsOn = series?.dataLabels ?? spec.dataLabels
    let format = series?.format ?? spec.yAxis.format
    var hidden = 0
    for (i, name) in nodes.enumerated() {
        let x = xOf(column[i])
        let h = Swift.max(1.0, value[i] * ky)
        let target: ChartSelection = .category(index: i)
        let selected = selectedNode(i)
        ctx.marks.append(.rect(
            key: "node-\(i)",
            role: .node,
            x: x,
            y: top[i],
            width: nodeW,
            height: h,
            fill: color(i),
            stroke: selected ? theme.selection : nil,
            strokeWidth: selected ? 2 : nil,
            radius: 1,
            target: target,
            selected: selected
        ))
        let text = labelsOn ? "\(name) \(formatChartNumber(value[i], format))" : name
        let room = (last > 0 ? gap : area.width / 2.0) - nodeW - 10.0
        let shown = truncate(text, Swift.max(fs * 2.0, room), fs, measure)
        if shown != text { hidden += 1 }
        let right = column[i] < last || last == 0
        ctx.marks.append(.text(
            key: "label-node-\(i)",
            role: .dataLabel,
            x: right ? x + nodeW + 5.0 : x - 5.0,
            y: top[i] + h / 2.0,
            text: shown,
            anchor: right ? .start : .end,
            baseline: .middle,
            size: fs,
            weight: selected ? 600 : nil,
            fill: selected ? theme.selection : theme.text,
            target: target,
            selected: selected
        ))
    }
    if hidden > 0 {
        ctx.warn(.labelsTruncated, "\(hidden) node label\(hidden == 1 ? " was" : "s were") shortened to fit between the columns.")
    }
    return FamilyResult(plot: area)
}

/// Bar race: the top `raceTopN` names at one moment (`frame`, a fractional category index;
/// default the last time point) as ranked horizontal bars.
internal func layoutBarRace(_ ctx: LayoutCtx, _ area: ChartRect, _ frame: Double?) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let top = spec.raceTopN
    let moment = chartRaceMoment(spec.categories.count, frame)
    let ranking = chartRaceRanking(spec, frame)
    let shown = ranking.filter { $0.position < Double(top) }
    let maxNameW = ranking.reduce(0.0) { Swift.max($0, measure($1.name, fs, nil)) }
    let labelW = Swift.min(area.width * 0.3, maxNameW) + 8.0
    let tickH = spec.yAxis.show ? fs * 1.6 : 4.0
    let plot = ChartRect(
        x: area.x + labelW,
        y: area.y + tickH,
        width: Swift.max(1.0, area.width - labelW - fs * 4.0),
        height: Swift.max(1.0, area.height - tickH)
    )
    let lead = shown.reduce(1e-9) { Swift.max($0, $1.value) }
    let maxVal: Double
    if let yMax = spec.yAxis.max, yMax > 0 {
        maxVal = yMax
    } else {
        maxVal = lead * 1.08
    }
    func xOf(_ v: Double) -> Double {
        plot.x + (Swift.max(0.0, Swift.min(maxVal, v)) / maxVal) * plot.width
    }
    let ticks = niceScale(0, maxVal, 5).ticks.filter { $0 <= maxVal }
    let axisTarget: ChartSelection = .axis(.y)
    let format = spec.yAxis.format
    let tickDiff: Double = ticks.count > 1 && (ticks[1] - ticks[0]) != 0 ? (ticks[1] - ticks[0]) : 1.0
    for (k, t) in ticks.enumerated() {
        if spec.yAxis.gridlines {
            ctx.marks.append(.line(
                key: "grid-y-\(k)",
                role: .grid,
                x1: xOf(t),
                y1: plot.y,
                x2: xOf(t),
                y2: plot.y + plot.height,
                stroke: theme.grid,
                strokeWidth: 1
            ))
        }
        if spec.yAxis.show {
            ctx.marks.append(.text(
                key: "tick-y-\(k)",
                role: .tickLabel,
                x: xOf(t),
                y: area.y,
                text: formatChartNumber(t, format, format.decimals ?? stepDecimals(tickDiff)),
                anchor: .middle,
                baseline: .top,
                size: fs - 1.0,
                fill: theme.mutedText,
                target: axisTarget
            ))
        }
    }
    let catIdx = moment.t < 0.5 ? moment.from : moment.to
    let label = (catIdx >= 0 && catIdx < spec.categories.count) ? spec.categories[catIdx] : ""
    let timeSize = Swift.min(
        theme.titleSize * 3.0,
        plot.height * 0.2,
        (plot.width * 0.5) / Swift.max(1.0, Double(label.utf16.count) * 0.6)
    )
    ctx.marks.append(.text(
        key: "race-time",
        role: .raceTime,
        x: plot.x + plot.width,
        y: plot.y + plot.height - 4.0,
        text: label,
        anchor: .end,
        baseline: .bottom,
        size: timeSize,
        weight: 700,
        fill: theme.mutedText,
        opacity: 0.55,
        target: .category(index: catIdx)
    ))
    let band = plot.height / Double(top)
    let barH = Swift.max(2.0, band * (1.0 - Swift.min(0.8, spec.gapWidth)))
    let index = Int(JS.round(moment.at))
    for e in shown {
        guard let si = spec.series.firstIndex(where: { $0.id == e.seriesId }) else { continue }
        let s = spec.series[si]
        let y = plot.y + e.position * band + (band - barH) / 2.0
        let target: ChartSelection = .point(seriesId: e.seriesId, index: index)
        let selected = ctx.isSelected(target) || ctx.seriesSelected(e.seriesId)
        let width = Swift.max(0.0, xOf(e.value) - plot.x)
        ctx.marks.append(.rect(
            key: "bar-\(e.seriesId)",
            role: .bar,
            x: plot.x,
            y: y,
            width: width,
            height: barH,
            fill: chartSeriesColor(spec, si),
            stroke: selected ? theme.selection : nil,
            strokeWidth: selected ? 1.5 : nil,
            radius: Swift.min(3.0, barH / 4.0),
            target: target,
            selected: selected
        ))
        ctx.marks.append(.text(
            key: "label-name-\(e.seriesId)",
            role: .tickLabel,
            x: plot.x - 6.0,
            y: y + barH / 2.0,
            text: truncate(e.name, labelW - 8.0, fs, measure),
            anchor: .end,
            baseline: .middle,
            size: fs,
            fill: selected ? theme.selection : theme.text,
            target: .series(seriesId: e.seriesId)
        ))
        if s.dataLabels ?? true {
            let sFmt = s.format ?? format
            let dec = sFmt.decimals ?? (abs(e.value) >= 100.0 ? 0 : nil)
            ctx.marks.append(.text(
                key: "label-\(e.seriesId)",
                role: .dataLabel,
                x: plot.x + width + 5.0,
                y: y + barH / 2.0,
                text: formatChartNumber(e.value, sFmt, dec),
                anchor: .start,
                baseline: .middle,
                size: fs - 1.0,
                fill: theme.text,
                target: target
            ))
        }
    }
    if ranking.count > top {
        ctx.warn(.valuesSkipped, "The race shows the top \(top) of \(ranking.count) names at each moment (raceTopN).")
    }
    return FamilyResult(
        plot: plot,
        valueScale: ChartValueScale(
            axis: .x,
            domain: (0, maxVal),
            range: (plot.x, plot.x + plot.width),
            ticks: ticks
        )
    )
}

/// Path data (absolute M / L / Z) scaled by `s` and moved by (`ox`, `oy`).
private func placePath(_ d: String, _ s: Double, _ ox: Double, _ oy: Double) -> String {
    guard let regex = try? NSRegularExpression(pattern: #"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)"#) else {
        return d
    }
    let nsRange = NSRange(d.startIndex..<d.endIndex, in: d)
    let matches = regex.matches(in: d, options: [], range: nsRange)
    if matches.isEmpty { return d }
    var out = ""
    var lastIdx = d.startIndex
    for match in matches {
        guard let fullRange = Range(match.range, in: d),
              let xRange = Range(match.range(at: 1), in: d),
              let yRange = Range(match.range(at: 2), in: d),
              let xVal = Double(d[xRange]),
              let yVal = Double(d[yRange]) else { continue }
        out += d[lastIdx..<fullRange.lowerBound]
        out += "\(r2s(ox + xVal * s)),\(r2s(oy + yVal * s))"
        lastIdx = fullRange.upperBound
    }
    out += d[lastIdx..<d.endIndex]
    return out
}

/// Choropleth: the regions of a registered map (`spec.map`) shaded by the first series.
internal func layoutChoropleth(_ ctx: LayoutCtx, _ area: ChartRect, _ series: ChartSeries) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let map = getChartMap(spec.map)!
    let matches = matchChartMapRegions(map, spec.categories)
    let unmatched = spec.categories.enumerated().compactMap { i, c in matches[i] == nil ? c : nil }
    if !unmatched.isEmpty {
        let preview = unmatched.prefix(8).map { "\"\($0)\"" }.joined(separator: ", ")
        let suffix = unmatched.count > 8 ? ", …" : ""
        ctx.warn(
            .valuesSkipped,
            "\(unmatched.count) categor\(unmatched.count == 1 ? "y names" : "ies name") no region of \(map.name): \(preview)\(suffix). Use codes (such as FRA) or names (France)."
        )
    }
    var indexOfKeys: [String] = []
    var indexOf: [String: Int] = [:]
    for (i, rOpt) in matches.enumerated() {
        if let r = rOpt {
            if indexOf[r.id] == nil { indexOfKeys.append(r.id) }
            indexOf[r.id] = i
        }
    }
    func valueAt(_ i: Int) -> Double? {
        guard i < series.values.count, let v = series.values[i], v.isFinite else { return nil }
        return v
    }
    let present = indexOfKeys.compactMap { id in valueAt(indexOf[id]!) }
    let breaks = chartMapBreaks(present, spec.mapSteps, spec.mapThresholds)
    let origIdx = spec.series.firstIndex(where: { $0.id == series.id }) ?? 0
    let ramp = chartMapRamp(series.color ?? chartSeriesColor(spec, origIdx), breaks.count + 1)
    let format = series.format ?? spec.yAxis.format
    let legendH = fs * 2.2
    let s = Swift.max(1e-6, Swift.min(area.width / map.width, (area.height - legendH) / map.height))
    let ox = area.x + (area.width - map.width * s) / 2.0
    let oy = area.y
    if let land = map.land, !land.isEmpty {
        ctx.marks.append(.path(
            key: "map-land",
            role: .mapLand,
            d: placePath(land, s, ox, oy),
            fill: theme.grid,
            opacity: 0.55
        ))
    }
    var markers: [ChartMark] = []
    var labels: [ChartMark] = []
    for region in map.regions {
        let i = indexOf[region.id]
        let value = i.flatMap(valueAt)
        let fill: String
        if let i, let pc = series.pointColors, i < pc.count, let c = pc[i], !c.isEmpty {
            fill = c
        } else if let value {
            fill = ramp[chartMapClass(value, breaks)]
        } else {
            fill = theme.grid
        }
        let target: ChartSelection? = i.map { .category(index: $0) }
        let selected: Bool
        if let target, let i {
            selected = ctx.isSelected(target) || ctx.isSelected(.point(seriesId: series.id, index: i))
        } else {
            selected = false
        }
        let cx = ox + region.center.0 * s
        let cy = oy + region.center.1 * s
        if !region.d.isEmpty {
            ctx.marks.append(.path(
                key: "region-\(region.id)",
                role: .region,
                d: placePath(region.d, s, ox, oy),
                fill: fill,
                stroke: selected ? theme.selection : theme.surface,
                strokeWidth: selected ? 2 : 0.6,
                target: target,
                selected: target != nil ? selected : nil
            ))
        }
        if region.d.isEmpty || region.area * s * s < 30.0 {
            markers.append(.circle(
                key: "region-marker-\(region.id)",
                role: .region,
                cx: cx,
                cy: cy,
                r: 3.5,
                fill: fill,
                stroke: selected ? theme.selection : theme.text,
                strokeWidth: selected ? 1.5 : 0.75,
                target: target,
                selected: target != nil ? selected : nil
            ))
        }
        let minLabelArea = (fs * 3.0) * (fs * 3.0)
        if let value, let target, (series.dataLabels ?? spec.dataLabels), region.area * s * s > minLabelArea {
            let text = formatChartNumber(value, format)
            labels.append(.text(
                key: "label-\(region.id)",
                role: .dataLabel,
                x: cx,
                y: cy,
                text: text,
                anchor: .middle,
                baseline: .middle,
                size: fs - 1.0,
                weight: 600,
                fill: contrastingTextColor(fill),
                target: target
            ))
        }
    }
    ctx.marks.append(contentsOf: markers)
    ctx.marks.append(contentsOf: labels)
    let fmt: (Double) -> String = { v in formatChartNumber(v, format) }
    var items: [(color: String, text: String)] = ramp.enumerated().map { k, color in
        let text: String
        if breaks.isEmpty {
            text = present.first.map(fmt) ?? ""
        } else if k == 0 {
            text = "< \(fmt(breaks[0]))"
        } else if k == breaks.count {
            text = "≥ \(fmt(breaks[k - 1]))"
        } else {
            text = "\(fmt(breaks[k - 1]))–\(fmt(breaks[k]))"
        }
        return (color: color, text: text)
    }
    items.append((color: theme.grid, text: "No data"))
    var x = area.x
    let y = area.y + area.height - fs * 0.9
    for (k, item) in items.enumerated() {
        ctx.marks.append(.rect(
            key: "legend-swatch-\(k)",
            role: .legendSwatch,
            x: x,
            y: y - 5.0,
            width: 10,
            height: 10,
            fill: item.color,
            radius: 2
        ))
        ctx.marks.append(.text(
            key: "legend-label-\(k)",
            role: .legendLabel,
            x: x + 14.0,
            y: y,
            text: item.text,
            anchor: .start,
            baseline: .middle,
            size: fs - 1.0,
            fill: theme.text
        ))
        x += 14.0 + measure(item.text, fs - 1.0, nil) + 14.0
    }
    if x > area.x + area.width {
        ctx.warn(.legendTruncated, "The map legend is wider than the chart; widen the chart or use fewer classes.")
    }
    if let attr = map.attribution, !attr.isEmpty {
        ctx.marks.append(.text(
            key: "map-attribution",
            role: .note,
            x: area.x + area.width,
            y: y,
            text: attr,
            anchor: .end,
            baseline: .middle,
            size: Swift.max(7.0, fs - 3.0),
            fill: theme.mutedText
        ))
    }
    return FamilyResult(plot: ChartRect(x: ox, y: oy, width: map.width * s, height: map.height * s))
}
