// Streaming follows Ursula's MermaidStreamingView and src/graph/view.ts (`blendLayout`: marks are matched by id,
// new ones appear at their target, missing ones drop out; layouts are adopted on a throttle and the scale is held
// steady until the source is complete).
import Foundation
import PixerateCore
import PixerateRaster

/// Reads JSON that is still arriving: closes open strings, arrays and objects and drops a
/// dangling key or comma, so `{"type":"bar","series":[{"name":"A","values":[1,2` reads as far
/// as it goes. Returns `nil` when nothing usable has arrived yet.
public func parsePartialChartJson(_ text: String) -> JSONValue? {
    let src = text.jsTrimmed
    if src.isEmpty { return nil }
    if let data = src.data(using: .utf8), let parsed = try? JSONValue.parse(data) {
        return parsed
    }
    var stack: [Character] = []
    var inString = false
    var escaped = false
    var out = ""
    for ch in src {
        out.append(ch)
        if inString {
            if escaped {
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "\"" {
                inString = false
            }
            continue
        }
        if ch == "\"" {
            inString = true
        } else if ch == "{" || ch == "[" {
            stack.append(ch == "{" ? "}" : "]")
        } else if ch == "}" || ch == "]" {
            _ = stack.popLast()
        }
    }
    if inString { out.append("\"") }
    let closing = String(stack.reversed())
    for _ in 0..<6 {
        let trimmed = out.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        let candidate = trimmed + closing
        if let data = candidate.data(using: .utf8), let parsed = try? JSONValue.parse(data) {
            return parsed
        }
        var next = trimmed.replacingOccurrences(of: #",\s*$"#, with: "", options: .regularExpression)
        if let range = next.range(of: #"(?:,|\{)\s*"[^"]*"\s*:?\s*$"#, options: .regularExpression) {
            let m = String(next[range]).jsTrimmed
            next.replaceSubrange(range, with: m.hasPrefix("{") ? "{" : "")
        }
        next = next.replacingOccurrences(of: #":\s*$"#, with: ": null", options: .regularExpression)
        next = next.replacingOccurrences(of: #"(?<=[\[,:]\s*)(-|tr?u?|fa?l?s?|nu?l?)$"#, with: "", options: .regularExpression)
        if let dotRange = next.range(of: #"(?<=[\[,:]\s*)(-?[0-9]+\.)$"#, options: .regularExpression) {
            let m = String(next[dotRange])
            next.replaceSubrange(dotRange, with: String(m.dropLast()))
        }
        if next == trimmed { break }
        out = next
    }
    return nil
}

public enum ChartStreamFormat: String, CaseIterable, Sendable, Equatable {
    case auto
    case mermaid
    case json
}

public struct ChartStreamResult: Sendable, Equatable {
    public var spec: ChartSpec?
    public var issues: [ChartIssue]
    public var valueDomain: ChartDomainBounds?

    public init(spec: ChartSpec?, issues: [ChartIssue], valueDomain: ChartDomainBounds?) {
        self.spec = spec
        self.issues = issues
        self.valueDomain = valueDomain
    }

    public func toJSON() -> JSONValue {
        let vd: JSONValue
        if let valueDomain {
            vd = .object(JSONObject([
                ("min", .number(valueDomain.min)),
                ("max", .number(valueDomain.max))
            ]))
        } else {
            vd = .null
        }
        return .object(JSONObject([
            ("spec", spec?.toJSON() ?? .null),
            ("issues", .array(issues.map { $0.toJSON() })),
            ("valueDomain", vd)
        ]))
    }
}

public final class ChartStream {
    private var lo: Double = .infinity
    private var hi: Double = -.infinity
    private var last: ChartSpec? = nil
    private let format: ChartStreamFormat

    public init(format: ChartStreamFormat = .auto) {
        self.format = format
    }

    public func update(_ source: String, complete: Bool = false) -> ChartStreamResult {
        let text = source
            .replacingOccurrences(of: #"^\s*```(?:mermaid|json)?\s*\n?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"```\s*$"#, with: "", options: .regularExpression)
        let fmt: ChartStreamFormat
        if format == .auto {
            fmt = text.range(of: #"^\s*[\[{]"#, options: .regularExpression) != nil ? .json : .mermaid
        } else {
            fmt = format
        }
        var spec: ChartSpec? = nil
        var issues: [ChartIssue] = []
        if fmt == .json {
            let value = complete ? safeParse(text) : parsePartialChartJson(text)
            if let value {
                let read = normalizeChartSpec(value)
                spec = read.spec
                issues = complete ? read.issues : []
            }
        } else {
            let read = chartFromMermaid(text, ChartMermaidParseOptions(partial: !complete))
            if read.family != nil {
                spec = read.spec
            }
            issues = read.issues
        }
        if let cur = spec, !cur.series.contains(where: { $0.values.contains(where: { $0 != nil }) }) {
            spec = complete ? cur : last
        }
        if let cur = spec {
            last = cur
            for s in cur.series {
                for vOpt in s.values {
                    if let v = vOpt, v.isFinite {
                        lo = Swift.min(lo, v)
                        hi = Swift.max(hi, v)
                    }
                }
            }
        }
        let valueDomain: ChartDomainBounds?
        if !complete && lo.isFinite && hi > lo {
            valueDomain = ChartDomainBounds(min: Swift.min(0.0, lo), max: hi)
        } else {
            valueDomain = nil
        }
        return ChartStreamResult(spec: spec, issues: issues, valueDomain: valueDomain)
    }

    public func reset() {
        lo = .infinity
        hi = -.infinity
        last = nil
    }
}

private func safeParse(_ text: String) -> JSONValue? {
    if let data = text.data(using: .utf8), let parsed = try? JSONValue.parse(data) {
        return parsed
    }
    return parsePartialChartJson(text)
}

private func mix(_ a: Double, _ b: Double, _ t: Double) -> Double {
    a + (b - a) * t
}

private func blendPath(_ a: String, _ b: String, _ t: Double) -> String {
    guard let regex = try? NSRegularExpression(pattern: #"-?[0-9]*\.?[0-9]+(?:e-?[0-9]+)?"#) else {
        return t < 1.0 ? a : b
    }
    let nsA = NSRange(a.startIndex..<a.endIndex, in: a)
    let nsB = NSRange(b.startIndex..<b.endIndex, in: b)
    let matchesA = regex.matches(in: a, options: [], range: nsA)
    let matchesB = regex.matches(in: b, options: [], range: nsB)
    guard !matchesA.isEmpty, matchesA.count == matchesB.count else {
        return t < 1.0 ? a : b
    }
    let shapeA = regex.stringByReplacingMatches(in: a, options: [], range: nsA, withTemplate: "#")
    let shapeB = regex.stringByReplacingMatches(in: b, options: [], range: nsB, withTemplate: "#")
    guard shapeA == shapeB else {
        return t < 1.0 ? a : b
    }
    var out = ""
    var lastIdx = b.startIndex
    for i in 0..<matchesB.count {
        guard let rA = Range(matchesA[i].range, in: a),
              let rB = Range(matchesB[i].range, in: b),
              let va = Double(a[rA]),
              let vb = Double(b[rB]) else {
            return t < 1.0 ? a : b
        }
        out += b[lastIdx..<rB.lowerBound]
        let v = mix(va, vb, t)
        out += r2s(v)
        lastIdx = rB.upperBound
    }
    out += b[lastIdx..<b.endIndex]
    return out
}

/// A scene between two scenes, for animating changes: marks are matched by `key`;
/// numbers and same-shaped paths move from `from` to `to`; new marks fade in and
/// marks that are gone are dropped. `t` runs from 0 to 1.
public func blendChartScenes(_ from: ChartScene?, _ to: ChartScene, _ t: Double) -> ChartScene {
    guard let from, t < 1.0 else { return to }
    let k = Swift.max(0.0, Swift.min(1.0, t))
    var before: [String: ChartMark] = [:]
    for m in from.marks { before[m.key] = m }
    let marks: [ChartMark] = to.marks.map { m in
        guard let a = before[m.key] else {
            return m.withMultipliedOpacity(k)
        }
        switch (a, m) {
        case (.rect(let p), .rect(var q)):
            q.x = mix(p.x, q.x, k)
            q.y = mix(p.y, q.y, k)
            q.width = mix(p.width, q.width, k)
            q.height = mix(p.height, q.height, k)
            return .rect(q)
        case (.circle(let p), .circle(var q)):
            q.cx = mix(p.cx, q.cx, k)
            q.cy = mix(p.cy, q.cy, k)
            q.r = mix(p.r, q.r, k)
            return .circle(q)
        case (.line(let p), .line(var q)):
            q.x1 = mix(p.x1, q.x1, k)
            q.y1 = mix(p.y1, q.y1, k)
            q.x2 = mix(p.x2, q.x2, k)
            q.y2 = mix(p.y2, q.y2, k)
            return .line(q)
        case (.text(let p), .text(var q)):
            q.x = mix(p.x, q.x, k)
            q.y = mix(p.y, q.y, k)
            return .text(q)
        case (.path(let p), .path(var q)):
            q.d = blendPath(p.d, q.d, k)
            return .path(q)
        default:
            return m.withMultipliedOpacity(k)
        }
    }
    var out = to
    out.marks = marks
    return out
}

extension ChartMark {
    fileprivate func withMultipliedOpacity(_ factor: Double) -> ChartMark {
        switch self {
        case .rect(var m):
            m.opacity = (m.opacity ?? 1.0) * factor
            return .rect(m)
        case .circle(var m):
            m.opacity = (m.opacity ?? 1.0) * factor
            return .circle(m)
        case .line(var m):
            m.opacity = (m.opacity ?? 1.0) * factor
            return .line(m)
        case .text(var m):
            m.opacity = (m.opacity ?? 1.0) * factor
            return .text(m)
        case .path(var m):
            m.opacity = (m.opacity ?? 1.0) * factor
            return .path(m)
        }
    }
}

/// Ease-out cubic, for tweens.
public func easeChartTween(_ t: Double) -> Double {
    let clamped = 1.0 - Swift.max(0.0, Swift.min(1.0, t))
    return 1.0 - clamped * clamped * clamped
}
