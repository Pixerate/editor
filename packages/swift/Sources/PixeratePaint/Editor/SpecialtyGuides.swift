import PixerateCore
import PixerateRaster

// Guides for specialty paint (`paint-editor/specialty-guides.ts`): for each specialty the active
// brush has, how to paint with it (`ui.json` `specialties`), whether the canvas is set up for it now
// and the quick actions that set it up, each naming the agent tool that does the same.

/// The specialty kinds, as `ui.json` `specialties` describes them (`BRUSH_SPECIALTIES`).
public let BRUSH_SPECIALTIES: [PaintUISpecialtiesItem] = (try? PaintContracts.uiTables().specialties) ?? []

/// One click that sets the canvas up for a specialty: a button label and the agent tool call that does it.
public struct BrushSpecialtyAction: Equatable, Sendable {
    public var id: String
    public var label: String
    public var tool: String
    public var arguments: JSONObject
    public var json: JSONValue { ["id": .string(id), "label": .string(label), "tool": .string(tool), "arguments": .object(arguments)] }
}

/// How to use one specialty of the active brush, and whether the canvas is ready for it.
public struct BrushSpecialtyGuide: Equatable, Sendable {
    public var kind: String
    public var title: String
    public var howToUse: String
    public var status: String
    public var ready: Bool
    public var actions: [BrushSpecialtyAction]
    public var json: JSONValue {
        ["kind": .string(kind), "title": .string(title), "howToUse": .string(howToUse), "status": .string(status), "ready": .bool(ready), "actions": .array(actions.map(\.json))]
    }
}

/// The specialty kinds an engine brush lays, in `BRUSH_SPECIALTIES` order (a wet mutation brush is mutation paint, not ghost paint).
public func paintBrushSpecialties(_ b: PaintBrush) -> [String] {
    var out: [String] = []
    if b.ferro.amount > 0 { out.append("ferro") }
    if b.fluorescence.amount > 0 { out.append("fluorescence") }
    if b.thermochromic.hotColor != nil { out.append("thermochromic") }
    if b.iridescence != nil { out.append("iridescence") }
    if b.ghost != nil && b.mutation == nil { out.append("ghost") }
    if b.mutation != nil { out.append("mutation") }
    if b.livePatterns != nil { out.append("livePatterns") }
    return out
}

/// The specialty kinds a facet brush has, in `BRUSH_SPECIALTIES` order (`brushSpecialties`; empty for tools).
public func brushSpecialties(_ brush: Brush) -> [String] {
    if brush["kind"]?.stringValue == "tool" { return [] }
    var out: [String] = []
    if (brush.path("ferro.amount")?.numberValue ?? 0) > 0 { out.append("ferro") }
    if (brush.path("fluorescence.amount")?.numberValue ?? 0) > 0 { out.append("fluorescence") }
    if brush["thermochromic"] != nil { out.append("thermochromic") }
    if brush["iridescence"] != nil { out.append("iridescence") }
    if brush["ghost"] != nil { out.append("ghost") }
    if brush["mutation"] != nil { out.append("mutation") }
    if brush["livePatterns"] != nil { out.append("livePatterns") }
    return out
}

private let PATTERN_WORDS: [String: String] = ["spots": "spot", "stripes": "stripe", "coral": "coral", "maze": "maze", "worms": "worm"]
private func percent(_ v: Double) -> String { jsText(JS.round(v * 100)) }
private func point(_ x: Double, _ y: Double) -> JSONValue { ["x": .number(x), "y": .number(y)] }

extension PaintEditorController {
    /// One guide per specialty the active brush has (empty for standard brushes and tools); `hasMutationAgent` overrides the editor's.
    public func brushSpecialtyGuides(hasMutationAgent: Bool? = nil) -> [BrushSpecialtyGuide] {
        let b = brush
        let w = Double(doc.canvas.width), h = Double(doc.canvas.height)
        let cx = JS.round(w / 2), cy = JS.round(h / 2)
        func guide(_ kind: String, _ status: String, _ ready: Bool, _ actions: [BrushSpecialtyAction] = []) -> BrushSpecialtyGuide {
            let info = BRUSH_SPECIALTIES.first { $0.id == kind }
            return BrushSpecialtyGuide(kind: kind, title: info?.label ?? kind, howToUse: info?.howToUse ?? "", status: status, ready: ready, actions: actions)
        }
        return paintBrushSpecialties(b).map { kind in
            switch kind {
            case "ferro":
                let n = doc.magnets?.count ?? 0
                let liquid = doc.ferro?.values.contains { !$0.tiles.isEmpty } ?? false
                var actions = [BrushSpecialtyAction(id: "add-magnet", label: "Add magnet", tool: "add_magnet", arguments: ["x": .number(Swift.min(w - 1, cx + 24 * Double(n))), "y": .number(cy)])]
                if n > 0 && liquid { actions.append(BrushSpecialtyAction(id: "cure-ferrofluid", label: "Cure spikes", tool: "cure_ferrofluid", arguments: [:])) }
                let status = n == 0 ? "No magnets placed — add a magnet to pull liquid ferrofluid into 3D spikes" : "\(n) magnet\(n == 1 ? "" : "s") active\(liquid ? " — cure the spikes to keep them as relief" : "")"
                return guide(kind, status, n > 0, actions)
            case "fluorescence":
                if uvLight.on {
                    return guide(kind, "UV blacklight is on (\(percent(uvLight.strength))%)", true, [BrushSpecialtyAction(id: "uv-off", label: "Turn off UV blacklight", tool: "set_uv_light", arguments: ["on": false])])
                }
                let status = b.fluorescence.invisible ? "UV blacklight is off (strokes are invisible until UV is on)" : "UV blacklight is off (strokes glow only under UV)"
                return guide(kind, status, false, [BrushSpecialtyAction(id: "uv-on", label: "Turn on UV blacklight", tool: "set_uv_light", arguments: ["on": true])])
            case "thermochromic":
                let hot = b.thermochromic.hotColor ?? ""
                let threshold = b.thermochromic.threshold
                let max = heatStats(doc.heat).max
                let heat = warmCanvasHeat(width: doc.canvas.width, height: doc.canvas.height)
                var actions = [BrushSpecialtyAction(id: "warm-canvas", label: "Warm canvas", tool: "paint_heat", arguments: ["points": .array(heat.points.map { point($0.x, $0.y) }), "radius": .number(heat.radius), "temperature": .number(heat.temperature)])]
                if max > 0 {
                    actions.append(BrushSpecialtyAction(id: "step-heat", label: "Step heat", tool: "advance_heat", arguments: ["steps": 10]))
                    actions.append(BrushSpecialtyAction(id: "cool-canvas", label: "Cool canvas", tool: "clear_heat", arguments: [:]))
                }
                let status = max <= 0
                    ? "Canvas is cool — warm the canvas or paint heat to shift toward \(hot)"
                    : max < threshold ? "Canvas is warm (max \(percent(max))%), below the ink's \(percent(threshold))% threshold" : "Canvas is warm (max \(percent(max))%)"
                return guide(kind, status, max >= threshold, actions)
            case "iridescence":
                if viewTilt.x == 0 && viewTilt.y == 0 {
                    return guide(kind, "Tilt the view or move the light to shift interference colours", true, [BrushSpecialtyAction(id: "tilt-view", label: "Tilt view", tool: "set_view_tilt", arguments: ["x": 0.6, "y": -0.4])])
                }
                return guide(kind, "View is tilted — interference colours shift as the angle changes", true, [BrushSpecialtyAction(id: "reset-tilt", label: "Reset tilt", tool: "set_view_tilt", arguments: ["x": 0, "y": 0])])
            case "ghost":
                let ghost = b.ghost ?? DEFAULT_GHOST
                let status = ghost.trigger == "agent" ? "Smears existing paint on this layer, then its own pigment fades once an agent claims the stroke" : "Smears existing paint on this layer, then its own pigment fades away over \(jsText(ghost.linger))s"
                return guide(kind, status, true)
            case "mutation":
                let agent = hasMutationAgent ?? self.hasMutationAgent
                return agent
                    ? guide(kind, "Agent connected — pauses \(jsText((b.mutation ?? DEFAULT_MUTATION).settle))s after your stroke so the agent can answer", true)
                    : guide(kind, "No mutation agent connected — strokes will stay as ordinary paint", false)
            default:
                let pattern = b.livePatterns?.pattern ?? "spots"
                let word = PATTERN_WORDS[pattern] ?? pattern
                let wetHere = doc.activeLayerId.map { wet.wetLayerIds().contains($0) } ?? false
                let actions = wetHere ? [BrushSpecialtyAction(id: "seed-pattern", label: "Seed pattern", tool: "seed_live_patterns", arguments: ["points": [point(cx, cy)], "radius": 16, "pattern": .string(pattern)])] : []
                let status = wet.paused
                    ? "Wet time is paused — resume it so \(word) patterns can grow"
                    : wetHere ? "\(word.prefix(1).uppercased())\(word.dropFirst()) patterns grow in the wet paint on this layer and freeze as it dries" : "Paint a wet wash: \(word) patterns grow while it is wet and freeze as it dries"
                return guide(kind, status, !wet.paused, actions)
            }
        }
    }
}

/// The heat "Warm canvas" paints (`warmCanvasHeat`, `paint_heat` arguments): a hot disc at the centre reaching half the canvas's longer side.
public func warmCanvasHeat(width: Int, height: Int) -> (points: [Point2], radius: Double, temperature: Double) {
    let w = Double(width), h = Double(height)
    return ([Point2(x: JS.round(w / 2), y: JS.round(h / 2))], Swift.max(1, Swift.min(512, JS.round(Swift.max(w, h) / 2))), 1)
}

extension PaintEditorController {
    /// Whether specialty paint is in play (`specialtyInPlay`): a specialty brush, or the UV blacklight, heat, magnets or a view tilt.
    public var specialtyInPlay: Bool {
        !paintBrushSpecialties(brush).isEmpty || uvLight.on || heatStats(doc.heat).hotCells > 0 || !(doc.magnets ?? []).isEmpty || viewTilt.x != 0 || viewTilt.y != 0
    }

    /// Runs a guide's quick action on the editor, as its agent tool would (`runBrushSpecialtyAction`).
    public func runBrushSpecialtyAction(_ action: BrushSpecialtyAction) throws {
        let a = action.arguments
        let points = (a["points"]?.arrayValue ?? []).map { Point2(x: $0.objectValue?["x"]?.numberValue ?? .nan, y: $0.objectValue?["y"]?.numberValue ?? .nan) }
        switch action.tool {
        case "set_uv_light": _ = try setUvLight(on: a["on"]?.boolValue, strength: a["strength"]?.numberValue, ambient: a["ambient"]?.numberValue)
        case "paint_heat": _ = try paintHeat(points: points, radius: a["radius"]?.numberValue, temperature: a["temperature"]?.numberValue)
        case "advance_heat": _ = try advanceHeat(steps: a["steps"]?.numberValue.map { Int($0) })
        case "clear_heat": _ = try clearHeat()
        case "add_magnet": _ = try addMagnet(x: a["x"]?.numberValue ?? .nan, y: a["y"]?.numberValue ?? .nan)
        case "cure_ferrofluid": _ = try cureFerrofluid()
        case "set_view_tilt": _ = try setViewTilt(x: a["x"]?.numberValue, y: a["y"]?.numberValue)
        case "seed_live_patterns": _ = try seedLivePatterns(a)
        default: throw PaintEditorError("Unknown specialty action tool \"\(action.tool)\".")
        }
    }
}

/// The specialty guides tool (`thick-tools.ts` `get_specialty_guides`).
func paintSpecialtyHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["get_specialty_guides"] = { _ in
        let guides = c.brushSpecialtyGuides()
        return ["brushId": .string(c.brush.id), "specialties": .array(guides.map { .string($0.kind) }), "guides": .array(guides.map(\.json))]
    }
    return h
}
