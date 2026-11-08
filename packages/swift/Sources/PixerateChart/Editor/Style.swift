import Foundation
import PixerateCore
import PixerateRaster

public struct ChartStyleFinding: Sendable, Equatable {
    public var check: String
    public var layer: String?
    public var severity: String
    public var message: String
    public var target: ChartSelection?

    public init(
        check: String,
        layer: String? = nil,
        severity: String,
        message: String,
        target: ChartSelection? = nil
    ) {
        self.check = check
        self.layer = layer
        self.severity = severity
        self.message = message
        self.target = target
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("severity", .string(severity)),
            ("message", .string(message))
        ])
        if let target { obj["target"] = target.toJSON() }
        obj["check"] = .string(check)
        if let layer { obj["layer"] = .string(layer) }
        return .object(obj)
    }
}

public struct ChartStyleSkipped: Sendable, Equatable {
    public var check: String
    public var reason: String

    public init(check: String, reason: String) {
        self.check = check
        self.reason = reason
    }

    public func toJSON() -> JSONValue {
        .object(JSONObject([
            ("check", .string(check)),
            ("reason", .string(reason))
        ]))
    }
}

public struct ChartStyleCheckReport: Sendable, Equatable {
    public var findings: [ChartStyleFinding]
    public var ran: [String]
    public var skipped: [ChartStyleSkipped]
    public var styleIssues: [JSONValue]

    public init(
        findings: [ChartStyleFinding] = [],
        ran: [String] = [],
        skipped: [ChartStyleSkipped] = [],
        styleIssues: [JSONValue] = []
    ) {
        self.findings = findings
        self.ran = ran
        self.skipped = skipped
        self.styleIssues = styleIssues
    }
}

public final class ChartStyleResolver: @unchecked Sendable {
    public var profile: JSONObject
    public var layer: String?
    public var styleIssues: [JSONValue]

    public init(profile: JSONObject = JSONObject(), layer: String? = "org", styleIssues: [JSONValue] = []) {
        self.profile = profile
        self.layer = profile.isEmpty ? nil : layer
        self.styleIssues = styleIssues
    }

    public func check(_ spec: ChartSpec) -> ChartStyleCheckReport {
        runChartStyleChecks(spec, profile: profile, layer: layer, styleIssues: styleIssues)
    }
}

private struct DrawnColorItem {
    var color: String
    var label: String
    var target: ChartSelection
}

private func chartColors(_ spec: ChartSpec) -> [DrawnColorItem] {
    var out: [DrawnColorItem] = []
    let visible = spec.series.enumerated().filter { !($0.element.hidden ?? false) }
    if chartColorsByCategory(spec.type) {
        let first = visible.first
        for (index, name) in spec.categories.enumerated() {
            let own: String? = (first?.element.pointColors != nil && index < first!.element.pointColors!.count)
                ? first!.element.pointColors![index]
                : nil
            let color = (own != nil && !own!.isEmpty) ? own! : chartSliceColor(spec, index)
            let target: ChartSelection = first != nil
                ? .point(seriesId: first!.element.id, index: index)
                : .category(index: index)
            out.append(DrawnColorItem(color: color, label: "Slice \"\(name)\"", target: target))
        }
        return out
    }
    for (i, s) in visible {
        out.append(DrawnColorItem(color: chartSeriesColor(spec, i), label: "Series \"\(s.name)\"", target: .series(seriesId: s.id)))
        if let pcs = s.pointColors {
            for (index, cOpt) in pcs.enumerated() {
                if let c = cOpt, !c.isEmpty {
                    out.append(DrawnColorItem(color: c, label: "Point \(index + 1) of \"\(s.name)\"", target: .point(seriesId: s.id, index: index)))
                }
            }
        }
    }
    return out
}

public func runChartStyleChecks(
    _ spec: ChartSpec,
    profile: JSONObject,
    layer: String? = "org",
    styleIssues: [JSONValue] = []
) -> ChartStyleCheckReport {
    var findings: [ChartStyleFinding] = []
    var ran: [String] = []
    var skipped: [ChartStyleSkipped] = []
    guard case .array(let checkEntries)? = profile["checks"] else {
        return ChartStyleCheckReport(findings: findings, ran: ran, skipped: skipped, styleIssues: styleIssues)
    }
    let knownChecks = ["palette-only", "distinguishable", "min-contrast", "allowed-type"]
    for entry in checkEntries {
        let id: String
        let options: JSONObject
        switch entry {
        case .string(let s):
            id = s
            options = JSONObject()
        case .object(let obj):
            guard let s = obj["id"]?.stringValue, !s.isEmpty else { continue }
            id = s
            options = obj
        default:
            continue
        }
        guard knownChecks.contains(id) else {
            let list = knownChecks.map { "\"\($0)\"" }.joined(separator: ", ")
            skipped.append(ChartStyleSkipped(
                check: id,
                reason: "There is no \"\(id)\" check for chart; it has \(list)."
            ))
            continue
        }
        switch id {
        case "palette-only":
            let palette = profile["palette"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            if palette.isEmpty {
                skipped.append(ChartStyleSkipped(check: id, reason: "The check could not run: the profile has no palette."))
                continue
            }
            let tolerance = options["tolerance"]?.numberValue ?? 0.02
            let allowed: [(c: String, rgb: ChartRgb?)] = palette.flatMap { c in
                CHART_PALETTE_SHADES.map { t in shadeChartColor(c, t) }
            }.map { c in (c: c, rgb: parseChartColor(c)) }
            for item in chartColors(spec) {
                guard let rgb = parseChartColor(item.color) else { continue }
                var best = (c: palette[0], d: Double.infinity)
                for a in allowed {
                    guard let aRgb = a.rgb else { continue }
                    let d = chartColorDistance(rgb, aRgb)
                    if d < best.d { best = (c: a.c, d: d) }
                }
                if best.d <= tolerance { continue }
                let nearest = palette.map { c -> (c: String, d: Double) in
                    if let pRgb = parseChartColor(c) {
                        return (c: c, d: chartColorDistance(rgb, pRgb))
                    }
                    return (c: c, d: .infinity)
                }.min(by: { $0.d < $1.d })?.c ?? palette[0]
                findings.append(ChartStyleFinding(
                    check: id,
                    layer: layer,
                    severity: "error",
                    message: "\(item.label) uses \(item.color), which is not in the house palette; use \(nearest) or another palette colour (\(palette.joined(separator: ", "))).",
                    target: item.target
                ))
            }
        case "distinguishable":
            let minDistance = options["minDistance"]?.numberValue ?? 0.08
            let colors = chartColors(spec).filter { item in
                item.target.kindName != "point" || chartColorsByCategory(spec.type)
            }
            let result = checkChartColors(
                colors.map(\.color),
                ChartColorCheckOptions(minDistance: minDistance, minContrast: 0)
            )
            for (vision, pair) in result.closest {
                if pair.distance >= minDistance { continue }
                let who = vision == .normal ? "" : " with \(vision.rawValue)"
                findings.append(ChartStyleFinding(
                    check: id,
                    layer: layer,
                    severity: "warning",
                    message: "\(colors[pair.a].label) (\(pair.colors.0)) and \(colors[pair.b].label) (\(pair.colors.1)) are hard to tell apart\(who) (distance \(JSONValue.jsNumber(pair.distance)), want \(JSONValue.jsNumber(minDistance))); give the second another palette colour.",
                    target: colors[pair.b].target
                ))
            }
        case "min-contrast":
            let ratio = options["ratio"]?.numberValue ?? 3.0
            let themeObj = profile["theme"]?.objectValue ?? JSONObject()
            let bgOpt = themeObj["background"]?.stringValue
            let surfOpt = themeObj["surface"]?.stringValue
            let background: String
            if let bgOpt, !bgOpt.isEmpty && bgOpt != "transparent" {
                background = bgOpt
            } else if let surfOpt, !surfOpt.isEmpty {
                background = surfOpt
            } else {
                background = "#ffffff"
            }
            for item in chartColors(spec) {
                guard let r = chartContrastRatio(item.color, background), r < ratio else { continue }
                let rounded = JS.round(r * 100.0) / 100.0
                findings.append(ChartStyleFinding(
                    check: id,
                    layer: layer,
                    severity: "warning",
                    message: "\(item.label) (\(item.color)) has contrast \(JSONValue.jsNumber(rounded)):1 against the background \(background); want at least \(JSONValue.jsNumber(ratio)):1, so use a darker or lighter palette colour.",
                    target: item.target
                ))
            }
        case "allowed-type":
            let allowed = options["types"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            if !allowed.isEmpty && !allowed.contains(spec.type.rawValue) {
                findings.append(ChartStyleFinding(
                    check: id,
                    layer: layer,
                    severity: "error",
                    message: "This is a \(spec.type.rawValue) chart; the house style allows \(allowed.joined(separator: ", ")). Change the type with update_chart.",
                    target: .chart
                ))
            }
        default:
            break
        }
        ran.append(id)
    }
    return ChartStyleCheckReport(findings: findings, ran: ran, skipped: skipped, styleIssues: styleIssues)
}

public func chartStylePatch(_ profile: JSONObject) -> JSONObject {
    var out = profile["defaults"]?.objectValue ?? JSONObject()
    if let palette = profile["palette"]?.arrayValue, !palette.isEmpty {
        out["palette"] = .array(palette)
    }
    return out
}

public struct ChartStyleToolProviderOptions: Sendable {
    public var id: String
    public var namespace: String

    public init(id: String = "chart-style", namespace: String = "chart") {
        self.id = id
        self.namespace = namespace
    }
}

public func createChartStyleToolProvider(
    _ controller: ChartController,
    _ style: ChartStyleResolver,
    _ options: ChartStyleToolProviderOptions = ChartStyleToolProviderOptions()
) -> AgentToolProvider {
    let def = (try? ChartContracts.tools())?.first(where: { $0.name == "check_chart_style" })
    let checkTool = AgentTool(
        name: "check_chart_style",
        title: def?.title ?? "Check chart house style",
        description: def?.description ?? "Checks the chart against the house style.",
        inputSchema: def?.inputSchema ?? ["type": .string("object"), "properties": .object(JSONObject()), "additionalProperties": .bool(false)],
        outputSchema: def?.outputSchema,
        annotations: def?.annotations ?? ToolAnnotations(
            title: "Check chart house style",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        ),
        handler: { _, _ in
            let report = style.check(controller.getSpec())
            var out = JSONObject([
                ("findings", .array(report.findings.map { $0.toJSON() })),
                ("ran", .array(report.ran.map(JSONValue.string))),
                ("skipped", .array(report.skipped.map { $0.toJSON() })),
                ("ok", .bool(report.findings.isEmpty))
            ])
            if style.layer == nil {
                out["note"] = .string("No house style applies to charts.")
            }
            if !report.styleIssues.isEmpty {
                out["issues"] = .array(report.styleIssues)
            }
            return .value(.object(out))
        }
    )
    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Chart house style",
        description: "Check a chart against the house style.",
        skill: "pixerate-chart",
        tools: [checkTool]
    )
}
