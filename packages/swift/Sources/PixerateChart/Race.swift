import Foundation
import PixerateCore

/// A series' value at time point `index`: its own, else the last value before it (0 before the first).
public func chartRaceValueAt(_ series: ChartSeries, _ index: Int) -> Double {
    guard !series.values.isEmpty else { return 0 }
    var i = Swift.min(index, series.values.count - 1)
    while i >= 0 {
        if let v = series.values[i], v.isFinite {
            return v
        }
        i -= 1
    }
    return 0
}

public struct ChartRaceMoment: Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var t: Double
    public var at: Double

    public init(from: Int, to: Int, t: Double, at: Double) {
        self.from = from
        self.to = to
        self.t = t
        self.at = at
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("from", .number(Double(from))),
            ("to", .number(Double(to))),
            ("t", .number(t)),
            ("at", .number(at)),
        ]))
    }
}

/// The moment `frame` stands for: the time points either side and how far between them (0–1).
public func chartRaceMoment(_ count: Int, _ frame: Double?) -> ChartRaceMoment {
    let last = Double(Swift.max(0, count - 1))
    let at = (frame == nil || !frame!.isFinite) ? last : Swift.max(0, Swift.min(last, frame!))
    let fromD = floor(at)
    let from = Int(fromD)
    let to = Swift.min(Int(last), from + 1)
    return ChartRaceMoment(from: from, to: to, t: at - fromD, at: at)
}

public struct ChartRaceEntry: Sendable, Equatable {
    public var seriesId: String
    public var name: String
    public var value: Double
    public var position: Double
    public var rank: Int

    public init(seriesId: String, name: String, value: Double, position: Double, rank: Int) {
        self.seriesId = seriesId
        self.name = name
        self.value = value
        self.position = position
        self.rank = rank
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("seriesId", .string(seriesId)),
            ("name", .string(name)),
            ("value", .number(value)),
            ("position", .number(position)),
            ("rank", .number(Double(rank))),
        ]))
    }
}

/// Every visible series at a moment, best first: its value between the two time points and its
/// position, which slides from its rank at one time point to its rank at the next so bars swap
/// smoothly. Ties keep the series order.
public func chartRaceRanking(_ spec: ChartSpec, _ frame: Double?) -> [ChartRaceEntry] {
    let visible = spec.series.filter { !($0.hidden ?? false) }
    let moment = chartRaceMoment(spec.categories.count, frame)
    func rankAt(_ i: Int) -> [String: Int] {
        var order = visible.enumerated().map { k, s in
            (id: s.id, v: chartRaceValueAt(s, i), k: k)
        }
        order.sort { a, b in
            if b.v != a.v { return b.v < a.v }
            return a.k < b.k
        }
        var map: [String: Int] = [:]
        for (r, o) in order.enumerated() {
            map[o.id] = r
        }
        return map
    }
    let r0 = rankAt(moment.from)
    let r1 = rankAt(moment.to)
    let near = moment.t < 0.5 ? r0 : r1
    var entries = visible.map { s -> ChartRaceEntry in
        let a = chartRaceValueAt(s, moment.from)
        let b = chartRaceValueAt(s, moment.to)
        let p0 = Double(r0[s.id] ?? 0)
        let p1 = Double(r1[s.id] ?? 0)
        return ChartRaceEntry(
            seriesId: s.id,
            name: s.name,
            value: a + (b - a) * moment.t,
            position: p0 + (p1 - p0) * moment.t,
            rank: near[s.id] ?? 0
        )
    }
    entries.sort { a, b in
        if a.position != b.position { return a.position < b.position }
        return b.value < a.value
    }
    return entries
}
