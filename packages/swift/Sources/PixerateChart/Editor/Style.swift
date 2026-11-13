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
    /// The skill's `brand.json`, when it has a valid, non-empty one.
    public var brand: JSONObject?
    /// The layer that set the brand's `checks` (`style.sources['$brand.checks']`).
    public var brandLayer: String?
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
    public convenience init(skill: String, layer: String, chartJson: JSONValue) {
        self.init(skill: skill, layer: layer, chartJson: chartJson, brandJson: nil)
    }

    /**
     * One `layer` holding one skill with an optional `chart.json` and an optional `brand.json`
     * (parsed JSON). As `resolve` does, the chart starts from the profile it derives from the brand
     * (`chartStyleFromBrand`), its own profile merges over that, and the brand's checks run after
     * its own.
     */
    public init(skill: String, layer: String, chartJson: JSONValue?, brandJson: JSONValue?) {
        var issues: [JSONValue] = []
        func issue(_ message: String) {
            issues.append(.object(JSONObject([("skill", .string(skill)), ("layer", .string(layer)), ("message", .string(message))])))
        }
        // Profiles load in domain order: chart, then brand (the brand domain is added last).
        var own: JSONObject?
        if let chartJson {
            let loaded = loadChartStyleProfile(chartJson)
            if let error = loaded.error { issue(error) }
            own = loaded.profile
        }
        var brand: JSONObject?
        if let brandJson {
            let loaded = loadBrandProfile(brandJson)
            if let error = loaded.error { issue(error) }
            if let p = loaded.profile, !p.isEmpty { brand = p }
        }
        var profile = JSONObject()
        if let brand {
            let derived = chartStyleFromBrand(brand)
            let errors = validateJSONSchema(.object(derived), CHART_STYLE_PROFILE_SCHEMA).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
            if errors.isEmpty {
                profile = derived
            } else {
                issues.append(.object(JSONObject([("message", .string("The chart style derived from the brand is left out: \(errors.joined(separator: " "))"))])))
            }
        }
        if let own { mergeStyleProfile(&profile, own) }
        self.profile = profile
        self.layer = own?["checks"] != nil ? layer : nil
        self.brand = brand
        self.brandLayer = brand?["checks"] != nil ? layer : nil
        self.styleIssues = issues
        self.hasSkills = true
    }

    public func check(_ spec: ChartSpec) -> ChartStyleCheckReport {
        runChartStyleChecks(spec, profile: profile, layer: layer, styleIssues: styleIssues, brand: brand, brandLayer: brandLayer)
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
    // Shared checks the chart does not replace (`styleChecksOf`): fonts-allowed.
    ("fonts-allowed", SHARED_STYLE_CHECK_OPTIONS.first(where: { $0.id == "fonts-allowed" })!.schema),
]

/// Loads a style skill's `chart.json` as `createStyleResolver` does: the profile, or why it is left out.
public func loadChartStyleProfile(_ raw: JSONValue, file: String = "chart.json") -> (profile: JSONObject?, error: String?) {
    loadStyleProfile(raw, file: file, schema: CHART_STYLE_PROFILE_SCHEMA, checks: CHART_STYLE_CHECK_OPTIONS)
}

public func chartStyleFromBrand(_ brand: JSONObject) -> JSONObject {
    let palette = brandPalette(brand)
    var theme = JSONObject()
    func set(_ key: String, _ value: String?) {
        if let value, !value.isEmpty { theme[key] = .string(value) }
    }
    set("background", brandColor(brand, "background"))
    set("surface", brandColor(brand, "surface"))
    set("text", brandColor(brand, "text"))
    set("mutedText", brandColor(brand, "mutedText"))
    set("grid", brandColor(brand, "border"))
    set("axis", brandColor(brand, "border"))
    set("positive", brandColor(brand, "positive"))
    set("negative", brandColor(brand, "negative"))
    let fonts = brand["fonts"]?.objectValue
    let font = fonts?["body"]?.stringValue ?? fonts?["heading"]?.stringValue
    // A brand names one family; charts need a stack that still reads where it is not installed.
    if let font, !font.contains(",") {
        let quoted = font.contains(where: { $0.isWhitespace }) ? JSONValue.string(font).stringified() : font
        set("fontFamily", "\(quoted), system-ui, sans-serif")
    } else {
        set("fontFamily", font)
    }
    var out = JSONObject()
    if !palette.isEmpty { out["palette"] = .array(palette.map { .string($0) }) }
    if !theme.isEmpty { out["theme"] = .object(theme) }
    return out
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
    styleIssues: [JSONValue] = [],
    brand: JSONObject? = nil,
    brandLayer: String? = nil
) -> ChartStyleCheckReport {
    var findings: [ChartStyleFinding] = []
    var ran: [String] = []
    var skipped: [ChartStyleSkipped] = []
    func idOf(_ entry: JSONValue) -> String? {
        switch entry {
        case .string(let s): return s
        case .object(let o): return o["id"]?.stringValue
        default: return nil
        }
    }
    // The profile's checks, then the brand's checks the profile does not list itself.
    let own = profile["checks"]?.arrayValue ?? []
    let ownIds = own.map(idOf)
    let fromBrand = (brand?["checks"]?.arrayValue ?? []).filter { e in !ownIds.contains(where: { $0 == idOf(e) }) }
    let checkEntries = own.map { (entry: $0, layer: layer) } + fromBrand.map { (entry: $0, layer: brandLayer) }
    let knownChecks = ["palette-only", "distinguishable", "min-contrast", "allowed-type", "fonts-allowed"]
    for (entry, layer) in checkEntries {
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
        case "fonts-allowed":
            // The shared check on the chart surface, which has no fonts: it runs with no findings
            // once some font is named, and is skipped otherwise.
            let allowed = styleStrings(options["fonts"]) ?? styleStrings(profile["fonts"]) ?? brandFonts(brand)
            if allowed.isEmpty {
                skipped.append(ChartStyleSkipped(check: id, reason: "The check could not run: neither the check, the profile nor the brand names any fonts."))
                continue
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
