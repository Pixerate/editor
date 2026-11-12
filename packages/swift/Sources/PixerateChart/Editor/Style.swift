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

/**
 * The chart house style: one style skill's resolved `chart.json` profile.
 *
 * `init(skill:layer:chartJson:)` is a port of what `createStyleResolver` (`tools/style.ts`) does for
 * one layer holding one skill (the conformance host's setup): `$token` references (left out with an
 * issue, as there is no token source), the profile validated against `chartStyleDomain.profileSchema`
 * and each check's `optionsSchema`, and a profile with errors left out with the TS issue message.
 * Multi-layer merging (locks, required layers, skill state) is not ported.
 */
public final class ChartStyleResolver: @unchecked Sendable {
    public var profile: JSONObject
    /// The layer that set the profile's `checks` (`style.sources.checks`), named on findings.
    public var layer: String?
    public var styleIssues: [JSONValue]
    /// Whether a style skill applies to charts (without one, `check_chart_style` adds a note).
    public var hasSkills: Bool

    public init(profile: JSONObject = JSONObject(), layer: String? = "org", styleIssues: [JSONValue] = []) {
        self.profile = profile
        self.layer = profile.isEmpty ? nil : layer
        self.styleIssues = styleIssues
        self.hasSkills = !profile.isEmpty
    }

    /// One `layer` holding one skill whose `chart.json` is `chartJson` (parsed JSON).
    public init(skill: String, layer: String, chartJson: JSONValue) {
        let loaded = loadChartStyleProfile(chartJson)
        var issues: [JSONValue] = []
        if let error = loaded.error {
            issues.append(.object(JSONObject([("skill", .string(skill)), ("layer", .string(layer)), ("message", .string(error))])))
        }
        self.profile = loaded.profile ?? JSONObject()
        self.layer = self.profile["checks"] != nil ? layer : nil
        self.styleIssues = issues
        self.hasSkills = true
    }

    public func check(_ spec: ChartSpec) -> ChartStyleCheckReport {
        runChartStyleChecks(spec, profile: profile, layer: layer, styleIssues: styleIssues)
    }
}

// MARK: - Profile validation (`createStyleResolver` load step and `chartStyleDomain` schemas)

/// `CHART_TYPES` in `chart/style.ts` (the types `allowed-type` accepts), not the spec's list.
private let STYLE_CHART_TYPES = ["bar", "line", "area", "scatter", "bubble", "pie", "donut", "radar", "waterfall", "histogram", "box", "funnel", "treemap"]

private func styleSchema(_ json: String) -> JSONValue { try! JSONValue.parse(json) }

private let STYLE_COLOR = #"{"type":"string","minLength":1,"description":"A CSS colour (hex or rgb()), or a { \"$token\": ... } reference."}"#

/// `chartStyleDomain.profileSchema`.
private let CHART_STYLE_PROFILE_SCHEMA: JSONValue = {
    let schemes = CHART_COLOR_SCHEMES.map { JSONValue.string($0.id).stringified() }.joined(separator: ",")
    let layouts = CHART_LAYOUT_PRESETS.map { JSONValue.string($0.id).stringified() }.joined(separator: ",")
    let c = STYLE_COLOR
    return styleSchema("""
    {"type":"object","properties":{
    "palette":{"type":"array","items":\(c),"minItems":1},
    "colorSchemes":{"type":"array","items":{"type":"string","enum":[\(schemes)]}},
    "layouts":{"type":"array","items":{"type":"string","enum":[\(layouts)]}},
    "theme":{"type":"object","properties":{"background":\(c),"surface":\(c),"text":\(c),"mutedText":\(c),"grid":\(c),"axis":\(c),"positive":\(c),"negative":\(c),
    "fontFamily":{"type":"string","minLength":1},"fontSize":{"type":"number","minimum":6,"maximum":48},"titleSize":{"type":"number","minimum":6,"maximum":72}},"additionalProperties":false},
    "defaults":{"type":"object","properties":{"dataLabels":{"type":"boolean"},"points":{"type":"boolean"},"curve":{"type":"string","enum":["linear","smooth","step"]},
    "stacking":{"type":"string","enum":["none","stacked","percent"]},"orientation":{"type":"string","enum":["vertical","horizontal"]},
    "labelPosition":{"type":"string","enum":["auto","inside","outside","center"]}},"additionalProperties":false}
    },"additionalProperties":false}
    """)
}()

/// Each chart style check's `optionsSchema`, in `chartStyleDomain.checks` order.
private let CHART_STYLE_CHECK_OPTIONS: [(id: String, schema: JSONValue)] = [
    ("palette-only", styleSchema(#"{"type":"object","properties":{"tolerance":{"type":"number","minimum":0,"maximum":1}},"additionalProperties":false}"#)),
    ("distinguishable", styleSchema(#"{"type":"object","properties":{"minDistance":{"type":"number","minimum":0,"maximum":1}},"additionalProperties":false}"#)),
    ("min-contrast", styleSchema(#"{"type":"object","properties":{"ratio":{"type":"number","minimum":1,"maximum":21}},"additionalProperties":false}"#)),
    ("allowed-type", styleSchema("""
    {"type":"object","properties":{"types":{"type":"array","items":{"type":"string","enum":[\(STYLE_CHART_TYPES.map { "\"\($0)\"" }.joined(separator: ","))]},"minItems":1}},"required":["types"],"additionalProperties":false}
    """)),
]

/// `resolveTokens` with no token source: every `{ "$token": ... }` is an error and resolves to
/// `undefined` (`nil`). An `undefined` array item becomes `null`, its path kept in `undefinedPaths` so
/// the schema message can say `undefined`; an `undefined` object member is dropped (the TS validator
/// skips it, and `required` treats it as missing).
private func resolveStyleTokens(_ value: JSONValue, _ path: String, _ pointer: String, _ errors: inout [String], _ undefinedPaths: inout Set<String>) -> JSONValue? {
    switch value {
    case .array(let items):
        return .array(items.enumerated().map { i, v in
            if let r = resolveStyleTokens(v, "\(path)[\(i)]", "\(pointer)/\(i)", &errors, &undefinedPaths) { return r }
            undefinedPaths.insert("\(pointer)/\(i)")
            return .null
        })
    case .object(let obj):
        if obj.contains("$token") {
            let token = obj["$token"]
            let mode = obj["mode"]
            let tokenOk: Bool = { if case .string(let s)? = token { return !s.isEmpty }; return false }()
            let modeOk: Bool = { if mode == nil { return true }; if case .string? = mode { return true }; return false }()
            if !tokenOk || !modeOk || obj.keys.contains(where: { $0 != "$token" && $0 != "mode" }) {
                errors.append("\(path.isEmpty ? "profile" : path): a token reference is { \"$token\": \"<variable name or id>\", \"mode\"?: \"<mode>\" }.")
                return nil
            }
            errors.append("\(path.isEmpty ? "profile" : path): \"\(token!.stringValue!)\" is a token reference, but this host has no design tokens to resolve it.")
            return nil
        }
        var out = JSONObject()
        for (k, v) in obj {
            if let r = resolveStyleTokens(v, path.isEmpty ? k : "\(path).\(k)", "\(pointer)/\(k)", &errors, &undefinedPaths) { out[k] = r }
        }
        return .object(out)
    default:
        return value
    }
}

private func styleSchemaErrors(_ value: JSONValue, _ schema: JSONValue, _ undefinedPaths: Set<String>, pointerPrefix: String = "") -> [SchemaValidationError] {
    validateJSONSchema(value, schema).map { e in
        guard undefinedPaths.contains(pointerPrefix + e.path), e.message.hasSuffix(", got null.") else { return e }
        return SchemaValidationError(path: e.path, message: String(e.message.dropLast("null.".count)) + "undefined.")
    }
}

/// `checkListErrors`: problems with a profile's `checks` list, against the chart checks.
private func chartCheckListErrors(_ list: JSONValue?, _ undefinedPaths: Set<String>) -> [String] {
    guard let list else { return [] }
    guard case .array(let entries) = list else { return ["checks: expected a list of check ids or { \"id\": ..., options } objects."] }
    var errors: [String] = []
    for (i, entry) in entries.enumerated() {
        let id: String?
        switch entry {
        case .string(let s): id = s
        case .object(let o): id = o["id"]?.stringValue
        default: id = nil
        }
        guard let id, !id.isEmpty, !undefinedPaths.contains("/checks/\(i)") else {
            errors.append("checks[\(i)]: expected a check id or { \"id\": ..., options }.")
            continue
        }
        guard case .object(var options) = entry, let check = CHART_STYLE_CHECK_OPTIONS.first(where: { $0.id == id }) else { continue }
        options["id"] = Optional<JSONValue>.none
        for e in styleSchemaErrors(.object(options), check.schema, undefinedPaths, pointerPrefix: "/checks/\(i)") {
            errors.append("checks[\(i)] (\(id))\(e.path): \(e.message)")
        }
    }
    return errors
}

/// Loads a style skill's `chart.json` as `createStyleResolver` does: the profile, or why it is left out.
public func loadChartStyleProfile(_ raw: JSONValue, file: String = "chart.json") -> (profile: JSONObject?, error: String?) {
    guard case .object = stripPrototypeKeys(raw) else { return (nil, "\(file) must hold a JSON object.") }
    var errors: [String] = []
    var undefinedPaths = Set<String>()
    // A root `{ "$token": ... }` resolves to a value or to nothing, never to a profile object: the
    // profile is left out with the reason, as `createStyleResolver` does (#768).
    // With no token source here, it always resolves to nothing and an error says why.
    guard case .object(let resolved)? = resolveStyleTokens(stripPrototypeKeys(raw), "", "", &errors, &undefinedPaths) else {
        return (nil, "\(file) is left out: \(errors.joined(separator: " "))")
    }
    var rest = resolved
    rest["checks"] = Optional<JSONValue>.none
    errors += styleSchemaErrors(.object(rest), CHART_STYLE_PROFILE_SCHEMA, undefinedPaths).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
    errors += chartCheckListErrors(resolved["checks"], undefinedPaths)
    if !errors.isEmpty { return (nil, "\(file) is left out: \(errors.joined(separator: " "))") }
    return (resolved, nil)
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
                    message: "\(colors[pair.a].label) (\(pair.colors.0)) and \(colors[pair.b].label) (\(pair.colors.1)) are hard to tell apart\(who) (distance \(JSONValue.jsString(pair.distance)), want \(JSONValue.jsString(minDistance))); give the second another palette colour.",
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
                    message: "\(item.label) (\(item.color)) has contrast \(JSONValue.jsString(rounded)):1 against the background \(background); want at least \(JSONValue.jsString(ratio)):1, so use a darker or lighter palette colour.",
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

public struct ChartStyleToolProviderOptions: @unchecked Sendable {
    public var id: String
    public var namespace: String
    /// As for `createChartToolProvider`: a read-only chart hides `apply_chart_style` (a `String`
    /// reason or `true`); `check_chart_style` keeps working.
    public var readOnly: (() -> Any)?

    public init(id: String = "chart-style", namespace: String = "chart", readOnly: (() -> Any)? = nil) {
        self.id = id
        self.namespace = namespace
        self.readOnly = readOnly
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
            if !style.hasSkills {
                out["note"] = .string("No house style applies to charts.")
            }
            if !report.styleIssues.isEmpty {
                out["issues"] = .array(report.styleIssues)
            }
            return .value(.object(out))
        }
    )
    let readOnlyReason: () -> String? = {
        guard let ro = options.readOnly?() else { return nil }
        if let b = ro as? Bool { return b ? "This chart is read-only." : nil }
        if let s = ro as? String, !s.isEmpty { return s }
        return nil
    }
    let applyDef = (try? ChartContracts.tools())?.first(where: { $0.name == "apply_chart_style" })
    let applyTool = AgentTool(
        name: "apply_chart_style",
        title: applyDef?.title ?? "Apply the chart house style",
        description: applyDef?.description ?? "Starts the chart from the house style, as one undo step.",
        inputSchema: applyDef?.inputSchema ?? ["type": .string("object"), "properties": .object(JSONObject()), "additionalProperties": .bool(false)],
        outputSchema: applyDef?.outputSchema,
        annotations: applyDef?.annotations ?? ToolAnnotations(
            title: "Apply the chart house style",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        ),
        handler: { _, _ in
            if let reason = readOnlyReason() { throw ToolExecutionError(reason) }
            let patch = chartStylePatch(style.profile)
            if patch.isEmpty {
                throw ToolExecutionError(style.hasSkills
                    ? "The house style sets no chart palette or defaults, so there is nothing to apply; check_chart_style checks the chart against it."
                    : "No house style applies to charts, so there is nothing to apply.")
            }
            let result = controller.update(patch, options: ChartEditOptions(label: "Apply house style"))
            if !result.ok { throw ToolExecutionError("The house style could not be applied: \(result.message ?? "")") }
            return .value(.object(JSONObject([("applied", .object(patch)), ("spec", controller.toJSON().toJSON())])))
        }
    )
    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Chart house style",
        description: "Check a chart against the house style.",
        skill: "pixerate-chart",
        // As in TS: a read-only chart lists only the check, so an apply call is an unknown tool.
        tools: { readOnlyReason() != nil ? [checkTool] : [checkTool, applyTool] },
        subscribe: { notify in
            var last = readOnlyReason()
            return controller.subscribe { _ in
                let now = readOnlyReason()
                if now != last {
                    last = now
                    notify()
                }
            }
        }
    )
}
