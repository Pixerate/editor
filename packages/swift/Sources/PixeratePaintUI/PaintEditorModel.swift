import Foundation
import Observation
import PixerateCore
import PixeratePaint
import PixerateRaster
import SwiftUI
import UniformTypeIdentifiers

/// Reads `a.b` from a JSON object as a number, 0 when missing (`readPath` in `paint-editor/ui.ts`).
public func readPath(_ obj: JSONObject, _ path: String) -> Double {
    var v: JSONValue? = .object(obj)
    for k in path.split(separator: ".") { v = v?[String(k)] }
    return v?.numberValue ?? 0
}

/// `{a: {b: value}}` for `a.b`, keeping the rest of `obj`'s `a` (`patchPath`).
public func patchPath(_ obj: JSONObject, _ path: String, _ value: JSONValue) -> JSONObject {
    let parts = path.split(separator: ".", maxSplits: 1).map(String.init)
    if parts.count == 1 { return JSONObject([(parts[0], value)]) }
    var inner = obj[parts[0]]?.objectValue ?? JSONObject()
    for (k, v) in patchPath(inner, parts[1], value) { inner[k] = v }
    return JSONObject([(parts[0], .object(inner))])
}

/**
 * Where each brush option (`PaintUITables.brushOptions`) lives: the facet `set_brush` takes and
 * the field of the engine brush that shows it.
 */
public let PAINT_BRUSH_OPTION_PATHS: [String: (facet: String, read: @Sendable (PaintBrush) -> Double)] = [
    "size": ("tip.size", { $0.tip.size }),
    "hardness": ("tip.hardness", { $0.tip.hardness }),
    "opacity": ("tip.opacity", { $0.tip.opacity }),
    "flow": ("tip.flow", { $0.tip.flow }),
    "smoothing": ("dynamics.smoothing", { $0.tip.smoothing }),
]

/// The value a stroke slider (`PaintUITables.sliders.stroke`, a path into the stroke's brush) shows.
public func strokeSliderValue(_ brush: PaintBrush, _ path: String) -> Double {
    switch path {
    case "tip.size": return brush.tip.size
    case "tip.opacity": return brush.tip.opacity
    case "tip.flow": return brush.tip.flow
    case "tip.hardness": return brush.tip.hardness
    default: return 0
    }
}

/// The paper sliders (`PaintUITables.sliders.paper`) this port shows: all of them (wet media read absorption, permeability and roughness; metallic and backlit paper are drawn).
public let PAINT_PAPER_SLIDER_PATHS: Set<String> = ["depth", "scale", "shading", "dry.contrast", "absorption", "permeability", "roughness", "metallic", "backlight"]

/// Flow map kinds as the wet panel lists them (`WetPanel`'s labels).
public let WET_FLOW_LABELS: [(kind: String, label: String)] = [("none", "None"), ("linear", "One way"), ("swirl", "Swirl"), ("radial", "Outwards"), ("turbulent", "Eddies")]

/// The side panels of `PaintEditorView`.
public enum PaintPanelTab: String, CaseIterable, Identifiable, Sendable {
    case color, paper, layers, effects, wet
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .color: return "Colour"
        case .paper: return "Paper"
        case .layers: return "Layers"
        case .effects: return "Styles"
        case .wet: return "Wet"
        }
    }
}

/**
 * The paint editor's view model (`usePaintEditor` + the panels' handlers): one per editor view.
 * It owns the `ToolRegistry` with the editor's agent tools, subscribes to the controller, and
 * bumps `revision` after every change, whoever made it (the user here, or an agent through the
 * registry), so SwiftUI views that read its properties redraw. Every action is the same
 * controller call the matching agent tool makes.
 */
@MainActor
@Observable
public final class PaintEditorModel {
    public let controller: PaintEditorController
    /// The editor's agent tools (`paint-editor` and `brushes` providers).
    public let registry: ToolRegistry
    /// What the panels render (`ui.json`).
    public let tables: PaintUITables
    /// The keyboard commands (`commands.json`).
    public let commands: [ShortcutCommand]
    /// Bumped after every change to the editor.
    public private(set) var revision = 0
    /// Bumped when non-canvas UI state (brush, colour, layers, undo, tools, settings) may have changed.
    private var stateRevision = 0
    @ObservationIgnored private var isQuietFrameChange = false
    /// The active tool (`PaintUITables.tools` id).
    public var tool = "brush" { didSet { gesture.tool = tool } }
    /// The last refusal or error, shown under the canvas.
    public var error: String?
    /// The picked stroke of the active stroke layer.
    public var selectedStroke: String?
    /// The layer style being edited in the Styles panel.
    public var selectedEffect: String?
    public var tab: PaintPanelTab = .color
    /// The canvas view's size in points (the canvas view keeps it current).
    @ObservationIgnored public var viewport: (width: Double, height: Double) = (800, 600)
    @ObservationIgnored public private(set) var gesture: PaintGesture!
    @ObservationIgnored private var subscriptions: [Cancellable] = []
    @ObservationIgnored private var fitted: String?

    /// A model over `controller` (default a new 1024 × 768 painting), with its tools in `registry` (default a new one).
    public init(controller: PaintEditorController? = nil, registry: ToolRegistry? = nil) throws {
        let c = try controller ?? PaintEditorController(width: 1024, height: 768)
        self.controller = c
        let r = registry ?? ToolRegistry()
        self.registry = r
        tables = try PaintContracts.uiTables()
        commands = try PaintContracts.commands()
        subscriptions.append(try r.register(createPaintEditorToolProvider(c)))
        // Provider effects: their read tools say when no provider is set (`controller.setEffectsProvider`).
        subscriptions.append(try r.register(createPaintEffectsToolProvider(c)))
        subscriptions.append(try r.register(createPaintBrushLibraryToolProvider(c)))
        gesture = PaintGesture(controller: c) { [unowned self] in self.viewport }
        gesture.onSelectStroke = { [unowned self] id in self.selectedStroke = id }
        subscriptions.append(c.subscribe { [weak self] in
            MainActor.assumeIsolated { self?.changed() }
        })
    }

    private func changed() {
        revision &+= 1
        if !isQuietFrameChange { stateRevision &+= 1 }
    }

    /// Reads `stateRevision`, so a view reading a property below redraws when UI state changes (without re-evaluating panels on every stroke sample or wet tick).
    private func track() { _ = stateRevision }

    /// Runs `fn`, turning a thrown error into `error` (`useAttempt`).
    @discardableResult
    public func attempt<T>(_ fn: () throws -> T) -> T? {
        error = nil
        do { return try fn() } catch {
            self.error = "\(error)"
            return nil
        }
    }

    // MARK: - State

    public var canvas: PaintCanvas { track(); return controller.doc.canvas }
    public var view: PaintView { track(); return controller.view }
    public var brush: PaintBrush { track(); return controller.brush }
    /// The brushes this port paints with, in library order.
    public var brushes: [PaintBrush] { track(); return controller.brushes.filter(controller.canPaint) }
    public var color: String { track(); return controller.color }
    public var secondaryColor: String { track(); return controller.secondaryColor }
    public var colorLocked: Bool { track(); return controller.colorLocked }
    public var swatches: [Swatch] { track(); return controller.swatches }
    public var paper: PaperSettings { track(); return controller.doc.paper }
    public var guides: PaintGuides { track(); return controller.guides }
    public var hand: String { track(); return controller.hand }
    public var undoLabel: String? { track(); return controller.undoLabel }
    public var redoLabel: String? { track(); return controller.redoLabel }
    /// The layer stack, top first, as `list_layers` reports it.
    public var layers: [PaintLayerInfo] { track(); return controller.listLayers() }
    public var activeLayer: PaintLayerInfo? { layers.first(where: \.active) }
    /// The active layer's strokes when it is a stroke layer, else nil.
    public var liveStrokes: [RecordedStroke]? {
        track()
        guard let id = controller.doc.activeLayerId else { return nil }
        return controller.doc.liveStrokes?.get(id)
    }
    /// The active layer's styles.
    public var layerEffects: LayerEffects? {
        track()
        guard let id = controller.doc.activeLayerId else { return nil }
        return try? controller.getLayerEffects(id)
    }
    /// The rows of `PaintUITables.tools` this port's canvas handles.
    public var toolRows: [PaintUIToolsItem] { tables.tools.filter { PAINT_UI_TOOLS.contains($0.id) } }
    /// The paper sliders this port shows.
    public var paperSliders: [PaintUISlidersPaperItem] { tables.sliders.paper.filter { PAINT_PAPER_SLIDER_PATHS.contains($0.path) } }

    // MARK: - Pointer input

    /// The predicted tail of the stroke being painted (document pixels), drawn as a thin preview.
    public private(set) var predicted: [PenPoint] = []
    /// While a stroke of a stroke layer is dragged: its id and how far it moved.
    public private(set) var strokeDrag: (id: String, dx: Double, dy: Double)?

    private func afterGesture() {
        if let e = gesture.error { error = e }
        if !(predicted.isEmpty && gesture.predicted.isEmpty) { predicted = gesture.predicted }
        let drag = gesture.strokeDrag
        if drag?.id != strokeDrag?.id || drag?.dx != strokeDrag?.dx || drag?.dy != strokeDrag?.dy { strokeDrag = drag }
    }

    /// Pointer down on the canvas; returns true when the gesture took the pointer.
    @discardableResult
    public func pointerDown(_ e: PaintPointerEvent) -> Bool {
        error = nil
        let took = gesture.down(e)
        afterGesture()
        return took
    }

    public func pointerMove(_ e: PaintPointerEvent) {
        let quiet = tool == "brush" && controller.activeStroke != nil
        isQuietFrameChange = quiet
        gesture.move(e)
        isQuietFrameChange = false
        afterGesture()
    }

    public func pointerUp(_ e: PaintPointerEvent) {
        gesture.up(e)
        afterGesture()
    }

    public func pointerCancel() {
        gesture.cancel()
        afterGesture()
    }

    // MARK: - History and view

    public func undo() { _ = controller.undo() }
    public func redo() { _ = controller.redo() }

    // MARK: - Export

    /// The painting as a file (`export_image` / `export_psd`): PNG with the paper, or an 8-bit RGB PSD with its layers.
    /// `scale` above 1 repaints the recorded strokes larger (`export_high_res`) instead of upscaling.
    public func exportFile(_ format: PaintExportFormat, scale: Double = 1) async -> PaintExportFile? {
        if format == .png && scale > 1 {
            do {
                let img = try await controller.renderHighRes(scale: scale)
                error = nil
                return PaintExportFile(format: .png, bytes: Data(encodePng(img.width, img.height, img.data)))
            } catch {
                self.error = error.localizedDescription
                return nil
            }
        }
        return attempt {
            switch format {
            case .png: return PaintExportFile(format: .png, bytes: Data(try controller.exportPng()))
            case .psd: return PaintExportFile(format: .psd, bytes: Data(try controller.exportPsd().bytes))
            }
        }
    }

    /// Fits the canvas in the viewport once per canvas size (`fitOnMount`).
    public func fitOnce() {
        let c = controller.doc.canvas
        let key = "\(c.width)x\(c.height)"
        if fitted == key || viewport.width <= 0 { return }
        fitted = key
        fitView()
    }

    public func fitView() {
        _ = controller.setView(zoom: fitZoom(controller.doc.canvas, viewport: viewport.width, viewport.height), pan: (0, 0))
    }

    public func rotateView(by degrees: Double) { _ = controller.setView(rotation: controller.view.rotation + degrees) }
    public func toggleMirror() { _ = controller.setView(mirror: !controller.view.mirror) }
    public func resetView() { _ = controller.resetView() }
    public func toggleHand() { attempt { _ = try controller.setHand(controller.hand == "right" ? "left" : "right") } }

    public func setSymmetry(_ mode: String) {
        let c = controller.doc.canvas
        var update: JSONObject = ["mode": .string(mode)]
        if controller.guides.symmetry.mode == "off" { update["center"] = ["x": .number(Double(c.width) / 2), "y": .number(Double(c.height) / 2)] }
        _ = controller.setSymmetry(update)
    }

    // MARK: - Brush

    public func selectBrush(_ id: String) { attempt { _ = try controller.setBrushFacets([:], id: id) } }

    /// The value a brush option row shows (in the brush's own units).
    public func brushOption(_ item: PaintUIBrushOptionsItem) -> Double {
        track()
        return PAINT_BRUSH_OPTION_PATHS[item.id]?.read(controller.brush) ?? item.default
    }

    /// Sets a brush option (`set_brush` with that facet; editor state, not an undo step).
    public func setBrushOption(_ item: PaintUIBrushOptionsItem, _ value: Double) {
        guard let facet = PAINT_BRUSH_OPTION_PATHS[item.id]?.facet else { return }
        attempt { _ = try controller.setBrushFacets(patchPath([:], facet, .number(value))) }
    }

    /// Steps the brush size by 15 % (`[` and `]`).
    public func stepBrushSize(larger: Bool) {
        let size = controller.brush.tip.size
        let step = Swift.max(1, (size * 0.15).rounded())
        attempt { _ = try controller.setBrushFacets(["tip": ["size": .number(Swift.max(1, size + (larger ? step : -step)))]]) }
    }

    // MARK: - Colour

    public func setColor(_ hex: String) { attempt { _ = try controller.setColor(hex) } }
    public func setSecondaryColor(_ hex: String) { attempt { _ = try controller.setSecondaryColor(hex) } }
    public func swapColors() { controller.swapColors() }
    public func setColorLocked(_ on: Bool) { controller.setColorLocked(on) }
    public func addSwatch() { attempt { _ = try controller.addSwatch(.string(controller.color), name: nil) } }
    public func removeSwatch(_ index: Int) { attempt { _ = try controller.removeSwatch(index) } }

    // MARK: - Paper

    public func setPaperPreset(_ id: String) { attempt { _ = try controller.setPaper(["preset": .string(id)]) } }
    public func setPaperColor(_ hex: String) { attempt { _ = try controller.setPaper(["color": .string(hex)]) } }
    public func paperValue(_ path: String) -> Double { track(); return readPath(controller.doc.paper.json, path) }
    /// Sets a paper slider (one undo step: call it when the drag ends).
    public func setPaperValue(_ path: String, _ value: Double) { attempt { _ = try controller.setPaper(patchPath(controller.doc.paper.json, path, .number(value))) } }
    public func newSheet() { attempt { _ = try controller.setPaper(["seed": .number(Double(controller.doc.paper.seed + 1))]) } }

    // MARK: - Light (thick paint, metallic paper)

    /// The light sliders (`PaintUITables.sliders.light`): direction, height and relief.
    public var lightSliders: [PaintUISlidersLightItem] { tables.sliders.light }
    public var lighting: PaintLighting { track(); return controller.lighting }
    public func lightingValue(_ path: String) -> Double { readPath(lighting.json.objectValue ?? [:], path) }
    /// Moves the light (not an undo step: thick paint and metallic paper are relit).
    public func setLighting(_ path: String, _ value: Double) {
        attempt { _ = try controller.setLighting(azimuth: path == "azimuth" ? value : nil, elevation: path == "elevation" ? value : nil, relief: path == "relief" ? value : nil) }
    }
    /// Flattens the active layer's relief (one undo step).
    public func flattenRelief() { attempt { _ = try controller.flattenRelief() } }

    /// The active layer's light paint (`get_light`): whether it has any and its spill.
    public var activeLight: (hasLight: Bool, radius: Double, strength: Double)? {
        track()
        guard let o = try? controller.lightOf(), let spill = o["spill"]?.objectValue else { return nil }
        return (o["hasLight"] == .bool(true), spill["radius"]?.numberValue ?? 0, spill["strength"]?.numberValue ?? 0)
    }
    /// Sets the active layer's light spill (saved with the painting, not an undo step).
    public func setLightSpill(radius: Double? = nil, strength: Double? = nil) { attempt { _ = try controller.setLightSpill(nil, radius: radius, strength: strength) } }
    /// Takes the active layer's light away (one undo step).
    public func clearLight() { attempt { _ = try controller.clearLight() } }

    // MARK: - Wet media

    /// The wet-paint sliders (`PaintUITables.sliders`): the layer's settings, the tilt and the speed.
    public var wetSliders: [PaintUISlidersWetItem] { tables.sliders.wet }
    public var wetTiltSliders: [PaintUISlidersWetTiltItem] { tables.sliders.wetTilt }
    public var wetSpeedSlider: PaintUISlidersWetSpeed { tables.sliders.wetSpeed }
    /// The engine choices (`PaintUITables.wetGpu`).
    public var wetGpuOptions: [PaintUIWetGpuItem] { tables.wetGpu }
    /// Wet media as the panel shows it (`getState().wet`).
    public var wet: PaintWetLayers { track(); return controller.wet }
    public var wetClock: Int { _ = revision; return controller.wet.world?.clock ?? 0 }
    /// The active layer's wet settings and state, or nil without an active pixel layer.
    public var wetLayer: WetLayerInfo? { _ = revision; return try? controller.wetLayerInfo() }
    /// The active layer's wet settings without scanning live tile statistics.
    public var wetLayerSettings: WetLayerSettings? { track(); return controller.wetLayerSettings() }
    /// A wet setting of the active layer (`WetParams` key).
    public func wetParam(_ path: String) -> Double { wetLayerSettings?.params[path] ?? DEFAULT_WET_PARAMS[path] }
    public func setWetParam(_ path: String, _ value: Double) { attempt { _ = try controller.setWetParams(nil, [path: .number(value)]) } }
    public func setFlowKind(_ kind: String) { attempt { _ = try controller.setFlowMap(nil, ["kind": .string(kind)]) } }
    public func setFlowStrength(_ value: Double) { attempt { _ = try controller.setFlowMap(nil, ["strength": .number(value)]) } }
    public func tiltValue(_ path: String) -> Double { readPath(wet.tilt.json.objectValue ?? [:], path) }
    public func setTilt(_ path: String, _ value: Double) {
        attempt { _ = try controller.setCanvasTilt(angle: path == "angle" ? value : nil, direction: path == "direction" ? value : nil) }
    }
    public func setWetSpeed(_ value: Double) { attempt { try controller.setWetSpeed(value) } }
    public func toggleWetPaused() { controller.setWetPaused(!controller.wet.paused) }
    public func toggleWaterOverlay() { controller.setWaterOverlay(!controller.wet.overlay) }
    public func toggleInstantDry() { controller.setInstantDry(!controller.wet.instantDry) }
    /// Dries every wet layer now (one undo step).
    public func dryNow() { attempt { _ = try controller.dryPaint() } }
    /// Wets the active layer's paper (one undo step).
    public func wetPaper() { attempt { _ = try controller.wetPaper() } }
    public func setWetEngine(_ gpu: String) { attempt { _ = try controller.setWetEngine(gpu: gpu, minTiles: nil) } }
    /// What the engine is doing, in a sentence (`wetEngineSummary`).
    public var wetEngineSummary: String {
        let e = wet.engineInfo()
        return e.reason ?? "CPU engine."
    }

    /**
     * Lets wet paint flow with the clock (`tickWet`): call it every frame with the time in ms. It
     * steps at the wet speed unless paused or dry; the canvas then redraws only the tiles whose wet
     * paint changed. Returns the steps run.
     */
    @discardableResult
    public func tick(now: Double, maxSteps: Int = 8) -> Int {
        let wasWet = controller.wet.isWet()
        let wetIdsBefore = controller.wet.wetLayerIds()
        let gpuBefore = controller.wet.world?.gpuActive
        isQuietFrameChange = true
        let ran = controller.tickWet(now, maxSteps: maxSteps)
        isQuietFrameChange = false
        if controller.wet.isWet() != wasWet || controller.wet.wetLayerIds() != wetIdsBefore || controller.wet.world?.gpuActive != gpuBefore {
            stateRevision &+= 1
        }
        return ran
    }

    /// Ticks the wet simulation about 60 times a second until the task is cancelled (the editor view runs it).
    public func runWetClock() async {
        var stepBudget = 8
        while !Task.isCancelled {
            let start = Date().timeIntervalSinceReferenceDate * 1000
            let cap = controller.activeStroke != nil ? Swift.min(stepBudget, 2) : stepBudget
            let ran = tick(now: start, maxSteps: cap)
            let elapsed = Date().timeIntervalSinceReferenceDate * 1000 - start
            if ran > 0 {
                if elapsed > 14 {
                    stepBudget = Swift.max(1, ran - 1)
                } else if elapsed < 8 && stepBudget < 8 {
                    stepBudget += 1
                }
            }
            let sleepMs = Swift.max(4.0, 16.0 - elapsed)
            try? await Task.sleep(nanoseconds: UInt64(sleepMs * 1_000_000))
        }
    }

    /// The water overlay over the canvas (RGBA tiles, straight alpha), when it is shown.
    public var waterOverlayTiles: [(tx: Int, ty: Int, data: [UInt8])] {
        _ = revision
        guard controller.wet.overlay else { return [] }
        let c = controller.doc.canvas
        return controller.waterOverlayTiles(RasterRect(x: 0, y: 0, width: c.width, height: c.height))
    }

    // MARK: - Layers

    public func addLayer(type: String? = nil) { attempt { _ = try controller.addLayer(type: type) } }
    public func setActiveLayer(_ id: String) {
        attempt { try controller.setActiveLayer(id) }
        selectedStroke = nil
        selectedEffect = nil
    }
    public func duplicateLayer() { if let a = activeLayer { attempt { _ = try controller.duplicateLayer(a.id) } } }
    public func mergeDown() { if let a = activeLayer { attempt { _ = try controller.mergeDown(a.id) } } }
    /// Deletes the active layer; the panel keeps the last one (its Delete button is disabled then).
    public func removeLayer() {
        let all = layers
        guard let a = all.first(where: \.active) else { return }
        if all.count < 2 {
            error = "This is the only layer; add another before deleting it."
            return
        }
        attempt { _ = try controller.removeLayer(a.id) }
    }
    /// Moves the active layer up (+1) or down (-1) among its siblings.
    public func moveLayer(_ delta: Int) {
        let all = layers
        guard let a = all.first(where: \.active) else { return }
        let sibs = Array(all.filter { $0.parentId == a.parentId }.reversed())
        guard let index = sibs.firstIndex(where: { $0.id == a.id }) else { return }
        let to = Swift.min(sibs.count - 1, Swift.max(0, index + delta))
        if to != index { attempt { _ = try controller.moveLayer(a.id, to) } }
    }
    public func updateLayer(_ id: String, _ update: JSONObject) { attempt { _ = try controller.updateLayer(id, update) } }
    public func toggleVisible(_ l: PaintLayerInfo) { updateLayer(l.id, ["visible": .bool(!l.visible)]) }

    // MARK: - Strokes of a stroke layer

    public func updateSelectedStroke(brushId: String? = nil, brushChanges: JSONObject? = nil, color: String? = nil, seed: Double? = nil) {
        guard let id = selectedStroke else { return }
        attempt { _ = try controller.updateStroke(id, brushId: brushId, brushChanges: brushChanges, color: color, paint: nil, seed: seed) }
    }
    public func reorderSelectedStroke(_ index: Int) {
        guard let id = selectedStroke else { return }
        attempt { _ = try controller.reorderStroke(id, index) }
    }
    public func removeSelectedStroke() {
        guard let id = selectedStroke else { return }
        attempt { _ = try controller.removeStrokes([id]) }
        selectedStroke = nil
    }
    public func rasterizeStrokes() { attempt { _ = try controller.rasterizeLiveStrokes(nil) } }

    // MARK: - Layer styles

    public func addEffect(_ kind: String) {
        guard let id = controller.doc.activeLayerId else { return }
        if let e = attempt({ try controller.addLayerEffect(id, kind, [:], index: nil) }) { selectedEffect = e.id }
    }
    public func removeEffect(_ effectId: String) {
        guard let id = controller.doc.activeLayerId else { return }
        attempt { try controller.removeLayerEffect(id, effectId) }
        if selectedEffect == effectId { selectedEffect = nil }
    }
    /// Sets one control of a style (`effectControlChange`; one undo step).
    public func setEffectControl(_ effect: LayerEffect, _ key: String, _ value: JSONValue) {
        guard let id = controller.doc.activeLayerId else { return }
        attempt { try controller.updateLayerEffect(id, effect.id, effectControlChange(effect, key, value)) }
    }
    public func setEffectsEnabled(_ on: Bool) {
        guard let id = controller.doc.activeLayerId else { return }
        attempt { try controller.setLayerEffectsEnabled(id, on, scale: nil) }
    }

    // MARK: - Export

    /// The painting as PNG bytes (`export_png`).
    public func exportPng() -> Data? { attempt { Data(try controller.exportPng()) } }

    // MARK: - Keyboard

    /**
     * Runs the keyboard command for a key press (`handlePaintShortcut`); returns true when it
     * handled the key. `key` is the character, or a name like `Escape`.
     */
    @discardableResult
    public func handleKey(_ key: String, mod: Bool = false, shift: Bool = false) -> Bool {
        guard let command = paintShortcutFor(commands, key: key, mod: mod, shift: shift) else { return false }
        return run(command)
    }

    /// Runs a keyboard command by id (`PaintCommandID`).
    @discardableResult
    public func run(_ command: ShortcutCommand) -> Bool {
        guard let id = PaintCommandID(rawValue: command.id) else { return false }
        switch id {
        case .undo: undo()
        case .redo: redo()
        case .toolBrush, .toolEyedropper, .toolSticker, .toolStroke, .toolPan, .toolRotate:
            let t = String(command.id.dropFirst(5))
            guard PAINT_UI_TOOLS.contains(t) else { return false }
            tool = t
        case .brushSmaller: stepBrushSize(larger: false)
        case .brushLarger: stepBrushSize(larger: true)
        case .colourSwap: swapColors()
        case .viewMirror: toggleMirror()
        case .viewReset: resetView()
        }
        return true
    }
}

/// File types the editor exports.
public enum PaintExportFormat: String, CaseIterable, Sendable {
    case png
    case psd

    public var contentType: UTType { self == .png ? .png : UTType("com.adobe.photoshop-image") ?? .data }
}

/// An exported painting, for `fileExporter`.
public struct PaintExportFile: FileDocument {
    public static var readableContentTypes: [UTType] { [] }
    public static var writableContentTypes: [UTType] { PaintExportFormat.allCases.map(\.contentType) }
    public let format: PaintExportFormat
    public let bytes: Data

    public init(format: PaintExportFormat, bytes: Data) {
        self.format = format
        self.bytes = bytes
    }

    public init(configuration: ReadConfiguration) throws { throw CocoaError(.fileReadUnsupportedScheme) }

    public func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: bytes) }
}
