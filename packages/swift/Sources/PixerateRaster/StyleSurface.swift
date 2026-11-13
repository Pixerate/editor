import Foundation
import PixerateCore

// A port of `tools/style-surface.ts` and `runStyleChecks` (`tools/style.ts`): what a domain's
// state draws with (its style surface), the four shared house-style checks that run on it
// (`palette-only`, `min-contrast`, `distinguishable`, `fonts-allowed`), and the runner that puts a
// domain's own checks and the shared ones together. Messages are the TS core's, word for word.

/// One colour a domain's state draws with (`StyleSurfaceColor`).
public struct StyleSurfaceColor: Sendable {
    /// The colour as stored (any CSS colour).
    public var color: String
    /// What uses it, for messages: `Stroke s1`, `Shape "Logo"`.
    public var label: String
    /// What to edit, in the shape the domain's write tools take.
    public var target: JSONValue?
    /// `fill`, `stroke`, `text`, `background` or `series`.
    public var use: String
    /// For `text`: the colour it sits on.
    public var background: String?
    /// For `text`: size in px.
    public var fontSize: Double?
    public var bold: Bool

    public init(color: String, label: String, target: JSONValue? = nil, use: String = "fill", background: String? = nil, fontSize: Double? = nil, bold: Bool = false) {
        self.color = color
        self.label = label
        self.target = target
        self.use = use
        self.background = background
        self.fontSize = fontSize
        self.bold = bold
    }
}

/// One font family a domain's state uses (`StyleSurfaceFont`).
public struct StyleSurfaceFont: Sendable {
    /// The CSS family (or stack; its first family is what is checked).
    public var family: String
    public var label: String
    public var target: JSONValue?

    public init(family: String, label: String, target: JSONValue? = nil) {
        self.family = family
        self.label = label
        self.target = target
    }
}

/// What a domain's state draws with, for the shared checks.
public struct StyleSurface: Sendable {
    public var colors: [StyleSurfaceColor]
    public var fonts: [StyleSurfaceFont]

    public init(colors: [StyleSurfaceColor] = [], fonts: [StyleSurfaceFont] = []) {
        self.colors = colors
        self.fonts = fonts
    }
}

/// A finding before the runner adds its check id and layer.
public struct StyleFindingDraft: Sendable {
    public var severity: String
    public var message: String
    public var target: JSONValue?
    public var suggestion: JSONValue?

    public init(severity: String, message: String, target: JSONValue? = nil, suggestion: JSONValue? = nil) {
        self.severity = severity
        self.message = message
        self.target = target
        self.suggestion = suggestion
    }
}

/// A check that cannot run throws this; the runner skips it with "The check could not run: …".
public struct StyleCheckError: Error, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
}

/// One of a domain's own checks (`StyleCheck`): its id, options schema and run.
public struct StyleCheckDefinition: @unchecked Sendable {
    public var id: String
    /// `nil`: the check takes no options (`{ type: object, properties: {}, additionalProperties: false }`).
    public var optionsSchema: JSONValue?
    /// (profile, options, brand) → findings; throws `StyleCheckError` when it cannot run.
    public var run: (JSONObject, JSONObject, JSONObject?) throws -> [StyleFindingDraft]

    public init(id: String, optionsSchema: JSONValue? = nil, run: @escaping (JSONObject, JSONObject, JSONObject?) throws -> [StyleFindingDraft]) {
        self.id = id
        self.optionsSchema = optionsSchema
        self.run = run
    }
}

/// The shared check ids in `SHARED_STYLE_CHECKS` order.
public let SHARED_STYLE_CHECK_IDS = SHARED_STYLE_CHECK_OPTIONS.map(\.id)

private let NO_OPTIONS_SCHEMA: JSONValue = try! JSONValue.parse(#"{"type":"object","properties":{},"additionalProperties":false}"#)

/// The option schemas a domain's `checks` list is validated against (`styleChecksOf`): its own
/// checks, then, with a surface, the shared checks it does not replace.
public func styleCheckOptionSchemas(_ own: [StyleCheckDefinition], surface: Bool) -> [(id: String, schema: JSONValue)] {
    let mine = own.map { (id: $0.id, schema: $0.optionsSchema ?? NO_OPTIONS_SCHEMA) }
    guard surface else { return mine }
    return mine + SHARED_STYLE_CHECK_OPTIONS.filter { s in !own.contains(where: { $0.id == s.id }) }
}

private typealias Lab = (l: Double, a: Double, b: Double)

private func toLab(_ color: String) -> Lab? { parseCssColor(color).map(cssRgbToOklab) }

/// OKLab distance × 100 (about 1 is a just-noticeable difference).
private func labDistance(_ x: Lab, _ y: Lab) -> Double { JS.hypot(x.l - y.l, x.a - y.a, x.b - y.b) * 100 }

/// `allowedColors`: the profile's `palette`, else the brand's, plus every brand role colour.
private func allowedStyleColors(_ profile: JSONObject, _ brand: JSONObject?) -> [String] {
    (styleStrings(profile["palette"]) ?? brandPalette(brand)) + brandColors(brand).map(\.color)
}

/// `firstFamily`: the first family of a stack, unquoted and lower-cased.
public func styleFirstFamily(_ family: String) -> String {
    var first = String(family.split(separator: ",", omittingEmptySubsequences: false).first ?? "").jsTrimmed
    if first.count >= 2, let q = first.first, q == "'" || q == "\"", first.last == q {
        first = String(first.dropFirst().dropLast())
    }
    return first.jsLowercased
}

private let GENERIC_FAMILIES: Set<String> = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial", "unset"]

/// Runs one shared check on `surface` (`SHARED_STYLE_CHECKS`).
public func runSharedStyleCheck(_ id: String, _ surface: StyleSurface, profile: JSONObject, options: JSONObject, brand: JSONObject?) throws -> [StyleFindingDraft] {
    switch id {
    case "palette-only":
        let allowed = allowedStyleColors(profile, brand).compactMap { c in toLab(c).map { (c: c, lab: $0) } }
        if allowed.isEmpty { throw StyleCheckError("neither the profile nor the brand has a palette.") }
        let tolerance = options["tolerance"]?.numberValue ?? 2
        let allowNeutrals = options["allowNeutrals"] != .bool(false)
        var out: [StyleFindingDraft] = []
        for item in surface.colors {
            guard let rgba = parseCssColor(item.color), rgba.a != 0 else { continue }
            let lab = cssRgbToOklab(rgba)
            if allowNeutrals && cssOklabToOklch(lab).c < 0.02 { continue }
            // The first of the nearest (a stable sort).
            var nearest = (c: allowed[0].c, d: labDistance(lab, allowed[0].lab))
            for a in allowed.dropFirst() {
                let d = labDistance(lab, a.lab)
                if d < nearest.d { nearest = (c: a.c, d: d) }
            }
            if nearest.d <= tolerance { continue }
            out.append(StyleFindingDraft(
                severity: "error",
                message: "\(item.label) uses \(item.color), which is not a house colour; the nearest is \(nearest.c). Change it to \(nearest.c) or another palette colour.",
                target: item.target
            ))
        }
        return out
    case "min-contrast":
        let ratio = options["ratio"]?.numberValue ?? 4.5
        // The inks a fix can switch to: the brand's text and background colours, else near-black and white.
        let dark = brandColor(brand, "text") ?? "#111111"
        let light = brandColor(brand, "background") ?? "#ffffff"
        let largeRatio = options["largeRatio"]?.numberValue ?? 3
        var out: [StyleFindingDraft] = []
        for item in surface.colors {
            guard item.use == "text", let background = item.background, !background.isEmpty else { continue }
            guard let fg = parseCssColor(item.color), let bg = parseCssColor(background) else { continue }
            let size = item.fontSize ?? 0
            let large = size >= 24 || (item.bold && size >= 18.66)
            let needed = large ? largeRatio : ratio
            let got = cssContrastRatio(fg, bg)
            if got + 1e-9 >= needed { continue }
            // A certain fix: the ink that reads on this background, when it passes.
            let side = cssInkSide(background, dark: dark, light: light)
            let suggested = side == "dark" ? dark : side == "light" ? light : nil
            var suggestion: (color: String, ratio: Double)?
            if let suggested, let sFg = parseCssColor(suggested) {
                let r = cssContrastRatio(sFg, bg)
                if r + 1e-9 >= needed { suggestion = (suggested, JS.round(r * 100) / 100) }
            }
            let fix = suggestion.map { "Use \($0.color) (contrast \(jsToFixed($0.ratio, 2))), or another house colour that passes." } ?? "Use a darker or lighter house colour."
            out.append(StyleFindingDraft(
                severity: "error",
                message: "\(item.label): \(item.color) on \(background) has a contrast ratio of \(jsToFixed(got, 2)); it needs \(JSONValue.jsString(needed)). \(fix)",
                target: item.target,
                suggestion: suggestion.map { .object(JSONObject([("color", .string($0.color)), ("ratio", .number($0.ratio))])) }
            ))
        }
        return out
    case "distinguishable":
        let min = options["minDistance"]?.numberValue ?? 10
        let series = surface.colors.filter { $0.use == "series" }.map { (item: $0, lab: toLab($0.color)) }
        var out: [StyleFindingDraft] = []
        for i in series.indices {
            for j in series.indices where j > i {
                let a = series[i], b = series[j]
                guard let la = a.lab, let lb = b.lab else { continue }
                let d = labDistance(la, lb)
                if d >= min { continue }
                out.append(StyleFindingDraft(
                    severity: "warning",
                    message: "\(a.item.label) (\(a.item.color)) and \(b.item.label) (\(b.item.color)) are hard to tell apart (distance \(jsToFixed(d, 1)), needs \(JSONValue.jsString(min))). Give \(b.item.label) another palette colour.",
                    target: b.item.target
                ))
            }
        }
        return out
    case "fonts-allowed":
        let allowed = styleStrings(options["fonts"]) ?? styleStrings(profile["fonts"]) ?? brandFonts(brand)
        if allowed.isEmpty { throw StyleCheckError("neither the check, the profile nor the brand names any fonts.") }
        let names = Set(allowed.map(styleFirstFamily))
        var out: [StyleFindingDraft] = []
        for font in surface.fonts {
            let first = styleFirstFamily(font.family)
            if first.isEmpty || names.contains(first) || GENERIC_FAMILIES.contains(first) { continue }
            out.append(StyleFindingDraft(
                severity: "error",
                message: "\(font.label) uses the font \"\(font.family)\"; the house fonts are \(allowed.map { "\"\($0)\"" }.joined(separator: ", ")). Change it to one of those.",
                target: font.target
            ))
        }
        return out
    default:
        return []
    }
}

/// What `runStyleChecks` returns: findings (as JSON, in the TS shape), the checks that ran and
/// those skipped with the reason.
public struct StyleCheckRun: Sendable {
    public var findings: [JSONValue] = []
    public var ran: [String] = []
    public var skipped: [JSONValue] = []

    public init() {}

    /// A check tool's result: `{ findings, ran, skipped, ok, note?, issues? }`.
    public func result(note: String?, issues: [JSONValue]) -> JSONValue {
        var obj = JSONObject([
            ("findings", .array(findings)),
            ("ran", .array(ran.map { .string($0) })),
            ("skipped", .array(skipped)),
            ("ok", .bool(findings.isEmpty)),
        ])
        if let note { obj["note"] = .string(note) }
        if !issues.isEmpty { obj["issues"] = .array(issues) }
        return .object(obj)
    }
}

/// `runStyleChecks`: the profile's checks, then the brand's checks the profile does not list. A
/// check that is unknown or cannot run is skipped with the reason. `surface` is `nil` for a domain
/// without one (the shared checks are then not available).
public func runStyleChecks(
    domain: String,
    checks own: [StyleCheckDefinition],
    surface: (() -> StyleSurface)?,
    style: HouseStyle
) -> StyleCheckRun {
    var report = StyleCheckRun()
    func idOf(_ entry: JSONValue) -> String? {
        switch entry {
        case .string(let s): return s
        case .object(let o): return o["id"]?.stringValue
        default: return nil
        }
    }
    let ownList = style.profile["checks"]?.arrayValue ?? []
    let ownIds = ownList.map(idOf)
    let fromBrand = (style.brand?["checks"]?.arrayValue ?? []).filter { e in !ownIds.contains(where: { $0 == idOf(e) }) }
    let list = ownList.map { (entry: $0, layer: style.layer, brand: false) } + fromBrand.map { (entry: $0, layer: style.brandLayer, brand: true) }
    let available = styleCheckOptionSchemas(own, surface: surface != nil).map(\.id)
    var drawn: StyleSurface?
    for (entry, layer, fromBrand) in list {
        guard let id = idOf(entry), !id.isEmpty else { continue }
        guard available.contains(id) else {
            let reason = fromBrand && surface == nil
                ? "The brand asks for \"\(id)\", but \(domain) cannot be checked against the brand yet."
                : "There is no \"\(id)\" check for \(domain); it has \(available.map { "\"\($0)\"" }.joined(separator: ", "))."
            report.skipped.append(.object(JSONObject([("check", .string(id)), ("reason", .string(reason))])))
            continue
        }
        var options = entry.objectValue ?? JSONObject()
        options["id"] = Optional<JSONValue>.none
        do {
            let drafts: [StyleFindingDraft]
            if let check = own.first(where: { $0.id == id }) {
                drafts = try check.run(style.profile, options, style.brand)
            } else {
                if drawn == nil { drawn = surface!() }
                drafts = try runSharedStyleCheck(id, drawn!, profile: style.profile, options: options, brand: style.brand)
            }
            for f in drafts {
                var obj = JSONObject([("severity", .string(f.severity)), ("message", .string(f.message))])
                if let t = f.target { obj["target"] = t }
                if let s = f.suggestion { obj["suggestion"] = s }
                obj["check"] = .string(id)
                if let layer { obj["layer"] = .string(layer) }
                report.findings.append(.object(obj))
            }
            report.ran.append(id)
        } catch let error as StyleCheckError {
            report.skipped.append(.object(JSONObject([("check", .string(id)), ("reason", .string("The check could not run: \(error.message)"))])))
        } catch {
            report.skipped.append(.object(JSONObject([("check", .string(id)), ("reason", .string("The check could not run: \(error)"))])))
        }
    }
    return report
}
