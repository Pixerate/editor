import Foundation
import PixerateCore
import PixerateRaster

// A port of `brushes/style.ts` (#791): the `brushes.json` house-style profile (the brushes and
// media allowed, a licence rule for image sources, and the colours brushes may suggest), its
// checks, and `check_brush_style`. Messages, targets and result keys are the TS core's.

/// What the brush house-style checks read (`BrushStyleState`).
public struct BrushStyleState {
    /// The brushes to check, with whether each is built in.
    public var brushes: [BrushLibraryEntry]
    /// The library's image sources (only those the brushes use are checked).
    public var sources: [BrushSource]

    public init(brushes: [BrushLibraryEntry], sources: [BrushSource]) {
        self.brushes = brushes
        self.sources = sources
    }
}

/// `BRUSH_MEDIA`.
public let BRUSH_MEDIA = ["paint", "ink", "dry", "spray"]

/// `brushStyleDomain.profileSchema` (descriptions left out: validation does not read them).
public let BRUSH_STYLE_PROFILE_SCHEMA: JSONValue = try! JSONValue.parse("""
{"type":"object","properties":{
"brushes":{"type":"array","items":{"type":"string","minLength":1},"minItems":1},
"media":{"type":"array","items":{"type":"string","enum":\(JSONValue.array(BRUSH_MEDIA.map { .string($0) }).stringified())},"minItems":1},
"requireSourceLicence":{"type":"boolean"},
"palette":{"type":"array","items":{"type":"string","minLength":1}}
},"additionalProperties":false}
""")

private func brushStyleLabel(_ b: Brush) -> String {
    "Brush \(b["id"]?.stringValue ?? "") (\"\(b["name"]?.stringValue ?? "")\")"
}

private func brushTarget(_ id: String, colour: JSONValue? = nil) -> JSONValue {
    var o = JSONObject([("brush", .string(id))])
    if let colour { o["colour"] = colour }
    return .object(o)
}

/// `brushColourHex(value, 'light')`: a solid colour or a light / dark pair as `#rrggbb`, else nil.
func brushStyleColourHex(_ value: JSONValue?) -> String? {
    guard let value else { return nil }
    switch value {
    case .string: break
    case .object(let o):
        guard case .string? = o["light"], case .string? = o["dark"] else { return nil }
    default: return nil
    }
    // `resolveColor` gives `#rrggbb` or `#rrggbbaa`; the layer colour parser keeps `#rrggbb`.
    guard let light = normalizeCssDualColor(value)?.light else { return nil }
    return String(light.prefix(7)).jsLowercased
}

/// The brush domain's own checks (`brushes`, `media`, `source-licences`), reading `state`.
public func brushStyleChecks(_ state: BrushStyleState) -> [StyleCheckDefinition] {
    [
        StyleCheckDefinition(id: "brushes") { profile, _, _ in
            let allowed = (profile["brushes"]?.arrayValue ?? []).compactMap(\.stringValue)
            if allowed.isEmpty { throw StyleCheckError("the profile has no \"brushes\".") }
            return state.brushes.filter { !allowed.contains($0.brush["id"]?.stringValue ?? "") }.map { e in
                StyleFindingDraft(
                    severity: "warning",
                    message: "\(brushStyleLabel(e.brush)) is not a house brush; the house brushes are \(allowed.joined(separator: ", ")).",
                    target: brushTarget(e.brush["id"]?.stringValue ?? "")
                )
            }
        },
        StyleCheckDefinition(id: "media") { profile, _, _ in
            let allowed = (profile["media"]?.arrayValue ?? []).compactMap(\.stringValue)
            if allowed.isEmpty { throw StyleCheckError("the profile has no \"media\".") }
            return state.brushes.compactMap { e in
                guard e.brush["kind"]?.stringValue == "mark", let medium = e.brush["medium"]?.stringValue, !allowed.contains(medium) else { return nil }
                return StyleFindingDraft(
                    severity: "warning",
                    message: "\(brushStyleLabel(e.brush)) lays \(medium); the house media are \(allowed.joined(separator: ", ")).",
                    target: brushTarget(e.brush["id"]?.stringValue ?? "")
                )
            }
        },
        StyleCheckDefinition(id: "source-licences") { profile, _, _ in
            if profile["requireSourceLicence"] != .bool(true) { throw StyleCheckError("the profile does not set \"requireSourceLicence\": true.") }
            var used: [String: [String]] = [:]
            for e in state.brushes {
                let id = e.brush["id"]?.stringValue ?? ""
                for source in brushSourceIds(e.brush) { used[source, default: []].append(id) }
            }
            var out: [StyleFindingDraft] = []
            for s in state.sources {
                guard let by = used[s.id] else { continue }
                if let licence = s.licence, !licence.jsTrimmed.isEmpty { continue }
                let from = s.origin.map { $0.isEmpty ? "" : ", from \($0)" } ?? ""
                out.append(StyleFindingDraft(
                    severity: "warning",
                    message: "Image source \(s.id) (\"\(s.name)\"\(from)) used by \(by.joined(separator: ", ")) records no licence. Re-add it with add_brush_source and its licence, or replace it.",
                    target: .object(JSONObject([("source", .string(s.id))]))
                ))
            }
            return out
        },
    ]
}

/// `brushStyleSurface`: the colours brushes suggest (their default and palette), for the shared checks.
public func brushStyleSurface(_ state: BrushStyleState) -> StyleSurface {
    var colors: [StyleSurfaceColor] = []
    for e in state.brushes {
        let id = e.brush["id"]?.stringValue ?? ""
        let colour = e.brush["colour"]?.objectValue
        if let def = brushStyleColourHex(colour?["default"]) {
            colors.append(StyleSurfaceColor(color: def, label: "\(brushStyleLabel(e.brush)) default colour", target: brushTarget(id, colour: .string("default")), use: "fill"))
        }
        for (i, c) in (colour?["palette"]?.arrayValue ?? []).enumerated() {
            guard let hex = brushStyleColourHex(c) else { continue }
            colors.append(StyleSurfaceColor(color: hex, label: "\(brushStyleLabel(e.brush)) palette colour \(i + 1)", target: brushTarget(id, colour: .number(Double(i))), use: "fill"))
        }
    }
    return StyleSurface(colors: colors)
}

/// `brushStyleDomain.themeFromBrand` (also the paint domain's): the brand's palette, when it has one.
public func paletteFromBrand(_ brand: JSONObject) -> JSONObject {
    let palette = brandPalette(brand)
    return palette.isEmpty ? JSONObject() : JSONObject([("palette", .array(palette.map { .string($0) }))])
}

/// The option schemas a `brushes.json` checks list is validated against.
public let BRUSH_STYLE_CHECK_OPTIONS = styleCheckOptionSchemas(brushStyleChecks(BrushStyleState(brushes: [], sources: [])), surface: true)

/// `brushStyleState`: the user's saved brushes, or `ids` (built-ins included); an unknown id is
/// refused with the closest ids.
public func brushStyleState(_ library: BrushLibrary, ids: [String]?) throws -> BrushStyleState {
    var entries: [BrushLibraryEntry]
    if let ids {
        entries = []
        var missing: [String] = []
        for id in ids {
            if let e = library.get(id) { entries.append(e) } else { missing.append(id) }
        }
        if !missing.isEmpty {
            let known = library.list().compactMap { $0.brush["id"]?.stringValue }
            let closest = missing.map { closestIds($0, known) }.filter { !$0.isEmpty }.joined(separator: " ")
            let text = "No brush \(missing.map { "\"\($0)\"" }.joined(separator: ", ")). \(closest) list_brush_presets lists them."
            throw PaintEditorError(text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).jsTrimmed)
        }
    } else {
        entries = library.list(BrushFilter(source: "user"))
    }
    return BrushStyleState(brushes: entries, sources: library.listSources())
}

/// `runStyleChecks` for the brush domain.
public func runBrushStyleChecks(_ state: BrushStyleState, style: HouseStyle) -> StyleCheckRun {
    runStyleChecks(domain: "brushes", checks: brushStyleChecks(state), surface: { brushStyleSurface(state) }, style: style)
}

/// A tool of a paint contract provider, with `handler`.
func paintStyleContractTool(_ provider: String, _ name: String, _ handler: @escaping (JSONObject) async throws -> JSONValue) throws -> AgentTool {
    guard let def = try PaintContracts.toolProviders().first(where: { $0.id == provider })?.tools.first(where: { $0.name == name }) else {
        throw ContractError("tools.json has no tool \(name) in provider \(provider).")
    }
    return AgentTool(name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations) { args, _ in
        .value(try await handler(args))
    }
}

/// `createBrushStyleToolProvider`: `check_brush_style` checks the user's saved brushes, or brushes
/// by id, against the house style. Read-only.
public func createBrushStyleToolProvider(_ library: BrushLibrary, _ style: HouseStyle, id: String = "brush-style", namespace: String? = nil) throws -> AgentToolProvider {
    let check = try paintStyleContractTool("brush-style", "check_brush_style") { args in
        let ids = args["ids"]?.arrayValue?.compactMap(\.stringValue)
        let state = try brushStyleState(library, ids: ids)
        let run = runBrushStyleChecks(state, style: style)
        guard case .object(var out) = run.result(note: style.hasSkills ? nil : "No house style applies to brushes.", issues: style.issues) else { return .null }
        out["checked"] = .array(state.brushes.map { .string($0.brush["id"]?.stringValue ?? "") })
        return .object(out)
    }
    return AgentToolProvider(id: id, namespace: namespace, title: "Brush house style", description: "Check brushes against the house style.", skill: "pixerate-brushes", tools: [check])
}
