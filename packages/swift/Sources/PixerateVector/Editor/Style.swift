import Foundation
import PixerateCore
import PixerateRaster

// House style for vector drawings (#791), a port of `vector/style.ts`: the `vector.json` profile
// (the stroke widths and corner radii allowed, and the colours and fonts art may use), its own
// checks (`stroke-widths`, `corner-radii`), the style surface the shared checks run on (solid
// fills, strokes, text and the artboard, with fonts), `themeFromBrand`, and `check_vector_style` /
// `fix_vector_style`. Messages, targets and result keys are the TS core's, word for word.
//
// Findings target a node by id with the property and, when the fix is certain, the house value:
// `{ node, property: "strokeWidth", value }`, `{ node, property: "corner", subpath, anchor, value }`,
// `{ node, property: "fill" | "stroke" | "fontFamily" }`, or `{ background: true }`.

private func vectorStyleSchema(_ json: String) -> JSONValue { try! JSONValue.parse(json) }

/// `vectorStyleDomain.profileSchema` (descriptions left out: validation does not read them).
public let VECTOR_STYLE_PROFILE_SCHEMA: JSONValue = vectorStyleSchema("""
{"type":"object","properties":{
"strokeWidths":{"type":"array","items":{"type":"number","exclusiveMinimum":0},"minItems":1},
"cornerRadii":{"type":"array","items":{"type":"number","exclusiveMinimum":0},"minItems":1},
"palette":{"type":"array","items":{"type":"string","minLength":1}},
"fonts":{"type":"array","items":{"type":"string","minLength":1}}
},"additionalProperties":false}
""")

/// `solid`: a CSS colour paint, else nil (none, transparent, a gradient or nothing).
private func solidPaint(_ paint: JSONValue?) -> String? {
    guard case .string(let s)? = paint, !s.isEmpty, s != "none", s != "transparent" else { return nil }
    return s
}

/// `hasStroke`: any paint but `undefined`, `null`, `none` and `transparent`.
private func hasStrokePaint(_ paint: JSONValue?) -> Bool {
    switch paint {
    case nil, .null?, .string("none")?, .string("transparent")?: return false
    default: return true
    }
}

/// `labelOf`: `Text n3 ("Title")` or `Node n1`.
private func vectorStyleLabel(_ n: VectorNode) -> String {
    let kind = n.isText ? "Text" : "Node"
    if let name = n.name, !name.isEmpty { return "\(kind) \(n.id) (\"\(name)\")" }
    return "\(kind) \(n.id)"
}

/// `painted`: paths and text carry fill and stroke.
private func paintedNode(_ n: VectorNode) -> Bool { n.isPath || n.isText }

/// `nearest`: the allowed value closest to `value`, the first on a tie.
private func nearestAllowed(_ value: Double, _ allowed: [Double]) -> Double {
    allowed.reduce(allowed[0]) { best, a in abs(a - value) < abs(best - value) ? a : best }
}

private func joined(_ values: [Double]) -> String { values.map(JSONValue.jsString).joined(separator: ", ") }

private func numbers(_ value: JSONValue?) -> [Double] { value?.arrayValue?.compactMap(\.numberValue) ?? [] }

/// The vector domain's own checks on `document` (`stroke-widths`, `corner-radii`).
func vectorStyleChecks(_ document: VectorDocument) -> [StyleCheckDefinition] {
    let strokeWidths = StyleCheckDefinition(id: "stroke-widths") { profile, _, _ in
        let allowed = numbers(profile["strokeWidths"])
        if allowed.isEmpty { throw StyleCheckError("the profile has no \"strokeWidths\".") }
        var out: [StyleFindingDraft] = []
        walkVectorNodes(document.nodes) { n, _, _ in
            guard paintedNode(n), hasStrokePaint(n.stroke) else { return }
            let width = n.strokeWidth ?? 1
            if allowed.contains(width) { return }
            let want = nearestAllowed(width, allowed)
            out.append(StyleFindingDraft(
                severity: "warning",
                message: "\(vectorStyleLabel(n)) has a \(JSONValue.jsString(width)) stroke; the house widths are \(joined(allowed)). Use \(JSONValue.jsString(want)).",
                target: .object(JSONObject([("node", .string(n.id)), ("property", "strokeWidth"), ("value", .number(want))]))
            ))
        }
        return out
    }
    let cornerRadii = StyleCheckDefinition(id: "corner-radii") { profile, _, _ in
        let allowed = numbers(profile["cornerRadii"])
        if allowed.isEmpty { throw StyleCheckError("the profile has no \"cornerRadii\".") }
        var out: [StyleFindingDraft] = []
        walkVectorNodes(document.nodes) { n, _, _ in
            guard n.isPath else { return }
            for (s, sp) in n.subpaths.enumerated() {
                for (i, a) in sp.anchors.enumerated() {
                    let r = a.corner?.radius ?? 0
                    guard r > 0, !allowed.contains(r) else { continue }
                    let want = nearestAllowed(r, allowed)
                    out.append(StyleFindingDraft(
                        severity: "warning",
                        message: "\(vectorStyleLabel(n)) has a corner of radius \(JSONValue.jsString(r)) (subpath \(s), anchor \(i)); the house radii are \(joined(allowed)). Use \(JSONValue.jsString(want)).",
                        target: .object(JSONObject([("node", .string(n.id)), ("property", "corner"), ("subpath", .number(Double(s))), ("anchor", .number(Double(i))), ("value", .number(want))]))
                    ))
                }
            }
        }
        return out
    }
    return [strokeWidths, cornerRadii]
}

/// `vectorStyleSurface`: the solid colours and fonts the drawing uses, for the shared checks.
public func vectorStyleSurface(_ document: VectorDocument) -> StyleSurface {
    var colors: [StyleSurfaceColor] = []
    var fonts: [StyleSurfaceFont] = []
    let background = solidPaint(document["background"])
    if let background {
        colors.append(StyleSurfaceColor(color: background, label: "The artboard", target: .object(JSONObject([("background", .bool(true))])), use: "background"))
    }
    func target(_ n: VectorNode, _ property: String) -> JSONValue { .object(JSONObject([("node", .string(n.id)), ("property", .string(property))])) }
    walkVectorNodes(document.nodes) { n, _, _ in
        guard paintedNode(n), n.isVisible else { return }
        let fill = solidPaint(n.fill)
        let stroke = solidPaint(n.stroke)
        if n.isText {
            let font = n["font"]?.objectValue ?? JSONObject()
            if let fill {
                colors.append(StyleSurfaceColor(
                    color: fill,
                    label: vectorStyleLabel(n),
                    target: target(n, "fill"),
                    use: "text",
                    background: background,
                    fontSize: font["fontSize"]?.numberValue,
                    bold: (font["fontWeight"]?.numberValue ?? 0) >= 600
                ))
            }
            fonts.append(StyleSurfaceFont(family: font["fontFamily"]?.stringValue ?? "", label: vectorStyleLabel(n), target: target(n, "fontFamily")))
        } else if let fill {
            colors.append(StyleSurfaceColor(color: fill, label: vectorStyleLabel(n), target: target(n, "fill"), use: "fill"))
        }
        if let stroke {
            colors.append(StyleSurfaceColor(color: stroke, label: "\(vectorStyleLabel(n)) stroke", target: target(n, "stroke"), use: "stroke"))
        }
    }
    return StyleSurface(colors: colors, fonts: fonts)
}

/// `vectorStyleDomain.themeFromBrand`: the brand's palette and fonts.
public func vectorStyleFromBrand(_ brand: JSONObject) -> JSONObject {
    let palette = brandPalette(brand)
    let fonts = brandFonts(brand)
    var out = JSONObject()
    if !palette.isEmpty { out["palette"] = .array(palette.map { .string($0) }) }
    if !fonts.isEmpty { out["fonts"] = .array(fonts.map { .string($0) }) }
    return out
}

/// The option schemas a `vector.json` `checks` list is validated against (`styleChecksOf`).
public let VECTOR_STYLE_CHECK_OPTIONS: [(id: String, schema: JSONValue)] = styleCheckOptionSchemas(vectorStyleChecks(VectorDocument(width: 1, height: 1)), surface: true)

/**
 * The vector house style for one `layer` holding one `skill` with an optional `vector.json`
 * (`profileJson`) and an optional `brand.json` (`brandJson`), as `createStyleResolver` resolves
 * it with `vectorStyleDomain`.
 */
public func vectorHouseStyle(skill: String = "house", layer: String = "org", profileJson: JSONValue?, brandJson: JSONValue?) -> HouseStyle {
    HouseStyle(
        domain: "vector",
        skill: skill,
        layer: layer,
        profileJson: profileJson,
        brandJson: brandJson,
        schema: VECTOR_STYLE_PROFILE_SCHEMA,
        checks: VECTOR_STYLE_CHECK_OPTIONS,
        themeFromBrand: vectorStyleFromBrand
    )
}

/// Runs the checks `style` turns on against `document` (`styles.check('vector', state)`).
public func checkVectorStyle(_ document: VectorDocument, _ style: HouseStyle) -> StyleCheckRun {
    runStyleChecks(domain: "vector", checks: vectorStyleChecks(document), surface: { vectorStyleSurface(document) }, style: style)
}

/// One live corner `fix_vector_style` sets.
private struct VectorCornerFix {
    var subpath: Int
    var anchor: Int
    var value: Double
}

/// `withFixes`: the nodes with the certain fixes applied (stroke widths and corner radii by node id).
private func withVectorStyleFixes(_ nodes: [VectorNode], _ widths: [(String, Double)], _ corners: [(String, [VectorCornerFix])]) -> [VectorNode] {
    nodes.map { n in
        var next = n
        if paintedNode(n), let w = widths.first(where: { $0.0 == n.id }) { next.strokeWidth = w.1 }
        if next.isPath, let fix = corners.first(where: { $0.0 == n.id })?.1 {
            next.subpaths = next.subpaths.enumerated().map { s, sp in
                var sub = sp
                sub.anchors = sp.anchors.enumerated().map { i, a in
                    guard let f = fix.first(where: { $0.subpath == s && $0.anchor == i }), var corner = a.corner else { return a }
                    var anchor = a
                    corner.radius = f.value
                    anchor.corner = corner
                    return anchor
                }
                return sub
            }
        }
        if next.isGroup { next.children = withVectorStyleFixes(next.children, widths, corners) }
        return next
    }
}

extension VectorEditorController {
    /// Replaces the document as one undo step named `label` (`setDocument`): the selection, anchor
    /// selection, editing and pen state are cleared.
    func setDocument(_ document: VectorDocument, label: String = "Replace Document") throws {
        let next = try loadedDocument(document)
        change(label) {
            doc = next
            selection = []
            anchors = []
            editingId = nil
            pen = nil
        }
    }
}

/// Options for `createVectorStyleToolProvider`.
public struct VectorStyleToolProviderOptions {
    /// Why the drawing cannot be changed now (`fix_vector_style` is hidden), or nil.
    public var readOnly: (() -> String?)?
    public init(readOnly: (() -> String?)? = nil) {
        self.readOnly = readOnly
    }
}

/**
 * `check_vector_style` and, while the drawing is editable, `fix_vector_style` (snaps stroke widths
 * and corner radii to the house values as one undo step and keeps the selection), as
 * `createVectorStyleToolProvider` in `vector/style.ts`. Definitions come from the vector contracts
 * (`tools.json`, provider `vector-style`).
 */
public func createVectorStyleToolProvider(_ controller: VectorEditorController, _ style: HouseStyle, _ options: VectorStyleToolProviderOptions = VectorStyleToolProviderOptions()) throws -> AgentToolProvider {
    let run = { checkVectorStyle(controller.document, style) }
    return try vectorContractProvider("vector-style", description: "Check a vector drawing against the house style and snap stroke widths and corner radii to the house values.", [
        "check_vector_style": { _ in
            .value(run().result(note: style.hasSkills ? nil : "No house style applies to vector drawings.", issues: style.issues))
        },
        "fix_vector_style": { _ in
            if let reason = options.readOnly?() { throw VectorEditorError(reason) }
            let findings = run().findings
            var widths: [(String, Double)] = []
            var corners: [(String, [VectorCornerFix])] = []
            var left: [JSONValue] = []
            for f in findings {
                let t = f.objectValue?["target"]?.objectValue
                let node = t?["node"]?.stringValue
                let value = t?["value"]?.numberValue
                if let t, let node, let value, t["property"]?.stringValue == "strokeWidth" {
                    if let i = widths.firstIndex(where: { $0.0 == node }) { widths[i].1 = value } else { widths.append((node, value)) }
                } else if let t, let node, let value, t["property"]?.stringValue == "corner" {
                    let fix = VectorCornerFix(subpath: Int(t["subpath"]?.numberValue ?? 0), anchor: Int(t["anchor"]?.numberValue ?? 0), value: value)
                    if let i = corners.firstIndex(where: { $0.0 == node }) { corners[i].1.append(fix) } else { corners.append((node, [fix])) }
                } else {
                    left.append(f)
                }
            }
            if !widths.isEmpty || !corners.isEmpty {
                let selection = controller.selectedIds
                var document = controller.document
                document.nodes = withVectorStyleFixes(document.nodes, widths, corners)
                try controller.setDocument(document, label: "Apply House Style")
                if !selection.isEmpty { controller.select(selection) }
            }
            var strokeWidths = JSONObject()
            for (node, value) in widths { strokeWidths[node] = .number(value) }
            let cornerList: [JSONValue] = corners.flatMap { node, list in
                list.map { c in .object(JSONObject([("node", .string(node)), ("subpath", .number(Double(c.subpath))), ("anchor", .number(Double(c.anchor))), ("value", .number(c.value))])) }
            }
            return .value(.object(JSONObject([("strokeWidths", .object(strokeWidths)), ("corners", .array(cornerList)), ("left", .array(left))])))
        },
    ], readOnly: options.readOnly)
}
