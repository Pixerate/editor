import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The controller's text (`vector/controller.ts`): text defaults, adding point, area and path text,
// editing its characters, styles, paragraphs, frame and orientation, Type on a Path and Create
// Outlines; and the text panel's data (`vector/textPanel.ts`). Editing text on the canvas (the
// caret, typing and keys) belongs to the UI port (#625).

/// Text to add (`VectorTextInput`): point text at (`x`, `y`), area text with `width` and `height`,
/// or text on `path` (SVG path data, or a subpath as JSON `{ closed, anchors }`).
public struct VectorTextInput: Sendable {
    public var text: String
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
    public var path: JSONValue?
    /// Text on a path: `start`, `end`, `flip`, `orientation`, `baseline`.
    public var pathOptions: JSONObject
    public var font: JSONObject?
    public var paragraph: JSONObject?
    /// `horizontal` (default) or `vertical` (point and area text).
    public var orientation: JSONValue?
    public var name: String?
    /// Style fields (`VECTOR_STYLE_KEYS`) given, in the caller's order.
    public var style: JSONObject

    public init(text: String, x: Double? = nil, y: Double? = nil, width: Double? = nil, height: Double? = nil, path: JSONValue? = nil, pathOptions: JSONObject = JSONObject(), font: JSONObject? = nil,
                paragraph: JSONObject? = nil, orientation: JSONValue? = nil, name: String? = nil, style: JSONObject = JSONObject()) {
        self.text = text
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.path = path
        self.pathOptions = pathOptions
        self.font = font
        self.paragraph = paragraph
        self.orientation = orientation
        self.name = name
        self.style = style
    }
}

/// `toBezierPathLoose`: path data as Bézier commands, or none when it does not parse.
private func toBezierPathLoose(_ d: String) -> BezierPath { subpathsToBezier(bezierToSubpaths(.svg(d)), corners: false) }

extension VectorEditorController {
    // MARK: Shaper and defaults

    /// Sets the text shaper (shared by every vector editor, see `setVectorTextShaper`) and lays
    /// every text node out again with it. Not an undo step.
    public func setTextShaper(_ shaper: VectorTextShaper?) {
        setVectorTextShaper(shaper)
        notify()
    }

    /// The text shaper in use.
    public func getTextShaper() -> VectorTextShaper { getVectorTextShaper() }

    /// The font and alignment new text gets (`state.textDefaults`).
    public var textDefaultStyle: JSONObject { textDefaults }

    /// Changes the font and alignment new text gets (validated; throws on a bad value).
    public func setTextDefaults(_ patch: JSONObject) throws {
        var font = patch
        let align = patch["align"]
        remove(&font, "align")
        var next = try patchVectorCharacterStyle(textDefaults, font, "textDefaults")
        if let align {
            let p = try patchVectorParagraphStyle(JSONObject(), JSONObject([("align", align)]))
            if let a = p["align"] { next["align"] = a } else { remove(&next, "align") }
        }
        textDefaults = next
        notify()
    }

    // MARK: Adding text

    /// Builds a text node from `input` with the text defaults (not added). Throws a `VectorTextError` on bad input.
    public func createTextNode(_ input: VectorTextInput) throws -> VectorNode {
        var defaultFont = textDefaults
        let align = defaultFont["align"]
        remove(&defaultFont, "align")
        let font = try patchVectorCharacterStyle(defaultFont, input.font ?? JSONObject(), "font")
        let paragraph = try patchVectorParagraphStyle(align.map { JSONObject([("align", $0)]) } ?? JSONObject(), input.paragraph ?? JSONObject())
        var frame: JSONObject
        if let path = input.path {
            var sp: JSONValue = path
            if let d = path.stringValue { sp = pathTextFrameFromBezier(toBezierPathLoose(d)).map { .object($0) } ?? .null }
            var raw = JSONObject([("kind", "path"), ("path", sp)])
            for (k, v) in input.pathOptions { raw[k] = v }
            frame = try sanitizeVectorTextFrame(.object(raw))
        } else if input.width != nil || input.height != nil {
            var raw = JSONObject([("kind", "area"), ("x", .number(input.x ?? 0)), ("y", .number(input.y ?? 0))])
            raw["width"] = input.width.map { .number($0) }
            raw["height"] = input.height.map { .number($0) }
            frame = try sanitizeVectorTextFrame(.object(raw))
        } else {
            frame = try sanitizeVectorTextFrame(.object(JSONObject([("kind", "point"), ("x", .number(input.x ?? 0)), ("y", .number(input.y ?? 0))])))
        }
        var own = JSONObject()
        for key in VECTOR_STYLE_KEYS { if let v = input.style[key] { own[key] = v } }
        let text = normalizeLineBreaks(input.text)
        let vertical = try vectorTextOrientation(input.orientation)
        if vertical && frame["kind"] == "path" { throw VectorTextError("Text on a path cannot be vertical; leave orientation out, or set point or area text.") }
        var props = JSONObject([("id", .string(newId())), ("type", "text"), ("name", .string(input.name ?? vectorTextName(text)))])
        props["fill"] = "#000000"
        props["stroke"] = .null
        props["strokeWidth"] = .number(defaults["strokeWidth"]?.numberValue ?? 1)
        props["text"] = .string(text)
        props["font"] = .object(font)
        if !paragraph.isEmpty { props["paragraph"] = .object(paragraph) }
        props["frame"] = .object(frame)
        if vertical { props["orientation"] = "vertical" }
        return try withStyle(VectorNode(props: props), own)
    }

    /// Adds text (point, area or on a path, see `VectorTextInput`). Returns its id.
    @discardableResult
    public func addText(_ input: VectorTextInput, _ options: AddVectorNodeOptions = AddVectorNodeOptions()) throws -> String {
        let node = try createTextNode(input)
        var o = options
        if o.label == nil { o.label = "Add Text" }
        return try addNode(node, o)
    }

    // MARK: Editing text

    /// The text node `id`, or an error message (`textNode`).
    private func textNode(_ id: String) -> Result<VectorNode, VectorEditorError> {
        guard let node = getNode(id) else { return .failure(VectorEditorError("There is no node \"\(id)\".")) }
        if !node.isText { return .failure(VectorEditorError("\"\(id)\" is a \(node.typeName), not text; vector.list shows each node's type.")) }
        if truthy(node["blendStep"]) { return .failure(VectorEditorError("\"\(id)\" is a blend step; edit the blend's keys instead.")) }
        return .success(node)
    }

    /// Replaces text node `id` by `fn(node)` as one undo step (`editTextNode`).
    private func editTextNode(_ id: String, _ label: String, _ fn: (VectorNode) throws -> VectorNode) -> VectorActionResult {
        let node: VectorNode
        switch textNode(id) {
        case .failure(let e): return .failure(e.message)
        case .success(let n): node = n
        }
        let next: VectorNode
        do {
            next = try fn(node)
        } catch {
            return .failure("\(error)")
        }
        if next == node { return .success }
        let before = snapshot()
        try? replaceNode(id, next)
        commit(label, before)
        return .success
    }

    /// Replaces [start, end) of text node `id` (default: all of it) with `text`. One undo step.
    @discardableResult
    public func setText(_ id: String, _ text: String, start: Double? = nil, end: Double? = nil) -> VectorActionResult {
        editTextNode(id, "Edit Text") { n in
            let (a, b) = try vectorTextRange(n.textValue, start, end)
            var next = replaceVectorText(n, a, b, text)
            // A name that followed the text keeps following it.
            if n.name == vectorTextName(n.textValue) { next["name"] = .string(vectorTextName(next.textValue)) }
            return next
        }
    }

    /// Applies character style fields (and `fill`) to [start, end) of text node `id` (default: all
    /// of it, which changes its own style). One undo step.
    @discardableResult
    public func setTextStyle(_ id: String, _ patch: JSONObject, start: Double? = nil, end: Double? = nil) -> VectorActionResult {
        editTextNode(id, "Character Style") { n in
            let (a, b) = try vectorTextRange(n.textValue, start, end)
            return try styleVectorText(n, a, b, patch)
        }
    }

    /**
     * Applies character style fields (and `fill`) to the whole of every text node in `ids`
     * (default: the selected text, including text inside selected groups), a paragraph patch, or an
     * orientation (`styleTexts`). One undo step for all of them.
     */
    @discardableResult
    public func styleTexts(style: JSONObject? = nil, paragraph: JSONObject? = nil, orientation: JSONValue? = nil, ids: [String]? = nil) -> VectorActionResult {
        var targets: [VectorNode] = []
        for id in ids ?? selection {
            guard let n = getNode(id) else { return .failure("There is no node \"\(id)\".") }
            walkVectorNodes([n]) { c, _, _ in
                if c.isText && !truthy(c["blendStep"]) && !targets.contains(where: { $0.id == c.id }) { targets.append(c) }
            }
        }
        if targets.isEmpty { return .failure("Select text to style.") }
        var next: [String: VectorNode] = [:]
        do {
            for t in targets {
                var n = t
                if let style { n = try styleVectorText(n, 0, n.textValue.utf16.count, style) }
                if let paragraph {
                    let p = try patchVectorParagraphStyle(n["paragraph"]?.objectValue ?? JSONObject(), paragraph)
                    n["paragraph"] = .object(p)
                    if p.isEmpty { n["paragraph"] = Optional<JSONValue>.none }
                }
                if let orientation {
                    let vertical = try vectorTextOrientation(orientation)
                    if vertical && n.textFrameKind == "path" { throw VectorTextError("Text on a path cannot be vertical; set it as point or area text first.") }
                    if vertical { n["orientation"] = "vertical" } else { n["orientation"] = Optional<JSONValue>.none }
                }
                next[t.id] = n
            }
        } catch {
            return .failure("\(error)")
        }
        let label = orientation != nil && style == nil && paragraph == nil ? "Type Orientation" : paragraph != nil && style == nil ? "Paragraph Style" : "Character Style"
        change(label) { setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 }) }
        return .success
    }

    /// Changes paragraph fields (`align`, `autoLeading`, indents, spacing; `null` clears) of text node `id`. One undo step.
    @discardableResult
    public func setParagraphStyle(_ id: String, _ patch: JSONObject) -> VectorActionResult {
        editTextNode(id, "Paragraph Style") { n in
            let paragraph = try patchVectorParagraphStyle(n["paragraph"]?.objectValue ?? JSONObject(), patch)
            var next = n
            next["paragraph"] = .object(paragraph)
            if paragraph.isEmpty { next["paragraph"] = Optional<JSONValue>.none }
            return next
        }
    }

    /**
     * Changes how text node `id` is set (`setTextFrame`): `point` (keeps where its first line
     * starts), `area` (a box: `width` / `height` default to its current size, `x` / `y` to its top
     * left) or `path` options (`start`, `end`, `flip`, `orientation`, `baseline`; a new `path` needs
     * path data or a subpath in the node's own space). One undo step.
     */
    @discardableResult
    public func setTextFrame(_ id: String, _ patch: JSONObject) -> VectorActionResult {
        editTextNode(id, "Text Frame") { n in
            let kind = patch["kind"]?.stringValue ?? (patch["kind"] == nil ? n.textFrameKind : "")
            let layout = layoutVectorText(n)
            let cur = n.frame ?? JSONObject()
            let curKind = cur["kind"]?.stringValue
            let box = layout.bounds ?? VectorBounds(x: 0, y: 0, width: 0, height: 0)
            let vertical = n["orientation"] == "vertical"
            var frame: JSONObject
            if vertical && kind == "path" { throw VectorTextError("Text on a path cannot be vertical; call vector.setTextOrientation with horizontal first.") }
            if kind == "point" && vertical && curKind != "point" {
                // Vertical point text starts at the top of its first column's centre line.
                let at = layout.text.lines.first.map { lineToTextSpace(layout.text, Vec2(0, $0.baseline)) } ?? Vec2(0, 0)
                frame = try sanitizeVectorTextFrame(.object(JSONObject([("kind", "point"), ("x", patch["x"] ?? .number(layout.origin.x + at.x)), ("y", patch["y"] ?? .number(layout.origin.y + at.y))])))
            } else if kind == "point" {
                let first = layout.lines.first
                let x = patch["x"] ?? (curKind == "point" ? cur["x"] : .number(first?.x ?? box.x))
                let y = patch["y"] ?? (curKind == "point" ? cur["y"] : .number(first?.baseline ?? box.y))
                frame = try sanitizeVectorTextFrame(.object(JSONObject([("kind", "point"), ("x", x ?? .null), ("y", y ?? .null)])))
                // Point text has no wrap: the left edge stays where the lines started.
                if curKind != "point", first != nil, let align = n["paragraph"]?["align"]?.stringValue, !align.isEmpty, align != "left" {
                    frame = try sanitizeVectorTextFrame(.object(JSONObject([("kind", "point"), ("x", .number(box.x)), ("y", y ?? .null)])))
                }
            } else if kind == "area" {
                let base: (JSONValue?, JSONValue?, JSONValue?, JSONValue?) = curKind == "area"
                    ? (cur["x"], cur["y"], cur["width"], cur["height"])
                    : (.number(box.x), .number(box.y), .number(JS.max(box.width, n.fontStyle.fontSize)), .number(JS.max(box.height, n.fontStyle.fontSize * 1.2)))
                var raw = JSONObject([("kind", "area")])
                raw["x"] = patch["x"] ?? base.0
                raw["y"] = patch["y"] ?? base.1
                raw["width"] = patch["width"] ?? base.2
                raw["height"] = patch["height"] ?? base.3
                frame = try sanitizeVectorTextFrame(.object(raw))
            } else if kind == "path" {
                var path = patch["path"] ?? (curKind == "path" ? cur["path"] : nil)
                if let d = path?.stringValue { path = pathTextFrameFromBezier(toBezierPathLoose(d)).map { .object($0) } }
                guard let path, path != .null else { throw VectorTextError("Pass path (SVG path data or a subpath) to set text on a path, or use vector.typeOnPath with a path node.") }
                var raw = JSONObject()
                if curKind == "path" { for k in ["start", "end", "flip", "orientation", "baseline"] { if let v = cur[k] { raw[k] = v } } }
                for (k, v) in patch where k != "kind" && k != "path" { raw[k] = v }
                raw["kind"] = "path"
                raw["path"] = path
                frame = try sanitizeVectorTextFrame(.object(raw))
            } else {
                throw VectorTextError("kind must be point, area or path, got \(patch["kind"]?.stringified() ?? "undefined").")
            }
            var next = n
            next["frame"] = .object(frame)
            return next
        }
    }

    /// Horizontal ↔ vertical text for point and area text (`setTextOrientation`). One undo step.
    @discardableResult
    public func setTextOrientation(_ id: String, _ orientation: JSONValue) -> VectorActionResult {
        editTextNode(id, "Type Orientation") { n in
            let vertical = try vectorTextOrientation(orientation)
            if vertical && n.textFrameKind == "path" { throw VectorTextError("Text on a path cannot be vertical; set it as point or area text first (vector.setTextFrame).") }
            if vertical == (n["orientation"] == "vertical") && (vertical || n["orientation"] == nil) { return n }
            var out = n
            if vertical { out["orientation"] = "vertical" } else { out["orientation"] = Optional<JSONValue>.none }
            return out
        }
    }

    /**
     * Turns path `pathId` into text set along it (Type on a Path): a text node in its place, its
     * anchors the text's path, its paint dropped for the text defaults (or `input`'s). Returns the
     * text's id, or an error.
     */
    public func typeOnPath(_ pathId: String, _ input: VectorTextInput) -> VectorIdResult {
        guard let node = getNode(pathId) else { return (.failure("There is no node \"\(pathId)\"."), nil) }
        if !node.isPath || node.subpaths.isEmpty || node.subpaths[0].anchors.count < 2 {
            return (.failure("\"\(pathId)\" is not a path with at least two anchors; type on a path needs one."), nil)
        }
        var text: VectorNode
        do {
            var i = input
            i.path = node.subpaths[0].toJSON()
            i.x = nil
            i.y = nil
            i.width = nil
            i.height = nil
            text = try createTextNode(i)
        } catch {
            return (.failure("\(error)"), nil)
        }
        if truthy(node["transform"]) { text["transform"] = node["transform"] }
        if let name = node.name, !name.isEmpty, name != "Path" { text["name"] = .string(name) }
        let placed = text
        change("Type on a Path") {
            try? replaceNode(pathId, placed)
            selection = [placed.id]
            anchors = []
            if editingId == pathId { editingId = nil }
        }
        return (.success, placed.id)
    }

    /**
     * Create Outlines: turns text into paths of its glyph outlines (one compound path, or a group
     * with one per run fill), keeping its paint, effects, filters and placement. Needs an outline
     * text shaper. Returns the new nodes' ids, or an error.
     */
    public func createOutlines(ids: [String]? = nil) -> (result: VectorActionResult, ids: [String]?) {
        var targets: [VectorNode] = []
        for id in ids ?? selection {
            guard let n = getNode(id) else { return (.failure("There is no node \"\(id)\"."), nil) }
            if n.isText { targets.append(n) } else { walkVectorNodes([n]) { c, _, _ in if c.isText { targets.append(c) } } }
        }
        if targets.isEmpty { return (.failure("Select text to outline."), nil) }
        if !vectorTextHasOutlines() {
            return (.failure("The text shaper \"\(getVectorTextShaper().id)\" gives no glyph outlines. Load a font file and set an outline shaper (createOutlineTextShaper with parseOpenTypeFont) to create outlines."), nil)
        }
        var replaced: [(String, VectorNode)] = []
        for t in targets {
            let parts = vectorTextPaths(t).parts
            var keep = JSONObject()
            if let name = t["name"] { keep["name"] = name }
            if truthy(t["transform"]) { keep["transform"] = t["transform"] }
            if t["visible"] == .bool(false) { keep["visible"] = false }
            if truthy(t["locked"]) { keep["locked"] = true }
            if let o = t["opacity"] { keep["opacity"] = o }
            if truthy(t["blendMode"]) { keep["blendMode"] = t["blendMode"] }
            for key in ["filters", "effects"] where (arrayLength(t[key]) ?? 0) > 0 { keep[key] = t[key] }
            if truthy(t["booleanOperation"]) { keep["booleanOperation"] = t["booleanOperation"] }
            func pathOf(_ fill: JSONValue?, _ path: BezierPath, _ id: String) -> VectorNode {
                let source = vectorTextPaintSource(t, fill, bezierToSubpaths(.commands(path)))
                var props = JSONObject()
                for k in source.keys where !["transform", "visible", "locked", "opacity", "blendMode", "filters", "effects", "booleanOperation", "name"].contains(k) { props[k] = source[k] }
                props["id"] = .string(id)
                return VectorNode(props: props, subpaths: source.subpaths)
            }
            if parts.count <= 1 {
                var p = pathOf(parts.first?.fill, parts.first?.path ?? [], t.id)
                for (k, v) in keep { p[k] = v }
                replaced.append((t.id, p))
            } else {
                var props = JSONObject([("id", .string(t.id)), ("type", "group")])
                for (k, v) in keep { props[k] = v }
                let children = parts.map { part -> VectorNode in
                    var c = pathOf(part.fill, part.path, newId())
                    c["name"] = "Outlines"
                    return c
                }
                replaced.append((t.id, VectorNode(props: props, children: children)))
            }
        }
        var order: [String] = []
        var map: [String: VectorNode] = [:]
        for (id, n) in replaced {
            if map[id] == nil { order.append(id) }
            map[id] = n
        }
        change("Create Outlines") { setDoc(mapTree(doc.nodes) { map[$0.id] ?? $0 }) }
        return (.success, order)
    }

    /// The layout of text node `id` (lines, glyphs, bounds, overflow), or nil.
    public func getTextLayout(_ id: String) -> VectorTextLayout? {
        guard let node = getNode(id), node.isText else { return nil }
        return layoutVectorText(node)
    }
}

// MARK: - Text panel

/// The text panel's data (`VectorTextPanelData`): what it edits, the current values (`null` where they differ).
public struct VectorTextPanelData: Equatable, Sendable {
    /// `nodes` (whole text nodes) or `defaults` (new text); `range` needs a canvas text edit (#625).
    public var target: String
    public var ids: [String]
    /// Character fields; `null` where the target mixes values (or, for leading, auto).
    public var font: JSONObject
    public var align: String?
    public var frame: String?
    public var orientation: String?
    public var canOrient: Bool
    public var families: [String]
    public var outlines: Bool
    public var pathId: String?

    /// The panel as the TS returns it.
    public var json: JSONValue {
        .object(JSONObject([
            ("target", .string(target)), ("ids", .array(ids.map { .string($0) })), ("font", .object(font)), ("align", align.map { .string($0) } ?? .null),
            ("frame", frame.map { .string($0) } ?? .null), ("orientation", orientation.map { .string($0) } ?? .null), ("canOrient", .bool(canOrient)),
            ("families", .array(families.map { .string($0) })), ("outlines", .bool(outlines)), ("pathId", pathId.map { .string($0) } ?? .null),
        ]))
    }
}

/// `VECTOR_TEXT_ALIGN_LABELS`.
public let VECTOR_TEXT_ALIGN_LABELS = ["left": "Left", "center": "Centre", "right": "Right", "justify": "Justify"]
/// Weights a font menu offers (`VECTOR_FONT_WEIGHTS`).
public let VECTOR_FONT_WEIGHTS: [(value: Double, label: String)] = [(100, "Thin"), (300, "Light"), (400, "Regular"), (500, "Medium"), (600, "Semibold"), (700, "Bold"), (900, "Black")]

extension VectorEditorController {
    /// The text panel (`getVectorTextPanel`): shown while a Type tool is active or text is selected; nil otherwise.
    public func textPanel() -> VectorTextPanelData? {
        var nodes: [VectorNode] = []
        for id in selection {
            if let n = getNode(id) { walkVectorNodes([n]) { c, _, _ in if c.isText { nodes.append(c) } } }
        }
        let typing = tool == "type" || tool == "typePath"
        let one = selection.count == 1 ? getNode(selection[0]) : nil
        let pathId = one?.isPath == true ? one?.id : nil
        if nodes.isEmpty && !typing { return nil }
        var styles: [JSONObject] = []
        var target = "defaults"
        if !nodes.isEmpty {
            target = "nodes"
            for n in nodes { for r in vectorTextRuns(n) { styles.append(r.style) } }
        } else {
            var font = textDefaults
            remove(&font, "align")
            styles.append(font)
        }
        let FIELDS = VECTOR_CHARACTER_STYLE_KEYS
        func same(_ k: String) -> JSONValue {
            let values = styles.map { s -> JSONValue in
                if let v = s[k], v != .null { return v }
                switch k {
                case "italic", "underline", "strikethrough", "upright": return false
                case "tracking", "baselineShift": return 0
                default: return .null
                }
            }
            return values.allSatisfy { $0 == values[0] } ? values[0] : .null
        }
        var font = JSONObject()
        for k in FIELDS { font[k] = same(k) }
        let alignSource = target == "defaults" ? [textDefaults["align"]?.stringValue ?? "left"] : nodes.map { $0["paragraph"]?["align"]?.stringValue ?? "left" }
        let align = alignSource.allSatisfy { $0 == alignSource[0] } ? alignSource[0] : nil
        let orientations = nodes.map { $0["orientation"]?.stringValue ?? "horizontal" }
        let orientation = !orientations.isEmpty && orientations.allSatisfy { $0 == orientations[0] } ? orientations[0] : nil
        let canOrient = !nodes.isEmpty && nodes.allSatisfy { $0.textFrameKind != "path" }
        return VectorTextPanelData(target: target, ids: nodes.map(\.id), font: font, align: align, frame: nodes.count == 1 ? nodes[0].textFrameKind : nil, orientation: orientation, canOrient: canOrient,
                                   families: vectorTextFamilies(), outlines: vectorTextHasOutlines(), pathId: pathId)
    }

    /// Applies character fields (and `fill`) from the panel to the selected text nodes (one undo
    /// step) or the defaults for new text (`applyVectorTextStyle`).
    public func applyTextPanelStyle(_ patch: JSONObject) throws {
        guard let panel = textPanel() else { return }
        if panel.target == "nodes" {
            styleTexts(style: patch, ids: panel.ids)
            return
        }
        var font = patch
        remove(&font, "fill")
        try setTextDefaults(font)
    }

    /// Applies paragraph fields from the panel to the selected text, or the alignment to the defaults (`applyVectorParagraphStyle`).
    public func applyTextPanelParagraph(_ patch: JSONObject) throws {
        guard let panel = textPanel() else { return }
        if panel.target == "defaults" {
            if truthy(patch["align"]) { try setTextDefaults(JSONObject([("align", patch["align"]!)])) }
            return
        }
        styleTexts(paragraph: patch, ids: panel.ids)
    }

    /// Sets the selected text horizontal or vertical (one undo step; `applyVectorTextOrientation`).
    public func applyTextPanelOrientation(_ orientation: String) {
        guard let panel = textPanel(), panel.canOrient else { return }
        styleTexts(orientation: .string(orientation), ids: panel.ids)
    }
}
