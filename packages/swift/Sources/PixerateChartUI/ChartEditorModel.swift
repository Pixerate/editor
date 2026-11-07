import Foundation
import Observation
import PixerateChart
import PixerateCore
import PixerateRaster
import SwiftUI

/// The chart editor's observable view model (`useChartEditor` + inspector and canvas handlers):
/// owns the `ChartController`, `CommandRegistry` and `ToolRegistry` (with `createChartToolProvider`
/// including CoreGraphics PNG rasterization, `createChartStyleToolProvider`,
/// `createOfficeChartToolProvider`, and `createCommandToolProvider` for `createChartCommands`),
/// and bumps `revision` whenever the user or an agent edits the chart.
@MainActor
@Observable
public final class ChartEditorModel {
    public let controller: ChartController
    public let registry: ToolRegistry
    public let commands: CommandRegistry<ChartController>
    public let ui: ChartUITables
    public let styleResolver: ChartStyleResolver
    public let displayTicker: ChartDisplayTicker

    /// Bumped after every change to the chart, selection, race playback, hover, or drag.
    public private(set) var revision: Int = 0
    /// Canvas viewport size in points.
    public var viewport: (width: Double, height: Double) = (640, 400) {
        didSet {
            if viewport.width != oldValue.width || viewport.height != oldValue.height {
                revision &+= 1
            }
        }
    }
    /// Current pointer hover position in scene coordinates, if any.
    public private(set) var hoverPoint: (x: Double, y: Double)? = nil
    /// Tooltip mode (`category` or `point`).
    public var tooltipMode: ChartTooltipMode = .category {
        didSet { updateTooltip() }
    }
    /// Active hover tooltip (hidden while dragging a point).
    public private(set) var tooltip: ChartTooltip? = nil
    /// Active drag readout target shown while dragging a point.
    public private(set) var dragReadout: ChartPointReadout? = nil
    /// Last user-visible error message from an action, or `nil`.
    public var error: String? = nil

    @ObservationIgnored private var activeDrag: ChartPointDrag? = nil
    @ObservationIgnored private var subscriptions: [Cancellable] = []

    public init(
        controller: ChartController? = nil,
        registry: ToolRegistry? = nil,
        styleResolver: ChartStyleResolver? = nil,
        displayTicker: ChartDisplayTicker = ChartDisplayTicker(),
        measureText: @escaping ChartTextMeasure = coreTextChartMeasureText,
        width: Double = 640,
        height: Double = 400
    ) throws {
        registerChartMap(EUROPE_CHART_MAP)
        self.displayTicker = displayTicker
        self.viewport = (width, height)
        let defaultSpec: JSONValue = [
            "type": "bar",
            "title": "Quarterly Revenue",
            "subtitle": "FY 2025 ($M)",
            "categories": ["Q1", "Q2", "Q3", "Q4"],
            "series": [
                ["id": "s1", "name": "Cloud", "values": [42, 58, 67, 84]],
                ["id": "s2", "name": "Enterprise", "values": [35, 39, 44, 51]]
            ]
        ]
        let c = controller ?? ChartController(
            ChartControllerOptions(
                spec: defaultSpec,
                raceTicker: displayTicker.raceTicker,
                measureText: measureText
            )
        )
        self.controller = c
        let r = registry ?? ToolRegistry()
        self.registry = r
        let s = styleResolver ?? ChartStyleResolver()
        self.styleResolver = s
        self.ui = try ChartContracts.ui()
        let cmds = CommandRegistry(context: c, history: c.history)
        try cmds.register(createChartCommands(c))
        self.commands = cmds

        subscriptions.append(try r.register(createChartToolProvider(
            c,
            ChartToolProviderOptions(
                namespace: "",
                width: width,
                height: height,
                rasterize: makeChartCoreGraphicsRasterizer(c)
            )
        )))
        subscriptions.append(try r.register(createChartStyleToolProvider(
            c,
            s,
            ChartStyleToolProviderOptions(namespace: "")
        )))
        subscriptions.append(try r.register(createOfficeChartToolProvider(
            OfficeChartToolProviderOptions(namespace: "", hasFiles: true, controller: c)
        )))
        subscriptions.append(try r.register(createCommandToolProvider(
            cmds,
            CommandToolProviderOptions(id: "chart-commands", namespace: "")
        )))
        subscriptions.append(c.subscribe { [weak self] _ in
            MainActor.assumeIsolated {
                self?.changed()
            }
        })
    }

    private func changed() {
        revision &+= 1
        if let issues = controller.getState().issues.first {
            error = issues.message
        } else {
            error = nil
        }
        updateTooltip()
    }

    private func track() {
        _ = revision
    }

    @discardableResult
    public func check(_ result: ChartActionResult) -> Bool {
        if result.ok {
            error = nil
            return true
        } else {
            error = result.message
            return false
        }
    }

    // MARK: - State & Scene

    public var state: ChartState {
        track()
        return controller.getState()
    }

    public var spec: ChartSpec {
        track()
        return controller.getSpec()
    }

    public var selection: ChartSelection? {
        track()
        return controller.getState().selection
    }

    public var selectionDescription: String {
        track()
        return describeChartSelection(controller)
    }

    public var isDraggingPoint: Bool {
        track()
        return activeDrag != nil
    }

    /// Lays out the current chart at `viewport` size, keeping axis domains frozen during a point drag.
    public var scene: ChartScene {
        track()
        let st = controller.getState()
        return layoutChart(
            st.spec,
            ChartLayoutOptions(
                width: Swift.max(120, viewport.width),
                height: Swift.max(120, viewport.height),
                selection: st.selection,
                measureText: controller.measureText,
                valueDomain: activeDrag.map { ChartDomainBounds(min: $0.valueDomain.min, max: $0.valueDomain.max) },
                valueDomain2: activeDrag?.valueDomain2.map { ChartDomainBounds(min: $0.min, max: $0.max) },
                xDomain: activeDrag?.xDomain.map { ChartDomainBounds(min: $0.min, max: $0.max) },
                readout: dragReadout,
                raceFrame: st.raceFrame
            )
        )
    }

    // MARK: - Pointer & Keyboard Interaction

    public func hitTest(x: Double, y: Double) -> ChartSelection? {
        let sc = scene
        return chartHitTest(sc, (x: x, y: y), controller.measureText ?? estimateChartTextWidth)
    }

    @discardableResult
    public func clickAt(x: Double, y: Double) -> ChartSelection? {
        let target = hitTest(x: x, y: y)
        controller.select(target)
        return target
    }

    @discardableResult
    public func pointerDown(x: Double, y: Double) -> Bool {
        let sc = scene
        let target = chartHitTest(sc, (x: x, y: y), controller.measureText ?? estimateChartTextWidth)
        controller.select(target)
        if canDragChartPoint(controller, sc, target),
           let drag = startChartPointDrag(controller, sc, target, (x: x, y: y)) {
            activeDrag = drag
            tooltip = nil
            updateDragReadout(x: x, y: y, target: drag.target)
            revision &+= 1
            return true
        }
        return target != nil
    }

    public func pointerMove(
        x: Double,
        y: Double,
        fine: Bool = false,
        lockAxis: Bool = false,
        noSnap: Bool = false
    ) {
        if let drag = activeDrag {
            drag.move((x: x, y: y), ChartDragMoveOptions(fine: fine, lockAxis: lockAxis, noSnap: noSnap))
            updateDragReadout(x: x, y: y, target: drag.target)
            revision &+= 1
            return
        }
        hoverPoint = (x: x, y: y)
        updateTooltip()
    }

    public func pointerUp() {
        guard let drag = activeDrag else { return }
        drag.end()
        activeDrag = nil
        dragReadout = nil
        updateTooltip()
        revision &+= 1
    }

    public func pointerCancel() {
        guard let drag = activeDrag else { return }
        drag.cancel()
        activeDrag = nil
        dragReadout = nil
        revision &+= 1
    }

    public func pointerLeave() {
        guard hoverPoint != nil || tooltip != nil else { return }
        hoverPoint = nil
        tooltip = nil
        revision &+= 1
    }

    private func updateDragReadout(x: Double, y: Double, target: (seriesId: String, index: Int)) {
        dragReadout = ChartPointReadout(seriesId: target.seriesId, index: target.index)
    }

    private func updateTooltip() {
        guard activeDrag == nil, let pt = hoverPoint else {
            tooltip = nil
            return
        }
        let sc = scene
        let next = chartTooltipAt(
            controller.getSpec(),
            sc,
            pt,
            ChartTooltipOptions(mode: tooltipMode, measureText: controller.measureText)
        )
        if !sameChartTooltip(tooltip, next) || tooltip?.x != next?.x || tooltip?.y != next?.y {
            tooltip = next
            revision &+= 1
        }
    }

    @discardableResult
    public func handleKey(_ key: String, shift: Bool = false, alt: Bool = false, mod: Bool = false) -> Bool {
        if mod {
            let lower = key.lowercased()
            if lower == "z" {
                return shift ? controller.redo() : controller.undo()
            }
            if lower == "y" && !shift {
                return controller.redo()
            }
            return false
        }
        return handleChartKey(
            controller,
            scene,
            ChartKeyInput(key: key, shiftKey: shift, altKey: alt, metaKey: false, ctrlKey: false)
        )
    }
}

extension ChartEditorModel {
    // MARK: - Inspector & Toolbar Actions

    @discardableResult
    public func setType(_ type: ChartType) -> Bool {
        check(controller.setType(type))
    }

    @discardableResult
    public func setTitle(_ title: String) -> Bool {
        check(controller.setTitle(title))
    }

    @discardableResult
    public func setSubtitle(_ subtitle: String) -> Bool {
        check(controller.setSubtitle(subtitle))
    }

    @discardableResult
    public func applyLayoutPreset(_ id: String) -> Bool {
        check(controller.applyPreset(layout: id))
    }

    @discardableResult
    public func applyColorScheme(_ id: String) -> Bool {
        check(controller.applyPreset(colors: id))
    }

    @discardableResult
    public func applyPaletteShade(_ shade: Double) -> Bool {
        let current = controller.getSpec().palette
        let shaded = current.map { shadeChartColor($0, shade) }
        return check(controller.update(
            JSONObject([("palette", .array(shaded.map(JSONValue.string)))]),
            options: ChartEditOptions(label: "Change colours")
        ))
    }

    @discardableResult
    public func setLegend(show: Bool? = nil, position: ChartLegendPosition? = nil) -> Bool {
        var patch = JSONObject()
        if let show { patch["show"] = .bool(show) }
        if let position { patch["position"] = .string(position.rawValue) }
        return check(controller.setLegend(patch))
    }

    @discardableResult
    public func setGridlines(axis: ChartSelectionAxis, enabled: Bool) -> Bool {
        check(controller.setAxis(axis, JSONObject([("gridlines", .bool(enabled))])))
    }

    @discardableResult
    public func setAxisScale(axis: ChartSelectionAxis, scale: ChartAxisScale) -> Bool {
        check(controller.setAxis(axis, JSONObject([("scale", .string(scale.rawValue))])))
    }

    @discardableResult
    public func setDataLabels(_ enabled: Bool) -> Bool {
        check(controller.update(JSONObject([("dataLabels", .bool(enabled))])))
    }

    @discardableResult
    public func setLabelPosition(_ pos: ChartLabelPosition) -> Bool {
        check(controller.update(JSONObject([("labelPosition", .string(pos.rawValue))])))
    }

    @discardableResult
    public func setPoints(_ enabled: Bool) -> Bool {
        check(controller.update(JSONObject([("points", .bool(enabled))])))
    }

    @discardableResult
    public func setStacking(_ stacking: ChartStacking) -> Bool {
        check(controller.update(JSONObject([("stacking", .string(stacking.rawValue))])))
    }

    @discardableResult
    public func setOrientation(_ orientation: ChartOrientation) -> Bool {
        check(controller.update(JSONObject([("orientation", .string(orientation.rawValue))])))
    }

    @discardableResult
    public func setCurve(_ curve: ChartCurve) -> Bool {
        check(controller.update(JSONObject([("curve", .string(curve.rawValue))])))
    }

    @discardableResult
    public func setSeriesErrorBars(
        seriesId: String,
        type: ChartErrorBarType?,
        value: Double = 10,
        direction: ChartErrorBarDirection = .both
    ) -> Bool {
        guard let type else {
            return check(controller.updateSeries(seriesId, JSONObject([("errorBars", .null)])))
        }
        var eb = JSONObject([
            ("type", .string(type.rawValue)),
            ("direction", .string(direction.rawValue)),
            ("cap", .bool(true))
        ])
        if type == .fixed || type == .percent {
            eb["value"] = .number(value)
        }
        return check(controller.updateSeries(seriesId, JSONObject([("errorBars", .object(eb))])))
    }

    @discardableResult
    public func toggleRacePlayback(msPerStep: Double = 600) -> Bool {
        if controller.getState().racePlaying {
            controller.pauseRace()
            return true
        } else {
            return check(controller.playRace(msPerStep: msPerStep))
        }
    }

    @discardableResult
    public func setRaceFrame(_ frame: Double?) -> Bool {
        check(controller.setRaceFrame(frame))
    }

    @discardableResult
    public func undo() -> Bool {
        controller.undo()
    }

    @discardableResult
    public func redo() -> Bool {
        controller.redo()
    }

    public func exportSvg(width: Double? = nil, height: Double? = nil) -> String {
        let w = width ?? viewport.width
        let h = height ?? viewport.height
        let s = controller.toJSON()
        return chartToSvg(
            s,
            width: w,
            height: h,
            measureText: controller.measureText,
            raceFrame: controller.getState().raceFrame,
            ariaLabel: s.title.isEmpty ? nil : s.title,
            description: describeChart(s)
        )
    }

    public func exportMermaid(meta: Bool = true) -> String {
        chartToMermaid(controller.toJSON(), ChartMermaidOptions(meta: meta))
    }

    public func rasterizePng(
        width: Double? = nil,
        height: Double? = nil,
        scale: Double = 2
    ) throws -> ChartRasterImage {
        let w = width ?? viewport.width
        let h = height ?? viewport.height
        let s = controller.toJSON()
        let sc = layoutChart(
            s,
            ChartLayoutOptions(
                width: w,
                height: h,
                selection: nil,
                measureText: controller.measureText,
                raceFrame: controller.getState().raceFrame
            )
        )
        return try rasterizeChartScene(sc, scale: scale)
    }
}
