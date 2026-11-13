import Foundation
import Observation
import PixerateCore
import PixerateGeometry
import PixeratePaint
import PixerateVector
import SwiftUI

/// What the canvas draws: the scene render data, and why some of it could not be drawn.
public struct VectorSceneSnapshot {
    /// `getVectorSceneRenderData` for the document and the view, or nil when nothing can be drawn.
    public var data: JSONValue?
    /// Layers left out because the Swift render data cannot draw them yet, and why.
    public var issue: String?
}

/// The side panels of `VectorEditorView`.
public enum VectorPanelTab: String, CaseIterable, Identifiable, Sendable {
    case layers, appearance
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .layers: return "Layers"
        case .appearance: return "Appearance"
        }
    }
}

/**
 * The vector editor's view model (`useVectorEditor` + the toolbar's and panels' handlers): one per
 * editor view. It owns the `VectorEditorController`, its `CommandRegistry` and a `ToolRegistry`
 * with the editor's agent tools (`vector-commands` through `createCommandToolProvider`,
 * `vector-style`, and `vector-effects` / `vector-generation` when given a provider), so agents and
 * the user edit the same document; the registry can be served over the MCP bridge
 * (`ToolBridgeClient`). It subscribes to the controller and bumps `revision` after every change,
 * whoever made it, so SwiftUI views that read its properties redraw. Canvas input goes through
 * `gesture` (`VectorCanvasGesture`); every panel action is the controller call the matching agent
 * command makes.
 */
@MainActor
@Observable
public final class VectorEditorModel {
    public let controller: VectorEditorController
    /// The vector commands (`createVectorCommands`), which agents run through `registry`.
    public let commands: CommandRegistry<VectorEditorController>
    /// The editor's agent tools.
    public let registry: ToolRegistry
    /// What the panels render (`ui.json`).
    public let tables: VectorUITables
    /// The commands with default shortcuts (`commands.json`): id and keys as written (`Mod+G`).
    public let shortcutCommands: [(id: String, keys: [String])]
    /// Bumped after every change to the editor.
    public private(set) var revision = 0
    /// The last refusal or error, shown under the canvas.
    public var error: String?
    /// The side panel shown.
    public var tab: VectorPanelTab = .layers
    /// Groups opened in the layers panel.
    public var expandedLayers: Set<String> = []
    /// Live booleans keep their operands editable (the toolbar's Live toggle).
    public var liveBooleans = false
    /// The canvas view's size in points (the canvas keeps it current).
    @ObservationIgnored public var viewSize: (width: Double, height: Double) = (800, 600)
    @ObservationIgnored public private(set) var gesture: VectorCanvasGesture!
    @ObservationIgnored private var subscriptions: [Cancellable] = []
    @ObservationIgnored private var fitted = false
    @ObservationIgnored private var liveMark: HistoryMark?
    @ObservationIgnored private var cachedScene: (revision: Int, scene: VectorSceneSnapshot)?

    /**
     - Parameters:
       - controller: the editor (default: an 800 × 600 artboard).
       - textShaper: set for the process (`setVectorTextShaper`) so text draws with real fonts
         (default `CoreTextVectorShaper`); nil leaves the shaper as it is.
       - effects: an effects provider: the `vector-effects` tools apply its effects.
       - generation: vector art models: the `vector-generation` tools generate with them.
       - houseStyle: the house style `check_vector_style` and `fix_vector_style` check against.
     */
    public init(
        controller: VectorEditorController? = nil,
        registry: ToolRegistry? = nil,
        textShaper: VectorTextShaper? = CoreTextVectorShaper(),
        effects: EffectProvider? = nil,
        generation: VectorGenerationOptions? = nil,
        houseStyle: HouseStyle = HouseStyle()
    ) throws {
        if let textShaper { setVectorTextShaper(textShaper) }
        let c = try controller ?? VectorEditorController()
        self.controller = c
        if let effects { c.setEffectsProvider(effects) }
        let r = registry ?? ToolRegistry(validateArguments: true)
        self.registry = r
        tables = try VectorContracts.uiTables()
        shortcutCommands = try VectorContracts.commands().filter { !$0.shortcut.isEmpty }.map { (id: $0.id, keys: $0.shortcut) }
        let cmds = CommandRegistry(context: c, history: c.history)
        subscriptions.append(try cmds.register(createVectorCommands(c)))
        commands = cmds
        subscriptions.append(try r.register(createCommandToolProvider(cmds, CommandToolProviderOptions(id: "vector-commands", namespace: ""))))
        subscriptions.append(try r.register(createVectorStyleToolProvider(c, houseStyle)))
        if effects != nil { subscriptions.append(try r.register(createVectorEffectsToolProvider(c))) }
        if let generation { subscriptions.append(try r.register(createVectorGenerationToolProvider(c, VectorGenerationToolProviderOptions(generation)))) }
        let g = VectorCanvasGesture(controller: c)
        g.onChange = { [weak self] in self?.revision &+= 1 }
        g.onMessage = { [weak self] message in self?.error = message }
        gesture = g
        subscriptions.append(c.subscribe { [weak self] in
            // Agents may call in from the bridge's queue; the model lives on the main actor.
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.changed() }
            } else {
                DispatchQueue.main.async { self?.changed() }
            }
        })
    }

    private func changed() {
        revision &+= 1
    }

    /// Reading it makes a view redraw after every change.
    private func track() { _ = revision }

    // MARK: State

    public var document: VectorDocument {
        track()
        return controller.document
    }

    public var selection: [String] {
        track()
        return controller.selectedIds
    }

    /// The selected nodes, in selection order.
    public var selectedNodes: [VectorNode] {
        track()
        return controller.selectedIds.compactMap { controller.getNode($0) }
    }

    /// The canvas tool (`VectorUITables.tools.order`); agents switch it with `vector.setTool`.
    public var tool: String {
        get {
            track()
            return controller.currentTool
        }
        set {
            gesture.finishPath()
            controller.setTool(newValue)
            revision &+= 1
        }
    }

    public var viewport: VectorViewport {
        track()
        return controller.viewport
    }

    /// The editing options (`state.editing`).
    public var editingOptions: JSONObject {
        track()
        return controller.editingOptions
    }

    public var canUndo: Bool {
        track()
        return controller.history.state.canUndo
    }

    public var canRedo: Bool {
        track()
        return controller.history.state.canRedo
    }

    /// The layers panel's rows, top first.
    public var layerRows: [VectorLayerRow] {
        track()
        let open = expandedLayers
        return vectorLayerRows(controller.document.nodes) { open.contains($0) }
    }

    /// What the canvas draws. Layers the Swift render data can't draw yet are left out, with the reason in `issue`.
    public var scene: VectorSceneSnapshot {
        track()
        if let cached = cachedScene, cached.revision == revision { return cached.scene }
        let s = makeScene()
        cachedScene = (revision, s)
        return s
    }

    private func makeScene() -> VectorSceneSnapshot {
        do {
            return VectorSceneSnapshot(data: try controller.sceneRenderData(), issue: nil)
        } catch {
            // Draw what can be drawn: each top-level layer on its own.
            let doc = controller.document
            var nodes: [JSONValue] = []
            var defs: [JSONValue] = []
            var skipped: [String] = []
            var reason = "\(error)"
            for node in doc.nodes {
                var one = doc
                one.nodes = [node]
                do {
                    let data = try getVectorSceneRenderData(one, viewport: controller.viewport)
                    nodes += data["nodes"]?.arrayValue ?? []
                    defs += data["defs"]?.arrayValue ?? []
                } catch let e {
                    skipped.append(vectorLayerName(node))
                    reason = "\(e)"
                }
            }
            guard var base = try? getVectorSceneRenderData(VectorDocument(width: doc.width, height: doc.height), viewport: controller.viewport), var o = base.objectValue else {
                return VectorSceneSnapshot(data: nil, issue: reason)
            }
            if let bg = doc.background { o["background"] = .string(bg) }
            o["nodes"] = .array(nodes)
            o["defs"] = .array(defs)
            base = .object(o)
            let names = skipped.prefix(3).joined(separator: ", ") + (skipped.count > 3 ? " and \(skipped.count - 3) more" : "")
            return VectorSceneSnapshot(data: base, issue: skipped.isEmpty ? nil : "Not drawn here: \(names) (\(reason)).")
        }
    }

    // MARK: View

    /// Fits the artboard into the canvas the first time it has a size.
    public func fitOnce() {
        if fitted || viewSize.width <= 0 || viewSize.height <= 0 { return }
        fitted = true
        zoomToFit()
    }

    /// Fits the artboard into the canvas (`zoomToFit`).
    public func zoomToFit() {
        controller.zoomToFit((viewSize.width, viewSize.height))
    }

    /// Zooms about the canvas centre.
    public func zoom(by factor: Double) {
        gesture.zoom(by: factor, aboutX: viewSize.width / 2, y: viewSize.height / 2)
    }

    // MARK: Pointer

    public func pointerDown(_ e: VectorPointerEvent) { gesture.pointerDown(e) }
    public func pointerMove(_ e: VectorPointerEvent) { gesture.pointerMove(e) }
    public func pointerUp(_ e: VectorPointerEvent) { gesture.pointerUp(e) }
    public func pointerCancel() { gesture.cancel() }

    // MARK: Actions

    /// Shows a refused action's message; true when it went through.
    @discardableResult
    func check(_ result: VectorActionResult) -> Bool {
        error = result.ok ? nil : result.message
        return result.ok
    }

    /// Runs `fn`, showing what it throws (and clearing the last message first).
    func attempt(_ fn: () throws -> Void) {
        error = nil
        do {
            try fn()
        } catch {
            self.error = "\(error)"
        }
    }

    public func undo() {
        gesture.finishPath()
        controller.undo()
    }

    public func redo() {
        controller.redo()
    }

    /// Selects every top-level layer that is visible and not locked.
    public func selectAll() {
        controller.select(controller.document.nodes.filter { $0.isVisible && !$0.isLocked }.map(\.id))
    }

    /// Deletes the picked anchors (Direct Selection) or the selection (`vector.delete`, `vector.deleteAnchors`).
    public func deleteSelection() {
        let anchors = gesture.anchors
        if controller.currentTool == "direct" && !anchors.isEmpty {
            attempt { check(try controller.deleteAnchors(anchors)) }
            return
        }
        if controller.selectedIds.isEmpty { return }
        attempt { check(try controller.removeNodes(controller.selectedIds)) }
    }

    /// Moves the selection by document units (arrow keys).
    public func nudge(_ dx: Double, _ dy: Double) {
        if controller.selectedIds.isEmpty { return }
        attempt { check(try controller.translate(dx, dy)) }
    }

    public func group() {
        attempt {
            if try controller.group() == nil { error = "Select something to group." }
        }
    }

    public func ungroup() {
        attempt { check(try controller.ungroup()) }
    }

    /// `union`, `subtract`, `intersect` or `exclude` on the selection (live when `liveBooleans`).
    public func boolean(_ op: String) {
        attempt {
            if try controller.booleanOp(op, live: liveBooleans) == nil { error = "Select two or more shapes to combine." }
        }
    }

    /// A Pathfinder action (`VectorUITables.menus.pathfinderActions`).
    public func pathfinder(_ op: String) {
        attempt {
            if try controller.pathfinder(op).isEmpty { error = "\(tables.labels.pathfinder.label(op)) changed nothing." }
        }
    }

    /// A path action (`VectorUITables.menus.pathActions`): join, average, cut, clean, smooth or outline.
    public func pathAction(_ id: String) {
        attempt {
            switch id {
            case "join": check(try controller.joinPaths())
            case "average": check(try controller.averageAnchors("both", gesture.anchors.isEmpty ? nil : gesture.anchors))
            case "cut": check(try controller.cutAtAnchors(gesture.anchors.isEmpty ? nil : gesture.anchors))
            case "clean": check(try controller.removeRedundantPoints())
            case "smooth": check(try controller.smoothPaths(refs: gesture.anchors.isEmpty ? nil : gesture.anchors))
            case "outline":
                if try controller.outlineStroke().isEmpty { error = "Select paths with a stroke to outline." }
            default: error = "Unknown path action \"\(id)\"."
            }
        }
    }

    /// `front`, `forward`, `backward` or `back`.
    public func arrange(_ op: String) {
        attempt { check(try controller.arrange(op)) }
    }

    /// Sets style fields on the selection (`vector.setStyle`). Inside a live edit (a slider drag)
    /// the edit replaces the drag's earlier ones, so the drag is one undo step.
    public func setStyle(_ style: JSONObject) {
        if controller.selectedIds.isEmpty { return }
        if let mark = liveMark { _ = controller.history.revertTo(mark) }
        attempt { check(try controller.setStyle(style)) }
    }

    /// Starts a live edit (a slider drag): `setStyle` calls until `endLiveEdit` make one undo step.
    public func beginLiveEdit() {
        liveMark = controller.history.mark()
    }

    public func endLiveEdit() {
        liveMark = nil
    }

    public func setBlendMode(_ mode: String) {
        check(controller.setBlendMode(mode))
    }

    /// Adds a path effect with its defaults (`VectorUITables.menus.effects`).
    public func addEffect(_ type: String) {
        attempt {
            if try controller.addEffect(type).isEmpty { error = "Select paths or groups to add \(type) to." }
        }
    }

    /// Adds a filter (`VectorUITables.menus.filters`).
    public func addFilter(_ type: String) {
        if controller.addFilter(type).isEmpty { error = "Select something to add the filter to." }
    }

    public func rename(_ id: String, _ name: String) {
        attempt { check(try controller.rename(id, name)) }
    }

    /// Shows or hides a layer.
    public func toggleVisible(_ id: String) {
        guard let node = controller.getNode(id) else { return }
        attempt { check(try controller.updateNode(id, ["visible": .bool(!node.isVisible)], label: node.isVisible ? "Hide" : "Show")) }
    }

    /// Locks or unlocks a layer.
    public func toggleLocked(_ id: String) {
        guard let node = controller.getNode(id) else { return }
        attempt { check(try controller.updateNode(id, ["locked": .bool(!node.isLocked)], label: node.isLocked ? "Unlock" : "Lock")) }
    }

    /// Opens or closes a group's row in the layers panel.
    public func toggleExpanded(_ id: String) {
        if expandedLayers.contains(id) { expandedLayers.remove(id) } else { expandedLayers.insert(id) }
    }

    /// Selects a layer from the panel (Shift / Command add to the selection).
    public func selectLayer(_ id: String, add: Bool = false) {
        controller.select([id], toggle: add)
    }

    /// Changes a text node's text (`vector.setText`).
    public func setText(_ id: String, _ text: String) {
        check(controller.setText(id, text))
    }

    /// Turns an editing option on or off (`VectorUITables.menus.editToggles`).
    public func setEditing(_ key: String, _ on: Bool) {
        controller.setEditing([key: .bool(on)])
    }

    // MARK: Keys

    /// The command a key press runs, if any, from the contract's shortcuts (`Mod` is ⌘ / Ctrl).
    public func commandFor(key: String, mod: Bool, shift: Bool, alt: Bool) -> String? {
        if key.isEmpty { return nil }
        var parts: [String] = []
        if mod { parts.append("Mod") }
        if alt { parts.append("Alt") }
        if shift { parts.append("Shift") }
        let name = key.count == 1 ? key.uppercased() : key
        let combo = (parts + [name]).joined(separator: "+").lowercased()
        return shortcutCommands.first { $0.keys.contains { $0.lowercased() == combo } }?.id
    }

    /// Handles a key on the canvas; false when it isn't one of the editor's. Keys are characters
    /// (`g`, `+`) or names (`Escape`, `Return`, `Delete`, `ArrowLeft`, `F8`).
    @discardableResult
    public func handleKey(_ key: String, mod: Bool = false, shift: Bool = false, alt: Bool = false) -> Bool {
        let lower = key.lowercased()
        if mod && lower == "z" {
            if shift { redo() } else { undo() }
            return true
        }
        if mod && lower == "y" {
            redo()
            return true
        }
        if mod && lower == "a" {
            selectAll()
            return true
        }
        if mod && lower == "0" {
            zoomToFit()
            return true
        }
        if let id = commandFor(key: key, mod: mod, shift: shift, alt: alt) {
            if case let .failure(f) = commands.execute(id) { error = f.message } else { error = nil }
            return true
        }
        switch key {
        case "Escape":
            if gesture.isDragging { gesture.cancel() } else if gesture.isDrawingPath { gesture.finishPath() } else { controller.clearSelection() }
            return true
        case "Return", "Enter":
            if gesture.isDrawingPath {
                gesture.finishPath()
                return true
            }
            return false
        case "Delete", "Backspace":
            deleteSelection()
            return true
        case "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown":
            let step = (shift ? 10 : 1) / controller.viewport.zoom
            let dx = key == "ArrowLeft" ? -step : key == "ArrowRight" ? step : 0
            let dy = key == "ArrowUp" ? -step : key == "ArrowDown" ? step : 0
            nudge(dx, dy)
            return true
        case "+", "=":
            zoom(by: 1.25)
            return true
        case "-":
            zoom(by: 0.8)
            return true
        default:
            break
        }
        if !mod && !alt && key.count == 1, let t = tables.tools.shortcuts.first(where: { $0.value.lowercased() == lower })?.key, !shift {
            tool = t
            return true
        }
        return false
    }

    /// Space held pans with the primary button.
    public func setSpaceHeld(_ held: Bool) {
        gesture.spaceHeld = held
    }
}

extension VectorUILabelsPathfinder {
    /// The label of a Pathfinder operation.
    func label(_ op: String) -> String {
        switch op {
        case "divide": return divide
        case "trim": return trim
        case "merge": return merge
        case "crop": return crop
        case "outline": return outline
        case "minusBack": return minusBack
        default: return op
        }
    }
}
