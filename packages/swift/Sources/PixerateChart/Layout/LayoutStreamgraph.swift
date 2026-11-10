import Foundation
import PixerateCore
import PixerateRaster

/// Lays out a streamgraph: series stacked symmetrically around a center baseline (silhouette offset).
///
/// For each category index i:
///   total(i) = sum_{s} v_s(i)  (where v_s(i) >= 0)
///   y0(i) = -0.5 * total(i)
///
/// Layers stack upwards from y0:
///   layer_s: from y_bottom = y0 + prefix_sum to y_top = y_bottom + v_s(i)
///
/// The value domain is symmetric: [-maxHalf, maxHalf].
internal func layoutStreamgraph(_ ctx: LayoutCtx, _ area: ChartRect, _ visible: [ChartSeries]) -> FamilyResult {
    let spec = ctx.spec
    let theme = ctx.theme
    let n = spec.categories.count

    if visible.isEmpty || n == 0 {
        let plot = ChartRect(
            x: area.x + 8.0,
            y: area.y + 8.0,
            width: Swift.max(1.0, area.width - 16.0),
            height: Swift.max(1.0, area.height - 16.0)
        )
        ctx.marks.append(.text(
            key: "empty",
            role: .empty,
            x: plot.x + plot.width / 2.0,
            y: plot.y + plot.height / 2.0,
            text: ctx.options.emptyMessage ?? "No data",
            anchor: .middle,
            baseline: .middle,
            size: ctx.fs + 1.0,
            fill: theme.mutedText
        ))
        return FamilyResult(plot: plot)
    }

    // Calculate column totals across visible series (non-negative)
    var totals = Array(repeating: 0.0, count: n)
    for i in 0..<n {
        var colSum = 0.0
        for s in visible {
            let v: Double? = i < s.values.count ? s.values[i] : nil
            if let v, v.isFinite && v > 0 {
                colSum += v
            }
        }
        totals[i] = colSum
    }

    let maxTotal = totals.reduce(0.0) { Swift.max($0, $1) }
    let halfTotal = maxTotal > 0 ? maxTotal / 2.0 : 1.0
    let headroom = spec.yAxis.max == nil
    let maxHalf = headroom ? halfTotal * 1.15 : halfTotal

    let lo = -maxHalf
    let hi = maxHalf

    let frame = categoryFrame(
        ctx,
        area,
        CategoryFrameInput(
            labels: spec.categories,
            horizontal: spec.orientation == .horizontal,
            primary: ValueAxisInput(
                lo: lo,
                hi: hi,
                axis: spec.yAxis,
                format: spec.yAxis.format,
                frozen: ctx.options.valueDomain,
                key: .y
            )
        )
    )

    let plot = frame.plot
    let catCenter = frame.catCenter
    let map = frame.map
    let value = frame.value
    let curve: ChartCurve = spec.curve == .step ? .linear : spec.curve

    // Baseline silhouette offset per category: y0(i) = -0.5 * total(i)
    let baselines = totals.map { t in -0.5 * t }

    // Running stack positions per category
    var currentOffsets = baselines

    // Center zero rule (baseline)
    let zeroPx = value.px(0)
    let (zx1, zy1) = map(Pt(c: frame.catStart, v: zeroPx))
    let (zx2, zy2) = map(Pt(c: frame.catStart + frame.catLen, v: zeroPx))
    ctx.marks.append(.line(
        key: "rule-zero",
        role: .grid,
        x1: zx1,
        y1: zy1,
        x2: zx2,
        y2: zy2,
        stroke: theme.axis,
        strokeWidth: 1,
        dash: "3,3"
    ))

    struct SeriesLayer {
        var series: ChartSeries
        var color: String
        var selSeries: Bool
        var bottomPts: [Pt]
        var topPts: [Pt]
    }

    var layers: [SeriesLayer] = []

    for s in visible {
        let origIdx = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
        let color = chartSeriesColor(spec, origIdx)
        let selSeries = ctx.seriesSelected(s.id)

        var bottomPts: [Pt] = []
        var topPts: [Pt] = []

        for i in 0..<n {
            let c = catCenter(Double(i))
            let rawVal: Double? = i < s.values.count ? s.values[i] : nil
            let val: Double = (rawVal != nil && rawVal!.isFinite && rawVal! > 0) ? rawVal! : 0.0
            let bVal = currentOffsets[i]
            let tVal = bVal + val
            currentOffsets[i] = tVal

            bottomPts.append(Pt(c: c, v: value.px(bVal), i: i))
            topPts.append(Pt(c: c, v: value.px(tVal), i: i))
        }

        layers.append(SeriesLayer(series: s, color: color, selSeries: selSeries, bottomPts: bottomPts, topPts: topPts))
    }

    // Draw area ribbons (from bottom to top)
    for layer in layers {
        let s = layer.series
        let color = layer.color
        let selSeries = layer.selSeries
        let bottomPts = layer.bottomPts
        let topPts = layer.topPts
        let seriesTarget: ChartSelection = .series(seriesId: s.id)

        // Path: top forward, then bottom backward
        let revBottom = Array(bottomPts.reversed())
        let d = "\(curvePath(topPts, curve, map))\(curvePath(revBottom, curve, map, false))Z"

        ctx.marks.append(.path(
            key: "area-\(s.id)",
            role: .area,
            d: d,
            fill: color,
            opacity: selSeries ? 0.85 : 0.65,
            target: seriesTarget,
            selected: selSeries
        ))
    }

    // Draw crisp boundary lines (splines) along top of each layer and bottom of first layer
    if !layers.isEmpty {
        let bottomBase = layers[0].bottomPts
        ctx.marks.append(.path(
            key: "boundary-bottom",
            role: .line,
            d: curvePath(bottomBase, curve, map),
            fill: "none",
            stroke: theme.axis,
            strokeWidth: 1.5,
            opacity: 0.7
        ))
    }

    for layer in layers {
        let s = layer.series
        let color = layer.color
        let selSeries = layer.selSeries
        let topPts = layer.topPts
        let seriesTarget: ChartSelection = .series(seriesId: s.id)

        ctx.marks.append(.path(
            key: "line-\(s.id)",
            role: .line,
            d: curvePath(topPts, curve, map),
            fill: "none",
            stroke: color,
            strokeWidth: selSeries ? 3 : 1.75,
            target: seriesTarget,
            selected: selSeries
        ))
    }

    // Draw interactive point targets (invisible or visible dots for hover / click / tooltip)
    let showDots = spec.points
    for layer in layers {
        let s = layer.series
        let color = layer.color
        for i in 0..<n {
            let rawVal: Double? = i < s.values.count ? s.values[i] : nil
            guard let rawVal, rawVal.isFinite else { continue }

            // Position point in the vertical middle of the ribbon at this category
            let bPt = layer.bottomPts[i]
            let tPt = layer.topPts[i]
            let midV = (bPt.v + tPt.v) / 2.0
            let (cx, cy) = map(Pt(c: bPt.c, v: midV))

            let target: ChartSelection = .point(seriesId: s.id, index: i)
            let selected = ctx.isSelected(target)

            if showDots || selected {
                ctx.marks.append(.circle(
                    key: "pt-\(s.id)-\(i)",
                    role: .point,
                    cx: r2(cx),
                    cy: r2(cy),
                    r: selected ? 5 : 3.5,
                    fill: selected ? theme.selection : color,
                    stroke: theme.surface,
                    strokeWidth: 1.5,
                    target: target,
                    selected: selected
                ))
            } else {
                // Invisible target for hit-testing / tooltip anchoring
                ctx.marks.append(.circle(
                    key: "hit-\(s.id)-\(i)",
                    role: .point,
                    cx: r2(cx),
                    cy: r2(cy),
                    r: 6,
                    fill: "transparent",
                    stroke: "none",
                    target: target
                ))
            }
        }
    }

    return FamilyResult(
        plot: plot,
        valueScale: toValueScale(value, frame.horizontal ? .x : .y),
        categoryScale: ChartCategoryScale(
            axis: frame.horizontal ? .y : .x,
            start: frame.catStart,
            length: frame.catLen,
            count: frame.n,
            reverse: spec.xAxis.reverse == true
        )
    )
}
