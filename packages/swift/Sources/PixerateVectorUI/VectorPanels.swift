import CoreGraphics
import PixerateCore
import PixerateVector
import SwiftUI

// The toolbar and side panels (`VectorToolbar`, the layers list and `VectorStylePanel` of the React
// editor), rendered from the generated UI tables (`VectorUITables`): tool groups with their glyphs
// and shortcuts, blend modes, path and Pathfinder actions, effects, filters and editing toggles.

/**
 * The toolbar: the tools by group (`tables.tools.groups`), undo / redo, zoom, Combine (booleans,
 * group, ungroup), Pathfinder and arrange. Tools the canvas doesn't drive yet are disabled with
 * the reason in their help text (agents still reach them through the commands).
 */
public struct VectorToolbarView: View {
    let model: VectorEditorModel

    public init(model: VectorEditorModel) { self.model = model }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                VectorToolButtons(model: model)
                Divider().frame(height: 22)
                VectorHistoryButtons(model: model)
                Divider().frame(height: 22)
                VectorCombineButtons(model: model)
                Divider().frame(height: 22)
                VectorPathfinderButtons(model: model)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
    }
}

struct VectorToolButtons: View {
    let model: VectorEditorModel

    var body: some View {
        let tables = model.tables.tools
        let current = model.tool
        HStack(spacing: 2) {
            ForEach(tables.groups, id: \.id) { (group: VectorUIToolsGroupsItem) in
                HStack(spacing: 1) {
                    ForEach(group.tools, id: \.self) { (tool: String) in
                        VectorToolButton(model: model, tool: tool, glyph: tables.glyphs[tool] ?? "?", shortcut: tables.shortcuts[tool], group: group.label, selected: tool == current)
                    }
                }
                .padding(.trailing, 4)
            }
        }
    }
}

struct VectorToolButton: View {
    let model: VectorEditorModel
    let tool: String
    let glyph: String
    let shortcut: String?
    let group: String
    let selected: Bool

    var body: some View {
        let supported: Bool = VECTOR_CANVAS_TOOLS.contains(tool)
        let name: String = vectorToolName(tool)
        let keyHint: String = shortcut.map { " (\($0))" } ?? ""
        let help: String = supported ? "\(name)\(keyHint)" : "\(name)\(keyHint): not on the Swift canvas yet; agents can use its commands"
        Button {
            model.tool = tool
        } label: {
            Text(glyph)
                .font(.system(size: 15))
                .frame(width: 26, height: 24)
                .background(selected ? Color.accentColor.opacity(0.25) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .disabled(!supported)
        .opacity(supported ? 1 : 0.35)
        .help(help)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A tool id as words (`shapeBuilder` → `Shape Builder`).
func vectorToolName(_ tool: String) -> String {
    switch tool {
    case "select": return "Selection"
    case "direct": return "Direct Selection"
    case "rect": return "Rectangle"
    case "typePath": return "Type on a Path"
    case "type": return "Type"
    default:
        var out = ""
        for ch in tool {
            if ch.isUppercase { out += " " }
            out.append(ch)
        }
        return out.prefix(1).uppercased() + out.dropFirst()
    }
}

struct VectorHistoryButtons: View {
    let model: VectorEditorModel

    var body: some View {
        HStack(spacing: 4) {
            Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .disabled(!model.canUndo)
                .help("Undo (⌘Z)")
            Button { model.redo() } label: { Image(systemName: "arrow.uturn.forward") }
                .disabled(!model.canRedo)
                .help("Redo (⇧⌘Z)")
            Button { model.zoom(by: 0.8) } label: { Image(systemName: "minus.magnifyingglass") }
                .help("Zoom out (-)")
            Text("\(Int((model.viewport.zoom * 100).rounded()))%")
                .font(.caption.monospacedDigit())
                .frame(minWidth: 40)
            Button { model.zoom(by: 1.25) } label: { Image(systemName: "plus.magnifyingglass") }
                .help("Zoom in (+)")
            Button { model.zoomToFit() } label: { Image(systemName: "arrow.up.left.and.down.right.magnifyingglass") }
                .help("Fit the artboard (⌘0)")
        }
        .buttonStyle(.borderless)
    }
}

struct VectorCombineButtons: View {
    let model: VectorEditorModel

    var body: some View {
        let count: Int = model.selection.count
        let groupSelected: Bool = model.selectedNodes.contains { (n: VectorNode) -> Bool in n.isGroup }
        HStack(spacing: 4) {
            Toggle("Live", isOn: Binding(get: { model.liveBooleans }, set: { (v: Bool) in model.liveBooleans = v }))
                .toggleStyle(.button)
                .help("Live booleans: keep the shapes editable")
            VectorActionButton(label: "∪", title: "Union", disabled: count < 2) { model.boolean("union") }
            VectorActionButton(label: "−", title: "Subtract", disabled: count < 2) { model.boolean("subtract") }
            VectorActionButton(label: "∩", title: "Intersect", disabled: count < 2) { model.boolean("intersect") }
            VectorActionButton(label: "⊻", title: "Exclude", disabled: count < 2) { model.boolean("exclude") }
            VectorActionButton(label: "G", title: "Group (⌘G)", disabled: count < 1) { model.group() }
            VectorActionButton(label: "U", title: "Ungroup (⇧⌘G)", disabled: !groupSelected) { model.ungroup() }
        }
    }
}

struct VectorPathfinderButtons: View {
    let model: VectorEditorModel

    var body: some View {
        let count: Int = model.selection.count
        HStack(spacing: 4) {
            ForEach(model.tables.menus.pathfinderActions, id: \.id) { (a: VectorUIMenusPathfinderActionsItem) in
                VectorActionButton(label: a.label, title: a.title, disabled: Double(count) < a.min) { model.pathfinder(a.id) }
            }
        }
    }
}

struct VectorActionButton: View {
    let label: String
    let title: String
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label).frame(minWidth: 18)
        }
        .buttonStyle(.bordered)
        .disabled(disabled)
        .help(title)
        .accessibilityLabel(title)
    }
}

// MARK: - Layers

/// The layers panel (`vectorLayerRows`): top first, groups open to their children, with
/// visibility and lock toggles; tap selects (⇧ / ⌘ add), and the arrange buttons restack.
public struct VectorLayersPanel: View {
    let model: VectorEditorModel

    public init(model: VectorEditorModel) { self.model = model }

    public var body: some View {
        let rows: [VectorLayerRow] = model.layerRows
        let selected: Set<String> = Set(model.selection)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Layers").font(.headline)
                Spacer()
                VectorArrangeButtons(model: model, disabled: selected.isEmpty)
            }
            if rows.isEmpty {
                Text("Draw something, or ask an agent to.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(rows) { (row: VectorLayerRow) in
                VectorLayerRowView(model: model, row: row, selected: selected.contains(row.id))
            }
        }
    }
}

struct VectorArrangeButtons: View {
    let model: VectorEditorModel
    let disabled: Bool

    var body: some View {
        HStack(spacing: 2) {
            Button { model.arrange("front") } label: { Image(systemName: "square.3.layers.3d.top.filled") }.help("Bring to Front")
            Button { model.arrange("forward") } label: { Image(systemName: "chevron.up") }.help("Bring Forward")
            Button { model.arrange("backward") } label: { Image(systemName: "chevron.down") }.help("Send Backward")
            Button { model.arrange("back") } label: { Image(systemName: "square.3.layers.3d.bottom.filled") }.help("Send to Back")
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
    }
}

struct VectorLayerRowView: View {
    let model: VectorEditorModel
    let row: VectorLayerRow
    let selected: Bool

    var body: some View {
        let kindLabel: String = model.tables.labels.layerKinds[row.kind] ?? row.kind
        HStack(spacing: 4) {
            Color.clear.frame(width: CGFloat(row.depth) * 12, height: 1)
            if row.childCount > 0 {
                Button { model.toggleExpanded(row.id) } label: {
                    Image(systemName: row.expanded ? "chevron.down" : "chevron.right").frame(width: 12)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.expanded ? "Collapse" : "Expand")
            } else {
                Color.clear.frame(width: 12, height: 1)
            }
            Image(systemName: vectorLayerSymbol(row.kind))
                .foregroundStyle(.secondary)
                .help(kindLabel)
            Text(row.name)
                .lineLimit(1)
                .foregroundStyle(row.visible ? Color.primary : Color.secondary)
            Spacer(minLength: 4)
            Button { model.toggleLocked(row.id) } label: { Image(systemName: row.locked ? "lock.fill" : "lock.open") }
                .buttonStyle(.plain)
                .foregroundStyle(row.locked ? Color.primary : Color.secondary.opacity(0.5))
                .accessibilityLabel(row.locked ? "Unlock" : "Lock")
            Button { model.toggleVisible(row.id) } label: { Image(systemName: row.visible ? "eye" : "eye.slash") }
                .buttonStyle(.plain)
                .accessibilityLabel(row.visible ? "Hide" : "Show")
        }
        .font(.callout)
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(selected ? Color.accentColor.opacity(0.2) : Color.clear, in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
        .onTapGesture { model.selectLayer(row.id, add: VectorModifierKeys.addToSelection) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(kindLabel) \(row.name)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The SF Symbol of a layer kind.
func vectorLayerSymbol(_ kind: String) -> String {
    switch kind {
    case "text": return "textformat"
    case "group": return "folder"
    case "frame": return "rectangle.dashed"
    case "mask": return "circle.lefthalf.filled"
    case "blend": return "square.stack.3d.forward.dottedline"
    case "boolean": return "square.on.circle"
    case "symmetry": return "arrow.left.and.right.righttriangle.left.righttriangle.right"
    case "instance": return "square.on.square"
    case "connector": return "point.topleft.down.to.point.bottomright.curvepath"
    case "lens": return "magnifyingglass"
    default: return "scribble"
    }
}

/// Whether Shift or Command is held (adds a layer to the selection).
enum VectorModifierKeys {
    @MainActor static var addToSelection: Bool {
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        let f = NSEvent.modifierFlags
        return f.contains(.shift) || f.contains(.command)
        #else
        return false
        #endif
    }
}

// MARK: - Appearance

/**
 * The style panel (`VectorStylePanel`) for the selection: name, text, fill and stroke colours
 * (or none), stroke width, opacity, blend mode (`tables.menus.blendModes`), path actions
 * (`tables.menus.pathActions`), effects (`tables.menus.effects`), filters (`tables.menus.filters`)
 * and the editing toggles (`tables.menus.editToggles`).
 */
public struct VectorAppearancePanel: View {
    let model: VectorEditorModel

    public init(model: VectorEditorModel) { self.model = model }

    public var body: some View {
        let nodes: [VectorNode] = model.selectedNodes
        VStack(alignment: .leading, spacing: 12) {
            if let node = nodes.first {
                VectorNodeFields(model: model, node: node, count: nodes.count)
                VectorPaintFields(model: model, node: node)
                VectorPathActions(model: model)
                VectorEffectMenus(model: model)
            } else {
                Text("Select something to style it.").font(.caption).foregroundStyle(.secondary)
            }
            VectorEditToggles(model: model)
        }
    }
}

struct VectorNodeFields: View {
    let model: VectorEditorModel
    let node: VectorNode
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(count > 1 ? "\(count) selected" : vectorLayerName(node)).font(.headline).lineLimit(1)
            if count == 1 {
                VectorCommitField(title: "Name", value: node.name ?? "") { (v: String) in model.rename(node.id, v) }
                if node.isText {
                    VectorCommitField(title: "Text", value: node["text"]?.stringValue ?? "") { (v: String) in model.setText(node.id, v) }
                }
            }
        }
    }
}

/// A text field that applies its text on Return (one undo step per edit, not per key).
struct VectorCommitField: View {
    let title: String
    let value: String
    let commit: (String) -> Void
    @State private var draft = ""

    var body: some View {
        TextField(title, text: $draft)
            .textFieldStyle(.roundedBorder)
            .onSubmit { if draft != value { commit(draft) } }
            .onAppear { draft = value }
            .onChange(of: value) { (_: String, v: String) -> Void in draft = v }
    }
}

/// A slider whose drag is one undo step (`beginLiveEdit` / `endLiveEdit`).
struct VectorStyleSlider: View {
    let model: VectorEditorModel
    let value: Double
    let range: ClosedRange<Double>
    let set: @MainActor @Sendable (Double) -> Void

    var body: some View {
        Slider(value: Binding(get: { value }, set: set), in: range) { (editing: Bool) in
            if editing { model.beginLiveEdit() } else { model.endLiveEdit() }
        }
    }
}

/// A paint as a colour for the pickers (`#rrggbb` strings; gradients show their first stop).
func vectorPaintColor(_ paint: JSONValue?) -> CGColor? {
    if let s = paint?.stringValue { return parseCSSColor(s) }
    if let stop = paint?["stops"]?.arrayValue?.first, let c = stop["color"]?.stringValue { return parseCSSColor(c) }
    return nil
}

/// A colour as `#rrggbb` (or `#rrggbbaa` when see-through).
func vectorHex(_ color: CGColor) -> String {
    let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    let c = color.converted(to: srgb, intent: .defaultIntent, options: nil) ?? color
    let comps: [CGFloat] = c.components ?? [0, 0, 0, 1]
    let rgb: [CGFloat] = comps.count >= 3 ? Array(comps.prefix(3)) : [comps[0], comps[0], comps[0]]
    let alpha: CGFloat = comps.count >= 4 ? comps[3] : (comps.count == 2 ? comps[1] : 1)
    func byte(_ v: CGFloat) -> String {
        let n: Int = Int((Swift.min(1, Swift.max(0, v)) * 255).rounded())
        return (n < 16 ? "0" : "") + String(n, radix: 16)
    }
    let base: String = "#" + rgb.map(byte).joined()
    return alpha < 0.999 ? base + byte(alpha) : base
}

struct VectorPaintFields: View {
    let model: VectorEditorModel
    let node: VectorNode

    var body: some View {
        let fill: CGColor? = vectorPaintColor(node.fill)
        let stroke: CGColor? = vectorPaintColor(node.stroke)
        let width: Double = node.strokeWidth ?? 1
        let opacity: Double = node.opacity ?? 1
        let blend: String = node["blendMode"]?.stringValue ?? "normal"
        VStack(alignment: .leading, spacing: 8) {
            VectorColorRow(label: "Fill", color: fill, gradient: isVectorGradient(node.fill)) { (v: JSONValue) in model.setStyle(["fill": v]) }
            VectorColorRow(label: "Stroke", color: stroke, gradient: isVectorGradient(node.stroke)) { (v: JSONValue) in model.setStyle(["stroke": v]) }
            LabeledContent("Width") {
                HStack {
                    VectorStyleSlider(model: model, value: width, range: 0...40) { (v: Double) in model.setStyle(["strokeWidth": .number((v * 10).rounded() / 10)]) }
                    Text(String(format: "%.1f", width)).font(.caption.monospacedDigit()).frame(width: 34)
                }
            }
            LabeledContent("Opacity") {
                HStack {
                    VectorStyleSlider(model: model, value: opacity, range: 0...1) { (v: Double) in model.setStyle(["opacity": .number((v * 100).rounded() / 100)]) }
                    Text("\(Int((opacity * 100).rounded()))%").font(.caption.monospacedDigit()).frame(width: 34)
                }
            }
            Picker("Blend", selection: Binding(get: { blend }, set: { (v: String) in model.setBlendMode(v) })) {
                ForEach(model.tables.menus.blendModes, id: \.mode) { (m: VectorUIMenusBlendModesItem) in
                    Text(m.label).tag(m.mode)
                }
            }
        }
    }
}

struct VectorColorRow: View {
    let label: String
    let color: CGColor?
    let gradient: Bool
    let set: (JSONValue) -> Void

    var body: some View {
        HStack {
            Text(label).frame(width: 50, alignment: .leading)
            ColorPicker(label, selection: Binding(get: { color ?? CGColor(gray: 0, alpha: 1) }, set: { (c: CGColor) in set(.string(vectorHex(c))) }))
                .labelsHidden()
            if gradient { Text("Gradient").font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Button(color == nil && !gradient ? "None" : "Remove") { set(.null) }
                .buttonStyle(.borderless)
                .disabled(color == nil && !gradient)
                .help("No \(label.lowercased())")
        }
    }
}

struct VectorPathActions: View {
    let model: VectorEditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Path").font(.subheadline.weight(.semibold))
            HStack(spacing: 4) {
                ForEach(model.tables.menus.pathActions, id: \.id) { (a: VectorUIMenusPathActionsItem) in
                    let hint: String = a.shortcut.map { " (\($0))" } ?? ""
                    VectorActionButton(label: a.label, title: a.title + hint, disabled: false) { model.pathAction(a.id) }
                }
            }
        }
    }
}

struct VectorEffectMenus: View {
    let model: VectorEditorModel

    var body: some View {
        HStack {
            Menu("Add Effect") {
                ForEach(model.tables.menus.effects, id: \.type) { (e: VectorUIMenusEffectsItem) in
                    Button(e.label) { model.addEffect(e.type) }
                }
            }
            Menu("Add Filter") {
                ForEach(model.tables.menus.filters, id: \.type) { (f: VectorUIMenusFiltersItem) in
                    Button(f.label) { model.addFilter(f.type) }
                }
            }
        }
        .fixedSize()
    }
}

struct VectorEditToggles: View {
    let model: VectorEditorModel

    var body: some View {
        let editing: JSONObject = model.editingOptions
        VStack(alignment: .leading, spacing: 4) {
            Text("Editing").font(.subheadline.weight(.semibold))
            ForEach(model.tables.menus.editToggles, id: \.key) { (t: VectorUIMenusEditTogglesItem) in
                Toggle(t.title, isOn: Binding(get: { editing[t.key]?.boolValue ?? false }, set: { (v: Bool) in model.setEditing(t.key, v) }))
            }
        }
    }
}
