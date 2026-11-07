import Foundation
import PixerateCore
import PixerateRaster

public enum ChartAgentCommand: Sendable, Equatable {
    case setValue(seriesId: String, index: Int, value: Double, note: String? = nil)
    case select(selection: ChartSelection?, note: String? = nil)
    case update(patch: JSONObject, label: String? = nil, note: String? = nil)
    case say(text: String)
}

public enum ChartPerformanceStep: Sendable, Equatable {
    case move(toX: Double, toY: Double, ms: Int)
    case say(text: String, ms: Int)
    case press
    case drag(toX: Double, toY: Double, ms: Int, from: Double, value: Double)
    case release
    case commit
}

/// Where a point or bar sits in the scene (its top for bars), or `nil` when it is not drawn.
public func chartPointAnchor(_ scene: ChartScene, _ seriesId: String, _ index: Int) -> (x: Double, y: Double)? {
    guard let mark = scene.marks.first(where: { m in
        (m.role == .bar || m.role == .point)
            && m.target == .point(seriesId: seriesId, index: index)
    }) else { return nil }
    switch mark {
    case .rect(let r):
        return (x: r.x + r.width / 2.0, y: r.y)
    case .circle(let c):
        return (x: c.cx, y: c.cy)
    default:
        return nil
    }
}

private func anchorFor(_ scene: ChartScene, _ role: ChartMarkRole) -> (x: Double, y: Double)? {
    guard let m = scene.marks.first(where: { $0.role == role }) else { return nil }
    switch m {
    case .text(let t):
        return (x: t.x, y: t.y)
    case .rect(let r):
        return (x: r.x + r.width / 2.0, y: r.y + r.height / 2.0)
    case .line(let l):
        return (x: (l.x1 + l.x2) / 2.0, y: (l.y1 + l.y2) / 2.0)
    default:
        return nil
    }
}

/// Plans how an agent acts out a command on the chart.
public func planChartCommand(
    _ spec: ChartSpec,
    _ scene: ChartScene,
    _ command: ChartAgentCommand,
    speed: Double = 1.0
) -> [ChartPerformanceStep] {
    func ms(_ n: Double) -> Int {
        Int(JS.round(n / Swift.max(0.1, speed)))
    }
    var steps: [ChartPerformanceStep] = []
    switch command {
    case .setValue(_, _, _, let note), .select(_, let note), .update(_, _, let note):
        if let note, !note.isEmpty {
            steps.append(.say(text: note, ms: ms(500)))
        }
    case .say:
        break
    }

    switch command {
    case .say(let text):
        steps.append(.say(text: text, ms: ms(900)))
        return steps
    case .setValue(let seriesId, let index, let value, _):
        let at = chartPointAnchor(scene, seriesId, index)
        let series = spec.series.first { $0.id == seriesId }
        let from = (series != nil && index >= 0 && index < series!.values.count ? series!.values[index] : nil) ?? 0.0
        let scale = series?.axis == .secondary ? (scene.valueScale2 ?? scene.valueScale) : scene.valueScale
        if let at, let scale {
            let px = linearMap(value, scale.domain, scale.range)
            let to = scale.axis == .y ? (x: at.x, y: px) : (x: px, y: at.y)
            steps.append(.move(toX: at.x, toY: at.y, ms: ms(380)))
            steps.append(.press)
            steps.append(.drag(toX: to.x, toY: to.y, ms: ms(520), from: from, value: value))
            steps.append(.release)
        } else {
            steps.append(.drag(
                toX: scene.plot.x + scene.plot.width / 2.0,
                toY: scene.plot.y + scene.plot.height / 2.0,
                ms: ms(200),
                from: from,
                value: value
            ))
        }
        steps.append(.commit)
        return steps
    case .select(let sel, _):
        var to: (x: Double, y: Double)? = nil
        if case .point(let seriesId, let index) = sel {
            to = chartPointAnchor(scene, seriesId, index)
        } else if let sel {
            if let m = scene.marks.first(where: { $0.target == sel }) {
                switch m {
                case .text(let t): to = (x: t.x, y: t.y)
                case .rect(let r): to = (x: r.x + r.width / 2.0, y: r.y + r.height / 2.0)
                case .circle(let c): to = (x: c.cx, y: c.cy)
                default: break
                }
            }
        }
        if let to {
            steps.append(.move(toX: to.x, toY: to.y, ms: ms(380)))
            steps.append(.press)
            steps.append(.release)
        }
        steps.append(.commit)
        return steps
    case .update(let patch, _, _):
        let keys = patch.keys
        let role: ChartMarkRole? = keys.contains("title") ? .title
            : keys.contains("legend") ? .legendLabel
            : keys.contains("xAxis") ? .axis
            : (keys.contains("yAxis") || keys.contains("yAxis2")) ? .tickLabel
            : nil
        let to = (role.flatMap { anchorFor(scene, $0) }) ?? (x: scene.plot.x + scene.plot.width / 2.0, y: scene.plot.y + 12.0)
        steps.append(.move(toX: to.x, toY: to.y, ms: ms(380)))
        steps.append(.press)
        steps.append(.release)
        steps.append(.commit)
        return steps
    }
}

public struct ChartPlaybackRef: Sendable, Equatable {
    public var kind: String
    public var id: String
    public init(kind: String, id: String) {
        self.kind = kind
        self.id = id
    }
}

public enum ChartPlaybackStep: Sendable, Equatable {
    case target(ChartPlaybackRef)
    case press
    case release
}

public func chartPointRef(_ series: String, _ category: JSONValue) -> ChartPlaybackRef {
    ChartPlaybackRef(kind: "point", id: JSONValue.array([.string(series), category]).stringified())
}

public func locateChartPoint(
    _ spec: ChartSpec,
    _ scene: ChartScene,
    _ ref: ChartPlaybackRef
) -> (x: Double, y: Double, width: Double, height: Double)? {
    guard ref.kind == "point",
          let parsed = try? JSONValue.parse(ref.id),
          case .array(let arr) = parsed,
          arr.count >= 2 else { return nil }
    let seriesRef = arr[0].stringValue
    let series = spec.series.first { $0.id == seriesRef } ?? spec.series.first { $0.name == seriesRef }
    let index: Int
    if let i = arr[1].intValue {
        index = i
    } else if let s = arr[1].stringValue {
        index = spec.categories.firstIndex(of: s) ?? -1
    } else {
        index = -1
    }
    guard let series, index >= 0, let at = chartPointAnchor(scene, series.id, index) else { return nil }
    return (x: at.x - 6.0, y: at.y - 6.0, width: 12.0, height: 12.0)
}
