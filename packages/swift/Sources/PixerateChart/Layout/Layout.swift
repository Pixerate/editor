// The legend height cap and the final non-finite pass follow gridcraft-main/crates/chart/src/render.rs
// (`legend`, `finalize`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore
import PixerateRaster

private enum LegendItemShape: String {
    case square
    case line
    case dash
}

private struct LegendItem {
    var label: String
    var color: String
    var target: ChartSelection
    var faded: Bool
    var selected: Bool
    var shape: LegendItemShape
}

private func legendItems(_ spec: ChartSpec, _ ctx: LayoutCtx) -> [LegendItem] {
    let family = chartFamily(spec)
    // Funnel bars and slope lines are labelled along the side already.
    if spec.type == .funnel || spec.type == .slope || spec.type == .sankey || spec.type == .barrace || spec.type == .choropleth {
        return []
    }
    if chartSpecColorsByCategory(spec) {
        let first = spec.series.first { !($0.hidden ?? false) }
        func seats(_ i: Int) -> Int {
            let v: Double = (first != nil && i < first!.values.count) ? (first!.values[i] ?? 0.0) : 0.0
            return Swift.max(0, Int(JS.round(v)))
        }
        return spec.categories.enumerated().map { i, c in
            let color: String
            if let pc = first?.pointColors, i < pc.count, let col = pc[i], !col.isEmpty {
                color = col
            } else {
                color = chartSliceColor(spec, i)
            }
            let target: ChartSelection = .category(index: i)
            return LegendItem(
                label: spec.type == .parliament ? "\(c) \(seats(i))" : c,
                color: color,
                target: target,
                faded: false,
                selected: ctx.isSelected(target),
                shape: .square
            )
        }
    }
    if family == .waterfall {
        guard let first = spec.series.first(where: { !($0.hidden ?? false) }) else { return [] }
        let origIdx = spec.series.firstIndex(where: { $0.id == first.id }) ?? 0
        let target: ChartSelection = .series(seriesId: first.id)
        return [
            LegendItem(label: "Increase", color: ctx.theme.positive, target: target, faded: false, selected: false, shape: .square),
            LegendItem(label: "Decrease", color: ctx.theme.negative, target: target, faded: false, selected: false, shape: .square),
            LegendItem(label: "Total", color: chartSeriesColor(spec, origIdx), target: target, faded: false, selected: false, shape: .square)
        ]
    }
    if family == .box { return [] }
    let trends = trendlineLegendItems(spec) { i in chartSeriesColor(spec, i) }
    var items: [LegendItem] = []
    for (i, s) in spec.series.enumerated() {
        let type = chartSeriesType(spec, s)
        let shape: LegendItemShape
        if family == .cartesian || family == .xy || family == .radar {
            shape = (type == .line) ? .line : .square
        } else {
            shape = .square
        }
        items.append(LegendItem(
            label: s.name,
            color: chartSeriesColor(spec, i),
            target: .series(seriesId: s.id),
            faded: s.hidden ?? false,
            selected: ctx.seriesSelected(s.id),
            shape: shape
        ))
        for t in trends where t.after == s.id {
            items.append(LegendItem(
                label: t.label,
                color: t.color,
                target: t.target,
                faded: false,
                selected: ctx.isSelected(t.target),
                shape: .dash
            ))
        }
    }
    return items
}

/// Lays a chart out as drawing primitives (rects, paths, circles, lines and text) in a
/// `width × height` box.
public func layoutChart(_ spec: ChartSpec, _ options: ChartLayoutOptions) -> ChartScene {
    let width = Swift.max(1.0, options.width.isFinite ? options.width : 1.0)
    let height = Swift.max(1.0, options.height.isFinite ? options.height : 1.0)
    let theme = options.theme?.applied(to: DEFAULT_CHART_THEME) ?? DEFAULT_CHART_THEME
    let selection = options.selection
    let ctx = LayoutCtx(
        spec: spec,
        options: options,
        theme: theme,
        measure: options.measureText ?? estimateChartTextWidth,
        fs: theme.fontSize,
        width: width,
        height: height,
        marks: [],
        warnings: [],
        selection: selection
    )
    let pad = 12.0
    let fs = theme.fontSize

    ctx.marks.append(.rect(
        key: "background",
        role: .background,
        x: 0,
        y: 0,
        width: width,
        height: height,
        fill: theme.background,
        target: .chart
    ))

    // Titles ----------------------------------------------------------------
    var top = pad
    func titleMark(_ isSubtitle: Bool, _ label: String, _ size: Double, _ weight: Double, _ fill: String) {
        let key = isSubtitle ? "subtitle" : "title"
        let role: ChartMarkRole = isSubtitle ? .subtitle : .title
        let target: ChartSelection = isSubtitle ? .subtitle : .title
        let selected = ctx.isSelected(target)
        ctx.marks.append(.text(
            key: key,
            role: role,
            x: width / 2.0,
            y: top,
            text: label,
            anchor: .middle,
            baseline: .top,
            size: size,
            weight: weight,
            fill: fill,
            target: target,
            selected: selected
        ))
        if selected {
            let w = ctx.measure(label, size, weight)
            ctx.outline(
                "\(key)-selection",
                ChartRect(x: width / 2.0 - w / 2.0 - 4.0, y: top - 3.0, width: w + 8.0, height: size * 1.25 + 6.0)
            )
        }
        top += size * 1.35
    }
    if !spec.title.isEmpty { titleMark(false, spec.title, theme.titleSize, 600, theme.text) }
    if !spec.subtitle.isEmpty { titleMark(true, spec.subtitle, fs + 1.0, 400, theme.mutedText) }
    if !spec.title.isEmpty || !spec.subtitle.isEmpty { top += 6.0 }

    let family = chartFamily(spec)
    let visible = spec.series.filter { !($0.hidden ?? false) }

    // Legend ----------------------------------------------------------------
    let items = legendItems(spec, ctx)
    var area = ChartRect(
        x: pad,
        y: top,
        width: width - pad * 2.0,
        height: height - top - pad - noteHeight(spec, fs)
    )
    let seriesLegend = family == .cartesian || family == .xy || family == .radar || family == .histogram
    let hasTrend = items.contains { $0.shape == .dash }
    let showLegend = spec.legend.show && !items.isEmpty && (
        !seriesLegend ||
        chartVariesColors(spec) ||
        spec.series.count > 1 ||
        spec.series.contains(where: { $0.hidden ?? false }) ||
        hasTrend
    )
    if showLegend {
        area = layoutLegend(items, spec.legend.position, area, ctx, ctx.isSelected(.legend))
    }

    func finish(_ result: FamilyResult) -> ChartScene {
        if result.plot.width > 0 {
            if chartAnnotationFamily(chartFamily(spec)) {
                drawCallouts(ctx, result.plot)
            } else if !spec.referenceLines.isEmpty || !spec.referenceBands.isEmpty || spec.series.contains(where: { $0.callouts != nil }) {
                ctx.warn(
                    .annotationsSkipped,
                    "Reference lines, bands and callouts are drawn on bar, line, area, scatter and bubble charts; this \(spec.type.rawValue) chart leaves them out."
                )
            }
        }
        applyHighlight(ctx)
        drawNote(ctx, pad)
        if let readout = options.readout {
            addReadout(ctx, readout, result.plot)
        }
        let kept = finalizeMarks(ctx.marks, width, height)
        if kept.count < ctx.marks.count {
            let diff = ctx.marks.count - kept.count
            ctx.warn(.valuesSkipped, "\(diff) mark\(diff == 1 ? " was" : "s were") left out: their values are not finite numbers.")
        }
        return ChartScene(
            width: width,
            height: height,
            plot: result.plot,
            marks: kept,
            valueScale: result.valueScale,
            valueScale2: result.valueScale2,
            xScale: result.xScale,
            categoryScale: result.categoryScale,
            percent: result.percent ?? false,
            theme: theme,
            warnings: ctx.warnings
        )
    }
    func empty(_ message: String) -> ChartScene {
        ctx.marks.append(.text(
            key: "empty",
            role: .empty,
            x: area.x + area.width / 2.0,
            y: area.y + area.height / 2.0,
            text: message,
            anchor: .middle,
            baseline: .middle,
            size: fs + 1.0,
            fill: theme.mutedText
        ))
        return finish(FamilyResult(plot: ChartRect(x: area.x, y: area.y, width: 0, height: 0)))
    }
    let hasData = visible.contains { s in s.values.contains { $0 != nil && $0!.isFinite } }
    let needsCategories = family != .histogram && family != .box && family != .xy
    if (needsCategories && spec.categories.isEmpty) || visible.isEmpty || !hasData {
        return empty(options.emptyMessage ?? "No data")
    }

    switch family {
    case .pie:
        return finish(layoutPie(ctx, area, visible[0]))
    case .radar:
        if spec.categories.count < 3 {
            ctx.warn(.typeFallback, "A radar chart needs at least 3 categories; it is drawn as a line chart until then.")
            return finish(layoutCartesian(ctx, area, visible))
        }
        return finish(layoutRadar(ctx, area, visible))
    case .waterfall:
        return finish(layoutWaterfall(ctx, area, visible[0]))
    case .histogram:
        return finish(layoutHistogram(ctx, area, visible))
    case .box:
        return finish(layoutBox(ctx, area, visible))
    case .funnel:
        return finish(layoutFunnel(ctx, area, visible[0]))
    case .treemap:
        return finish(!spec.tree.isEmpty ? layoutTreemapTree(ctx, area, spec.series.first) : layoutTreemap(ctx, area, visible[0]))
    case .choropleth:
        guard let map = getChartMap(spec.map) else {
            ctx.warn(
                .typeFallback,
                "The map \"\(spec.map)\" is not registered, so the values are drawn as bars: register it with registerChartMap (the Europe outlines are EUROPE_CHART_MAP in @pixerate/editor/chart-maps)."
            )
            return finish(layoutCartesian(ctx, area, visible))
        }
        if !matchChartMapRegions(map, spec.categories).contains(where: { $0 != nil }) {
            ctx.warn(
                .typeFallback,
                "No category names a region of \(map.name), so the values are drawn as bars: use codes (such as FRA) or names (France) as categories."
            )
            return finish(layoutCartesian(ctx, area, visible))
        }
        return finish(layoutChoropleth(ctx, area, visible[0]))
    case .barrace:
        return finish(layoutBarRace(ctx, area, options.raceFrame))
    case .streamgraph:
        return finish(layoutStreamgraph(ctx, area, visible))
    case .sankey:
        if spec.links.isEmpty {
            ctx.warn(.typeFallback, "A Sankey diagram needs flows (set_chart_links); it is drawn as a bar chart until then.")
            return finish(layoutCartesian(ctx, area, visible))
        }
        return finish(layoutSankey(ctx, area, spec.series.first))
    case .sunburst:
        return finish(layoutSunburst(ctx, area, !spec.tree.isEmpty ? spec.series.first : visible[0]))
    case .slope:
        if visible.count < 2 {
            ctx.warn(.typeFallback, "A slope chart needs two series (before and after); it is drawn as a line chart until then.")
            return finish(layoutCartesian(ctx, area, visible))
        }
        return finish(layoutSlope(ctx, area, visible))
    case .likert:
        return finish(layoutLikert(ctx, area, visible))
    case .parliament:
        return finish(layoutParliament(ctx, area, visible[0]))
    case .xy:
        return finish(layoutXy(ctx, area, visible))
    case .cartesian:
        return finish(layoutCartesian(ctx, area, visible))
    }
}

private func layoutLegend(
    _ items: [LegendItem],
    _ position: ChartLegendPosition,
    _ area: ChartRect,
    _ ctx: LayoutCtx,
    _ legendSelected: Bool
) -> ChartRect {
    let theme = ctx.theme
    let measure = ctx.measure
    let fs = theme.fontSize
    let swatch = 10.0
    let rowH = fs * 1.7
    func itemW(_ item: LegendItem) -> Double {
        swatch + 6.0 + measure(item.label, fs, nil) + 14.0
    }
    var placed: [(item: LegendItem, x: Double, y: Double)] = []
    let box: ChartRect
    let rest: ChartRect
    if position == .left || position == .right {
        let maxW = items.map(itemW).max() ?? 0.0
        let w = Swift.min(area.width * 0.35, maxW)
        let fit = Swift.max(1, Int(floor((area.height + 0.5) / rowH)))
        let shown = Array(items.prefix(fit))
        let h = Swift.min(Double(shown.count) * rowH, area.height)
        let x = position == .left ? area.x : area.x + area.width - w
        let y = area.y + (area.height - h) / 2.0
        for (i, item) in shown.enumerated() {
            placed.append((item: item, x: x, y: y + Double(i) * rowH + rowH / 2.0))
        }
        if shown.count < items.count {
            ctx.warn(.legendTruncated, "The legend shows \(shown.count) of \(items.count) entries; the chart is too short for the rest.")
        }
        box = ChartRect(x: x, y: y, width: w, height: h)
        if position == .left {
            rest = ChartRect(x: area.x + w + 8.0, y: area.y, width: area.width - w - 8.0, height: area.height)
        } else {
            rest = ChartRect(x: area.x, y: area.y, width: area.width - w - 8.0, height: area.height)
        }
    } else {
        var rows: [[LegendItem]] = [[]]
        var used = 0.0
        for item in items {
            let w = itemW(item)
            if used + w > area.width && !rows[rows.count - 1].isEmpty {
                rows.append([])
                used = 0
            }
            rows[rows.count - 1].append(item)
            used += w
        }
        let maxRows = Swift.max(1, Int(floor((ctx.height * 0.3) / rowH)))
        let shown = Array(rows.prefix(maxRows))
        let hiddenCount = rows.dropFirst(maxRows).reduce(0) { $0 + $1.count }
        if hiddenCount > 0 {
            ctx.warn(.legendTruncated, "The legend shows \(items.count - hiddenCount) of \(items.count) entries; the rest do not fit.")
        }
        let h = Double(shown.count) * rowH
        let y0 = position == .top ? area.y : area.y + area.height - h
        for (r, row) in shown.enumerated() {
            let total = row.reduce(0.0) { $0 + itemW($1) } - 14.0
            var x = area.x + (area.width - total) / 2.0
            for item in row {
                placed.append((item: item, x: x, y: y0 + Double(r) * rowH + rowH / 2.0))
                x += itemW(item)
            }
        }
        box = ChartRect(x: area.x, y: y0, width: area.width, height: h)
        if position == .top {
            rest = ChartRect(x: area.x, y: area.y + h + 6.0, width: area.width, height: area.height - h - 6.0)
        } else {
            rest = ChartRect(x: area.x, y: area.y, width: area.width, height: area.height - h - 6.0)
        }
    }
    for (i, entry) in placed.enumerated() {
        let item = entry.item
        let x = entry.x
        let y = entry.y
        let opacity: Double? = item.faded ? 0.4 : nil
        if item.shape == .line || item.shape == .dash {
            ctx.marks.append(.line(
                key: "legend-swatch-\(i)",
                role: .legendSwatch,
                x1: x,
                y1: y,
                x2: x + swatch,
                y2: y,
                stroke: item.color,
                strokeWidth: item.shape == .dash ? 1.5 : 2.5,
                dash: item.shape == .dash ? "3 2" : nil,
                opacity: opacity,
                target: item.target,
                selected: item.selected
            ))
        } else {
            ctx.marks.append(.rect(
                key: "legend-swatch-\(i)",
                role: .legendSwatch,
                x: x,
                y: y - swatch / 2.0,
                width: swatch,
                height: swatch,
                fill: item.color,
                radius: 2,
                opacity: opacity,
                target: item.target,
                selected: item.selected
            ))
        }
        ctx.marks.append(.text(
            key: "legend-label-\(i)",
            role: .legendLabel,
            x: x + swatch + 6.0,
            y: y,
            text: item.label,
            anchor: .start,
            baseline: .middle,
            size: fs,
            weight: item.selected ? 600 : nil,
            fill: item.selected ? theme.selection : theme.text,
            opacity: opacity,
            target: item.target,
            selected: item.selected
        ))
    }
    if legendSelected {
        ctx.marks.append(.rect(
            key: "legend-selection",
            role: .selection,
            x: box.x - 4.0,
            y: box.y - 2.0,
            width: box.width + 8.0,
            height: box.height + 4.0,
            fill: "none",
            stroke: theme.selection,
            strokeWidth: 1,
            radius: 3
        ))
    }
    return rest
}

/// Writes the value of a point next to it while it is dragged, kept inside the plot.
private func addReadout(_ ctx: LayoutCtx, _ readout: ChartPointReadout, _ plot: ChartRect) {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    guard let series = spec.series.first(where: { $0.id == readout.seriesId }),
          readout.index >= 0,
          readout.index < series.values.count,
          let value = series.values[readout.index] else { return }
    guard let mark = ctx.marks.first(where: { m in
        (m.role == .point || m.role == .bar) && m.target == .point(seriesId: readout.seriesId, index: readout.index)
    }) else { return }
    let ax: Double
    let ay: Double
    switch mark {
    case .rect(let m):
        ax = m.x + m.width / 2.0
        ay = m.y
    case .circle(let m):
        ax = m.cx
        ay = m.cy - m.r
    default:
        return
    }
    let axis = series.axis == .secondary ? spec.yAxis2 : spec.yAxis
    let xVal: Double? = (series.x != nil && readout.index < series.x!.count) ? series.x![readout.index] : nil
    let text: String
    if let xVal, chartFamily(spec) == .xy {
        text = "\(formatChartNumber(xVal, spec.xAxis.format)), \(formatChartNumber(value, axis.format))"
    } else {
        let cat = readout.index < spec.categories.count ? spec.categories[readout.index] : ""
        text = "\(cat): \(formatChartNumber(value, series.format ?? axis.format))"
    }
    let w = measure(text, fs, 600) + 10.0
    let h = fs + 8.0
    let bx = Swift.max(plot.x, Swift.min(plot.x + plot.width - w, ax - w / 2.0))
    let by = Swift.max(plot.y, Swift.min(plot.y + plot.height - h, ay - h - 6.0))
    ctx.marks.append(.rect(
        key: "drag-readout-box",
        role: .dragReadout,
        x: bx,
        y: by,
        width: w,
        height: h,
        fill: theme.text,
        radius: 3,
        opacity: 0.9
    ))
    ctx.marks.append(.text(
        key: "drag-readout",
        role: .dragReadout,
        x: bx + w / 2.0,
        y: by + h / 2.0,
        text: text,
        anchor: .middle,
        baseline: .middle,
        size: fs,
        weight: 600,
        fill: theme.surface
    ))
}

private func isAllFinite(_ nums: Double?...) -> Bool {
    nums.allSatisfy { $0 == nil || $0!.isFinite }
}

/// Drops marks with non-finite coordinates (junk data never reaches a renderer) and clamps the rest near the box.
private func finalizeMarks(_ marks: [ChartMark], _ width: Double, _ height: Double) -> [ChartMark] {
    func lim(_ v: Double, _ size: Double) -> Double {
        Swift.max(-size * 4.0, Swift.min(size * 5.0, v))
    }
    var out: [ChartMark] = []
    for m in marks {
        switch m {
        case .rect(var r):
            guard isAllFinite(r.x, r.y, r.width, r.height) else { continue }
            r.x = lim(r.x, width)
            r.y = lim(r.y, height)
            r.width = Swift.max(0.0, Swift.min(r.width, width * 9.0))
            r.height = Swift.max(0.0, Swift.min(r.height, height * 9.0))
            out.append(.rect(r))
        case .circle(var c):
            guard isAllFinite(c.cx, c.cy, c.r) else { continue }
            c.cx = lim(c.cx, width)
            c.cy = lim(c.cy, height)
            out.append(.circle(c))
        case .line(var l):
            guard isAllFinite(l.x1, l.y1, l.x2, l.y2) else { continue }
            l.x1 = lim(l.x1, width)
            l.y1 = lim(l.y1, height)
            l.x2 = lim(l.x2, width)
            l.y2 = lim(l.y2, height)
            out.append(.line(l))
        case .text(let t):
            guard isAllFinite(t.x, t.y, t.size) else { continue }
            out.append(.text(t))
        case .path(let p):
            if p.d.contains("NaN") || p.d.contains("Infinity") { continue }
            out.append(.path(p))
        }
    }
    return out
}

/// The data value at a scene point along the value axis (for dragging a bar or point), or
/// `nil` when the scene has no value scale or is percent-stacked.
public func chartValueAtPoint(_ scene: ChartScene, _ point: (x: Double, y: Double), _ secondary: Bool = false) -> Double? {
    let scale = secondary ? (scene.valueScale2 ?? scene.valueScale) : scene.valueScale
    guard let scale, !scene.percent else { return nil }
    let px = scale.axis == .y ? point.y : point.x
    return chartScaleFromPixel(px, scale)
}

/// The category index under a scene point inside the plot of a bar, line or area chart, or `nil`.
public func chartCategoryAtPoint(_ scene: ChartScene, _ point: (x: Double, y: Double)) -> Int? {
    guard let scale = scene.categoryScale else { return nil }
    let plot = scene.plot
    if point.x < plot.x || point.x > plot.x + plot.width || point.y < plot.y || point.y > plot.y + plot.height {
        return nil
    }
    let offset = (scale.axis == .x ? point.x : point.y) - scale.start
    let k = Swift.min(scale.count - 1, Swift.max(0, Int(floor((offset / scale.length) * Double(scale.count)))))
    return scale.reverse ? scale.count - 1 - k : k
}

/// The x value at a scene point on a scatter or bubble chart, or `nil` without a numeric x axis.
public func chartXAtPoint(_ scene: ChartScene, _ point: (x: Double, y: Double)) -> Double? {
    guard let scale = scene.xScale else { return nil }
    return chartScaleFromPixel(point.x, scale)
}

/// The value a drag should store: snapped to a tenth of the tick step (or `step`) and kept finite.
public func snapChartValue(
    _ scene: ChartScene,
    _ value: Double,
    _ step: Double? = nil,
    _ ticks: [Double]? = nil,
    _ logBase: Double? = nil
) -> Double {
    let effectiveTicks = ticks ?? (scene.valueScale?.ticks ?? [])
    if let logBase, logBase != 0, step == nil {
        return (value > 0 && value.isFinite) ? (Double(jsToPrecision(value, 2)) ?? value) : value
    }
    let unit = step ?? (effectiveTicks.count > 1 ? (effectiveTicks[1] - effectiveTicks[0]) / 10.0 : 1.0)
    if !(unit > 0) { return value }
    let snapped = JS.round(value / unit) * unit
    return Double(jsToPrecision(snapped, 12)) ?? snapped
}
