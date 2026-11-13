import Foundation
import PixerateCore
import PixerateRaster

// A port of `paint-editor/style.ts` (#791): the `paint-editor.json` house-style profile (the
// papers and brushes allowed, a layer limit, and the colours paint may use), its checks, and
// `check_paint_style` / `fix_paint_style`. Findings target the paper (`{ paper: preset }`, the
// house paper to switch to), the current brush (`{ brush: id }`), a recorded stroke
// (`{ stroke: id }`), the current colour or a swatch. Messages are the TS core's, word for word.

/// `paintStyleDomain.profileSchema` (descriptions left out: validation does not read them).
public let PAINT_STYLE_PROFILE_SCHEMA: JSONValue = try! JSONValue.parse("""
{"type":"object","properties":{
"papers":{"type":"array","items":{"type":"string","enum":\(JSONValue.array(PAPER_LIBRARY.map { .string($0.preset) }).stringified())},"minItems":1},
"brushes":{"type":"array","items":{"type":"string","minLength":1},"minItems":1},
"maxLayers":{"type":"integer","minimum":1,"maximum":500},
"palette":{"type":"array","items":{"type":"string","minLength":1}}
},"additionalProperties":false}
""")

private func one(_ key: String, _ value: JSONValue) -> JSONValue { .object(JSONObject([(key, value)])) }

/// The paint domain's own checks (`paper`, `brushes`, `max-layers`), reading `controller`.
public func paintStyleChecks(_ controller: PaintEditorController) -> [StyleCheckDefinition] {
    [
        StyleCheckDefinition(id: "paper") { profile, _, _ in
            let papers = (profile["papers"]?.arrayValue ?? []).compactMap(\.stringValue)
            if papers.isEmpty { throw StyleCheckError("the profile has no \"papers\".") }
            let current = controller.doc.paper.preset
            if papers.contains(current) { return [] }
            return [StyleFindingDraft(
                severity: "warning",
                message: "The painting is on \"\(current)\" paper; the house papers are \(papers.map { "\"\($0)\"" }.joined(separator: ", ")). Switch to \"\(papers[0])\" with set_paper.",
                target: one("paper", .string(papers[0]))
            )]
        },
        StyleCheckDefinition(id: "brushes") { profile, _, _ in
            let allowed = (profile["brushes"]?.arrayValue ?? []).compactMap(\.stringValue)
            if allowed.isEmpty { throw StyleCheckError("the profile has no \"brushes\".") }
            var out: [StyleFindingDraft] = []
            if !allowed.contains(controller.brush.id) {
                out.append(StyleFindingDraft(
                    severity: "warning",
                    message: "The current brush is \"\(controller.brush.id)\"; the house brushes are \(allowed.joined(separator: ", ")). Pick \"\(allowed[0])\" before painting.",
                    target: one("brush", .string(allowed[0]))
                ))
            }
            let off = controller.doc.strokes.filter { !allowed.contains($0.brush.id) }
            for s in off.prefix(50) {
                out.append(StyleFindingDraft(severity: "info", message: "Stroke \(s.id) was painted with \"\(s.brush.id)\", not a house brush.", target: one("stroke", .string(s.id))))
            }
            if off.count > 50 {
                out.append(StyleFindingDraft(severity: "info", message: "\(off.count - 50) more strokes use brushes outside the house set.", target: one("painting", .bool(true))))
            }
            return out
        },
        StyleCheckDefinition(id: "max-layers") { profile, _, _ in
            guard let max = profile["maxLayers"]?.numberValue, max != 0, !max.isNaN else { throw StyleCheckError("the profile has no \"maxLayers\".") }
            let n = controller.doc.layers.count
            if Double(n) <= max { return [] }
            return [StyleFindingDraft(
                severity: "info",
                message: "The painting has \(n) layers; the house style keeps paintings to \(JSONValue.jsString(max)). Merge layers that belong together.",
                target: one("painting", .bool(true))
            )]
        },
    ]
}

/// `paintStyleSurface`: the colours paint uses (the current colour, swatches, strokes), for the shared checks.
public func paintStyleSurface(_ controller: PaintEditorController) -> StyleSurface {
    var colors: [StyleSurfaceColor] = []
    colors.append(StyleSurfaceColor(color: controller.color, label: "The current colour", target: one("color", .string("current")), use: "fill"))
    for (i, s) in controller.swatches.enumerated() {
        let name = s.name.map { $0.isEmpty ? "" : " (\"\($0)\")" } ?? ""
        colors.append(StyleSurfaceColor(color: s.color, label: "Swatch \(i + 1)\(name)", target: one("swatch", .number(Double(i))), use: "fill"))
    }
    // One finding per colour, at its first stroke.
    var seen = Set<String>()
    for s in controller.doc.strokes {
        if !seen.insert(s.color.jsLowercased).inserted { continue }
        colors.append(StyleSurfaceColor(color: s.color, label: "Stroke \(s.id)", target: one("stroke", .string(s.id)), use: "fill"))
    }
    return StyleSurface(colors: colors)
}

/// The option schemas a `paint-editor.json` checks list is validated against.
public let PAINT_STYLE_CHECK_OPTIONS: [(id: String, schema: JSONValue)] = ["paper", "brushes", "max-layers"].map { (id: $0, schema: try! JSONValue.parse(#"{"type":"object","properties":{},"additionalProperties":false}"#)) } + SHARED_STYLE_CHECK_OPTIONS

/// `runStyleChecks` for the paint domain.
public func runPaintStyleChecks(_ controller: PaintEditorController, style: HouseStyle) -> StyleCheckRun {
    runStyleChecks(domain: "paint-editor", checks: paintStyleChecks(controller), surface: { paintStyleSurface(controller) }, style: style)
}

/**
 * The house style of a paint host (#791): one `skill` in one `layer` holding any of
 * `paint-editor.json` (`style`), `brushes.json` (`brushStyle`) and `brand.json` (`brand`), resolved
 * for the paint and brush domains as `createStyleResolver({ domains: [paintStyleDomain,
 * brushStyleDomain] })` does. A skill's issues are its own, whichever domain is resolved, so each
 * domain lists every file left out, in the order the resolver reads them: files that are not a
 * JSON object or are a `$token` reference first, then the others, each in domain order
 * (paint-editor, brushes, brand); the profile derived from the brand follows.
 */
public struct PaintHouseStyles {
    public var paint: HouseStyle
    public var brushes: HouseStyle

    /// No house style.
    public init() {
        paint = HouseStyle()
        brushes = HouseStyle()
    }

    public init(skill: String, layer: String, style: JSONValue?, brushStyle: JSONValue?, brand: JSONValue?) {
        func resolve(_ domain: String, _ own: JSONValue?, _ schema: JSONValue, _ checks: [(id: String, schema: JSONValue)]) -> HouseStyle {
            HouseStyle(domain: domain, skill: skill, layer: layer, profileJson: own, brandJson: brand, schema: schema, checks: checks, themeFromBrand: paletteFromBrand)
        }
        paint = resolve("paint-editor", style, PAINT_STYLE_PROFILE_SCHEMA, PAINT_STYLE_CHECK_OPTIONS)
        brushes = resolve("brushes", brushStyle, BRUSH_STYLE_PROFILE_SCHEMA, BRUSH_STYLE_CHECK_OPTIONS)
        // The skill's issues, from every file it holds.
        var early: [JSONValue] = []
        var late: [JSONValue] = []
        func file(_ raw: JSONValue?, _ name: String, _ load: (JSONValue) -> String?) {
            guard let raw, let error = load(raw) else { return }
            let issue = JSONValue.object(JSONObject([("skill", .string(skill)), ("layer", .string(layer)), ("message", .string(error))]))
            if styleProfileFailsAtRoot(raw) { early.append(issue) } else { late.append(issue) }
        }
        file(style, "paint-editor.json") { loadStyleProfile($0, file: "paint-editor.json", schema: PAINT_STYLE_PROFILE_SCHEMA, checks: PAINT_STYLE_CHECK_OPTIONS).error }
        file(brushStyle, "brushes.json") { loadStyleProfile($0, file: "brushes.json", schema: BRUSH_STYLE_PROFILE_SCHEMA, checks: BRUSH_STYLE_CHECK_OPTIONS).error }
        file(brand, "brand.json") { loadBrandProfile($0).error }
        let skillIssues = early + late
        paint.issues = skillIssues + paint.issues.filter { $0.objectValue?["skill"] == nil }
        brushes.issues = skillIssues + brushes.issues.filter { $0.objectValue?["skill"] == nil }
    }
}

/// `createPaintStyleToolProvider`: `check_paint_style` and, while the painting is editable,
/// `fix_paint_style` (switches to the house paper and the house brush; strokes already painted stay
/// as they are). `readOnly` gives the reason the painting cannot be changed, or nil.
public func createPaintStyleToolProvider(_ controller: PaintEditorController, _ style: HouseStyle, id: String = "paint-style", namespace: String? = nil, readOnly: @escaping () -> String? = { nil }) throws -> AgentToolProvider {
    let check = try paintStyleContractTool("paint-style", "check_paint_style") { _ in
        runPaintStyleChecks(controller, style: style).result(note: style.hasSkills ? nil : "No house style applies to paintings.", issues: style.issues)
    }
    let fix = try paintStyleContractTool("paint-style", "fix_paint_style") { _ in
        if let reason = readOnly() { throw PaintEditorError(reason) }
        let findings = runPaintStyleChecks(controller, style: style).findings
        var changed = JSONObject()
        var left: [JSONValue] = []
        for f in findings {
            let t = f.objectValue?["target"]?.objectValue
            if let paper = t?["paper"], changed["paper"] == nil {
                _ = try controller.setPaper(JSONObject([("preset", paper)]))
                changed["paper"] = .string(controller.doc.paper.preset)
            } else if let brush = t?["brush"]?.stringValue, changed["brush"] == nil, controller.brushes.contains(where: { $0.id == brush }) {
                _ = try controller.setBrushFacets([:], id: brush)
                changed["brush"] = .string(brush)
            } else {
                left.append(f)
            }
        }
        return .object(JSONObject([("changed", .object(changed)), ("left", .array(left))]))
    }
    return AgentToolProvider(
        id: id,
        namespace: namespace,
        title: "Painting house style",
        description: "Check a painting against the house style and switch to the house paper and brush.",
        skill: "pixerate-paint-editor",
        tools: { readOnly() != nil ? [check] : [check, fix] }
    )
}
