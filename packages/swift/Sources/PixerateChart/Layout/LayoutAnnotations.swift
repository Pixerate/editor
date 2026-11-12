import Foundation
import PixerateCore
import PixerateRaster

private func axisOf(_ axis: ChartReferenceAxis?) -> ChartReferenceAxis {
    axis ?? .y
}

/// Chart families that draw reference lines, bands and callouts.
internal func chartAnnotationFamily(_ family: ChartFamily) -> Bool {
    family == .cartesian || family == .xy
}

/// Values the reference lines and bands on `axis` need the axis to reach.
internal func referenceValues(_ spec: ChartSpec, _ axis: ChartReferenceAxis) -> [Double] {
    var out: [Double] = []
    for l in spec.referenceLines where axisOf(l.axis) == axis {
        out.append(l.value)
    }
    for b in spec.referenceBands where axisOf(b.axis) == axis {
        out.append(b.from)
        out.append(b.to)
    }
    return out
}

/// One axis the references can be drawn on: its scale, and whether values run up the screen (`vertical`).
internal struct ReferenceAxis {
    var info: ScaleInfo
    var vertical: Bool
}

internal enum ReferenceLayer {
    case bands
    case lines
}

/// Draws the reference bands (`layer` `.bands`, under the data) or lines (`.lines`, over it) on
/// the axes given. References on an axis the chart does not have are skipped with a warning.
internal func drawReferences(
    _ ctx: LayoutCtx,
    _ plot: ChartRect,
    _ axes: [ChartReferenceAxis: ReferenceAxis],
    _ layer: ReferenceLayer
) {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    var missing: [ChartReferenceAxis] = []
    func addMissing(_ a: ChartReferenceAxis) {
        if !missing.contains(a) { missing.append(a) }
    }

    switch layer {
    case .bands:
        for (i, item) in spec.referenceBands.enumerated() {
            let axKey = axisOf(item.axis)
            guard let axis = axes[axKey] else {
                addMissing(axKey)
                continue
            }
            let info = axis.info
            let vertical = axis.vertical
            let color = item.color ?? theme.text
            let lo = vertical ? plot.y : plot.x
            let hi = vertical ? plot.y + plot.height : plot.x + plot.width
            func at(_ v: Double) -> Double {
                (info.logBase != nil && info.logBase != 0 && !(v > 0)) ? .nan : info.raw(v)
            }
            let a = at(item.from)
            let b = at(item.to)
            guard a.isFinite && b.isFinite else { continue }
            let p0 = Swift.max(lo, Swift.min(a, b))
            let p1 = Swift.min(hi, Swift.max(a, b))
            guard p1 > p0 else { continue }
            let rect = vertical
                ? ChartRect(x: plot.x, y: p0, width: plot.width, height: p1 - p0)
                : ChartRect(x: p0, y: plot.y, width: p1 - p0, height: plot.height)
            ctx.marks.append(.rect(
                key: "reference-band-\(i)",
                role: .referenceBand,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                fill: color,
                opacity: item.color != nil ? 0.16 : 0.07
            ))
            if let label = item.label, !label.isEmpty {
                let text = truncate(label, (vertical ? plot.width : rect.width) - 8.0, fs - 1.0, measure)
                ctx.marks.append(.text(
                    key: "reference-label-band-\(i)",
                    role: .referenceLabel,
                    x: rect.x + 4.0,
                    y: rect.y + 3.0,
                    text: text,
                    anchor: .start,
                    baseline: .top,
                    size: fs - 1.0,
                    fill: color,
                    opacity: 0.85
                ))
            }
        }
    case .lines:
        for (i, item) in spec.referenceLines.enumerated() {
            let axKey = axisOf(item.axis)
            guard let axis = axes[axKey] else {
                addMissing(axKey)
                continue
            }
            let info = axis.info
            let vertical = axis.vertical
            let color = item.color ?? theme.text
            let lo = vertical ? plot.y : plot.x
            let hi = vertical ? plot.y + plot.height : plot.x + plot.width
            func inside(_ p: Double) -> Bool {
                p.isFinite && p >= lo - 0.5 && p <= hi + 0.5
            }
            func at(_ v: Double) -> Double {
                (info.logBase != nil && info.logBase != 0 && !(v > 0)) ? .nan : info.raw(v)
            }
            let p = at(item.value)
            guard inside(p) else {
                ctx.warn(
                    .annotationsSkipped,
                    "The reference line at \(JSONValue.jsString(item.value)) is outside the \(axKey == .x ? "x" : "value") axis range and is not drawn."
                )
                continue
            }
            let line: (x1: Double, y1: Double, x2: Double, y2: Double) = vertical
                ? (plot.x, p, plot.x + plot.width, p)
                : (p, plot.y, p, plot.y + plot.height)
            ctx.marks.append(.line(
                key: "reference-line-\(i)",
                role: .referenceLine,
                x1: line.x1,
                y1: line.y1,
                x2: line.x2,
                y2: line.y2,
                stroke: color,
                strokeWidth: 1.25,
                dash: "5 3",
                opacity: 0.8
            ))
            if let label = item.label, !label.isEmpty {
                let text = truncate(label, (vertical ? plot.width : plot.width / 2.0) - 8.0, fs - 1.0, measure)
                if vertical {
                    ctx.marks.append(.text(
                        key: "reference-label-line-\(i)",
                        role: .referenceLabel,
                        x: plot.x + plot.width - 4.0,
                        y: p - 3.0,
                        text: text,
                        anchor: .end,
                        baseline: .bottom,
                        size: fs - 1.0,
                        weight: 500,
                        fill: color
                    ))
                } else {
                    ctx.marks.append(.text(
                        key: "reference-label-line-\(i)",
                        role: .referenceLabel,
                        x: p + 4.0,
                        y: plot.y + 2.0,
                        text: text,
                        anchor: .start,
                        baseline: .top,
                        size: fs - 1.0,
                        weight: 500,
                        fill: color
                    ))
                }
            }
        }
    }

    for axis in missing {
        ctx.warn(
            .annotationsSkipped,
            axis == .x
                ? "Reference lines and bands on the x axis need a scatter or bubble chart with numeric x values; they are not drawn."
                : "Reference lines and bands on the secondary axis need a series on that axis; they are not drawn."
        )
    }
}

/// Where a callout points: the end of a bar, or the top of a point.
private func anchorOf(_ mark: ChartMark, _ horizontal: Bool) -> (x: Double, y: Double)? {
    switch mark {
    case .rect(let m):
        return horizontal
            ? (x: m.x + m.width, y: m.y + m.height / 2.0)
            : (x: m.x + m.width / 2.0, y: m.y)
    case .circle(let m):
        return (x: m.cx, y: m.cy - m.r)
    default:
        return nil
    }
}

/// Draws each series' callouts: a boxed label with a leader line to its bar or point, kept inside the plot and clear of the other callouts.
internal func drawCallouts(_ ctx: LayoutCtx, _ plot: ChartRect) {
    let spec = ctx.spec
    let theme = ctx.theme
    let fs = ctx.fs
    let measure = ctx.measure
    let horizontal = spec.orientation == .horizontal
    var placed: [ChartRect] = []
    func overlaps(_ a: ChartRect) -> Bool {
        placed.contains { b in
            a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        }
    }
    var unplaced = 0
    for s in spec.series {
        if (s.hidden ?? false) { continue }
        guard let callouts = s.callouts else { continue }
        for (i, labelOpt) in callouts.enumerated() {
            guard let label = labelOpt, !label.isEmpty else { continue }
            let mark = ctx.marks.first { m in
                (m.role == .bar || m.role == .point) && m.target == .point(seriesId: s.id, index: i)
            }
            let isRect: Bool
            if case .rect = mark { isRect = true } else { isRect = false }
            guard let mark, let anchor = anchorOf(mark, horizontal && isRect) else {
                unplaced += 1
                continue
            }
            let size = fs - 1.0
            let text = truncate(label, plot.width * 0.6, size, measure)
            let w = measure(text, size, 600) + 10.0
            let h = size + 8.0
            let sideways = horizontal && isRect
            var bx = sideways ? anchor.x + 14.0 : anchor.x - w / 2.0
            var by = sideways ? anchor.y - h / 2.0 : anchor.y - h - 14.0
            func clampPos() {
                bx = Swift.max(plot.x, Swift.min(plot.x + plot.width - w, bx))
                by = Swift.max(plot.y - fs / 2.0, Swift.min(plot.y + plot.height - h, by))
            }
            clampPos()
            let covers = anchor.x >= bx - 2.0 && anchor.x <= bx + w + 2.0 && anchor.y >= by - 2.0 && anchor.y <= by + h + 2.0
            if covers {
                if sideways { bx = anchor.x - w - 14.0 }
                else { by = anchor.y + 14.0 }
                clampPos()
            }
            var k = 0
            while k < 6 && overlaps(ChartRect(x: bx, y: by, width: w, height: h)) {
                if sideways { by += h + 2.0 }
                else { by -= h + 2.0 }
                clampPos()
                k += 1
            }
            let box = ChartRect(x: bx, y: by, width: w, height: h)
            placed.append(box)
            let target: ChartSelection = .point(seriesId: s.id, index: i)
            let ex = Swift.max(bx, Swift.min(bx + w, anchor.x))
            let ey = Swift.max(by, Swift.min(by + h, anchor.y))
            if JS.hypot(ex - anchor.x, ey - anchor.y) > 2.0 {
                ctx.marks.append(.line(
                    key: "callout-leader-\(s.id)-\(i)",
                    role: .callout,
                    x1: anchor.x,
                    y1: anchor.y,
                    x2: ex,
                    y2: ey,
                    stroke: theme.axis,
                    strokeWidth: 1
                ))
            }
            ctx.marks.append(.rect(
                key: "callout-box-\(s.id)-\(i)",
                role: .callout,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                fill: theme.surface,
                stroke: theme.axis,
                strokeWidth: 1,
                radius: 3,
                target: target
            ))
            ctx.marks.append(.text(
                key: "callout-\(s.id)-\(i)",
                role: .callout,
                x: bx + w / 2.0,
                y: by + h / 2.0,
                text: text,
                anchor: .middle,
                baseline: .middle,
                size: size,
                weight: 600,
                fill: theme.text,
                target: target
            ))
        }
    }
    if unplaced > 0 {
        ctx.warn(
            .annotationsSkipped,
            "\(unplaced) callout\(unplaced == 1 ? " points" : "s point") at a gap or a hidden value and \(unplaced == 1 ? "is" : "are") not drawn."
        )
    }
}

private let MUTED_ROLES: Set<ChartMarkRole> = [
    .node, .region, .bar, .line, .area, .point, .slice, .cell, .box, .whisker,
    .outlier, .connector, .trendline, .trendlineLabel, .errorBar, .dataLabel,
    .legendSwatch, .legendLabel
]

/// Mutes every data mark that `spec.highlight` does not name.
internal func applyHighlight(_ ctx: LayoutCtx) {
    let spec = ctx.spec
    guard !spec.highlight.isEmpty else { return }
    let names = Set(spec.highlight)
    var categories = Set<Int>()
    for (i, c) in spec.categories.enumerated() where names.contains(c) {
        categories.insert(i)
    }
    let series = Set(spec.series.filter { names.contains($0.id) || names.contains($0.name) }.map { $0.id })
    let unmatched = spec.highlight.filter { h in
        !spec.categories.contains(h) && !spec.series.contains(where: { $0.id == h || $0.name == h })
    }
    if !unmatched.isEmpty {
        let quoted = unmatched.map { "\"\($0)\"" }.joined(separator: ", ")
        ctx.warn(
            .highlightUnmatched,
            "Highlight names \(quoted), which \(unmatched.count == 1 ? "is" : "are") neither a category nor a series."
        )
    }
    guard !categories.isEmpty || !series.isEmpty else { return }
    func bright(_ t: ChartSelection) -> Bool {
        switch t {
        case .point(let seriesId, let index):
            return series.contains(seriesId) || categories.contains(index)
        case .series(let seriesId), .trendline(let seriesId, _):
            return series.isEmpty || series.contains(seriesId)
        case .category(let index):
            return categories.isEmpty || categories.contains(index)
        default:
            return true
        }
    }
    for k in 0..<ctx.marks.count {
        let m = ctx.marks[k]
        guard let target = m.target, MUTED_ROLES.contains(m.role), !bright(target) else { continue }
        var copy = m
        copy.opacity = (m.opacity ?? 1.0) * 0.25
        ctx.marks[k] = copy
    }
}

/// Height the note takes at the bottom of the chart (0 without one).
internal func noteHeight(_ spec: ChartSpec, _ fs: Double) -> Double {
    !spec.note.isEmpty ? fs * 1.5 : 0
}

/// Writes the note along the bottom left, shortened to the width.
internal func drawNote(_ ctx: LayoutCtx, _ pad: Double) {
    let spec = ctx.spec
    guard !spec.note.isEmpty else { return }
    let text = truncate(spec.note, ctx.width - pad * 2.0, ctx.fs - 1.0, ctx.measure)
    if text != spec.note {
        ctx.warn(.labelsTruncated, "The note was shortened to fit the width.")
    }
    ctx.marks.append(.text(
        key: "note",
        role: .note,
        x: pad,
        y: ctx.height - pad + 2.0,
        text: text,
        anchor: .start,
        baseline: .bottom,
        size: ctx.fs - 1.0,
        fill: ctx.theme.mutedText
    ))
}
