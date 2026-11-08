import Foundation
import PixerateCore

public let CHART_DOCUMENT_TYPE = "chart"
public let CHART_SPEC_VERSION = 1

public struct ChartEditorError: Error, LocalizedError, Equatable, Sendable {
    public var message: String
    public init(_ message: String) {
        self.message = message
    }
    public var errorDescription: String? { message }
}

typealias ToolExecutionError = ChartEditorError

public struct ChartRaceTicker: Sendable {
    public var now: @Sendable () -> Double
    public var next: @Sendable (@escaping @Sendable () -> Void) -> (@Sendable () -> Void)

    public init(
        now: @escaping @Sendable () -> Double,
        next: @escaping @Sendable (@escaping @Sendable () -> Void) -> (@Sendable () -> Void)
    ) {
        self.now = now
        self.next = next
    }

    public static let `default` = ChartRaceTicker(
        now: { Date().timeIntervalSince1970 * 1000.0 },
        next: { step in
            final class CancelledFlag: @unchecked Sendable { var cancelled = false }
            let flag = CancelledFlag()
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(16)) {
                if !flag.cancelled { step() }
            }
            return { flag.cancelled = true }
        }
    )
}

public struct ChartState: Sendable, Equatable {
    public var spec: ChartSpec
    public var selection: ChartSelection?
    public var selectedSeries: ChartSeries?
    public var selectedIndex: Int?
    public var issues: [ChartIssue]
    public var gesture: String?
    public var canUndo: Bool
    public var canRedo: Bool
    public var undoLabel: String
    public var redoLabel: String
    public var raceFrame: Double?
    public var racePlaying: Bool
    public var revision: Int

    public init(
        spec: ChartSpec,
        selection: ChartSelection? = nil,
        selectedSeries: ChartSeries? = nil,
        selectedIndex: Int? = nil,
        issues: [ChartIssue] = [],
        gesture: String? = nil,
        canUndo: Bool = false,
        canRedo: Bool = false,
        undoLabel: String = "",
        redoLabel: String = "",
        raceFrame: Double? = nil,
        racePlaying: Bool = false,
        revision: Int = 0
    ) {
        self.spec = spec
        self.selection = selection
        self.selectedSeries = selectedSeries
        self.selectedIndex = selectedIndex
        self.issues = issues
        self.gesture = gesture
        self.canUndo = canUndo
        self.canRedo = canRedo
        self.undoLabel = undoLabel
        self.redoLabel = redoLabel
        self.raceFrame = raceFrame
        self.racePlaying = racePlaying
        self.revision = revision
    }
}

public struct ChartControllerOptions: @unchecked Sendable {
    public var spec: JSONValue?
    public var history: HistoryManager?
    public var onChange: (@Sendable (ChartSpec) -> Void)?
    public var raceTicker: ChartRaceTicker?
    public var measureText: ChartTextMeasure?

    public init(
        spec: JSONValue? = nil,
        history: HistoryManager? = nil,
        onChange: (@Sendable (ChartSpec) -> Void)? = nil,
        raceTicker: ChartRaceTicker? = nil,
        measureText: ChartTextMeasure? = nil
    ) {
        self.spec = spec
        self.history = history
        self.onChange = onChange
        self.raceTicker = raceTicker
        self.measureText = measureText
    }

    public init(
        spec: ChartSpec,
        history: HistoryManager? = nil,
        onChange: (@Sendable (ChartSpec) -> Void)? = nil,
        raceTicker: ChartRaceTicker? = nil,
        measureText: ChartTextMeasure? = nil
    ) {
        self.spec = spec.toJSON()
        self.history = history
        self.onChange = onChange
        self.raceTicker = raceTicker
        self.measureText = measureText
    }
}

public struct ChartActionResult: Error, Sendable {
    public var ok: Bool
    public var message: String?
    public var issues: [ChartIssue]?
    public var id: String?
    public var index: Int?
    public var path: [String]?
    public var categories: [Int]?
    public var series: [String]?
    public var fit: ChartTrendFit?

    public init(
        ok: Bool,
        message: String? = nil,
        issues: [ChartIssue]? = nil,
        id: String? = nil,
        index: Int? = nil,
        path: [String]? = nil,
        categories: [Int]? = nil,
        series: [String]? = nil,
        fit: ChartTrendFit? = nil
    ) {
        self.ok = ok
        self.message = message
        self.issues = issues
        self.id = id
        self.index = index
        self.path = path
        self.categories = categories
        self.series = series
        self.fit = fit
    }

    public static func success(
        issues: [ChartIssue]? = nil,
        id: String? = nil,
        index: Int? = nil,
        path: [String]? = nil,
        categories: [Int]? = nil,
        series: [String]? = nil,
        fit: ChartTrendFit? = nil
    ) -> ChartActionResult {
        ChartActionResult(
            ok: true,
            issues: issues,
            id: id,
            index: index,
            path: path,
            categories: categories,
            series: series,
            fit: fit
        )
    }

    public static func failure(_ message: String, issues: [ChartIssue]? = nil) -> ChartActionResult {
        ChartActionResult(ok: false, message: message, issues: issues)
    }
}

public struct ChartEditOptions: Sendable {
    public var label: String?
    public init(label: String? = nil) {
        self.label = label
    }
}

public final class ChartController: @unchecked Sendable {
    public let history: HistoryManager
    public let measureText: ChartTextMeasure?
    internal var spec: ChartSpec
    internal var selection: ChartSelection? = nil
    internal var issues: [ChartIssue] = []
    internal var gestureKey: String? = nil
    internal var gestureCount = 0
    internal var gestureStart: (spec: ChartSpec, mark: HistoryMark)? = nil
    internal var revision = 0
    internal var applying = false
    internal let onChange: (@Sendable (ChartSpec) -> Void)?
    internal let raceTicker: ChartRaceTicker
    internal var raceFrame: Double? = nil
    internal var raceStop: (@Sendable () -> Void)? = nil
    internal var listeners: [UUID: (ChartState) -> Void] = [:]
    internal var unsubscribeHistory: Cancellable?
    public internal(set) var state: ChartState

    public init(_ options: ChartControllerOptions = ChartControllerOptions()) {
        self.history = options.history ?? HistoryManager()
        self.measureText = options.measureText
        self.onChange = options.onChange
        self.raceTicker = options.raceTicker ?? .default
        let normalized = normalizeChartSpec(options.spec ?? .object(JSONObject()))
        self.spec = normalized.spec
        self.issues = normalized.issues
        self.state = ChartState(spec: normalized.spec, issues: normalized.issues)
        self.state = computeState()
        connect()
    }

    internal func connect() {
        unsubscribeHistory?.cancel()
        unsubscribeHistory = history.subscribe { [weak self] h in
            guard let self else { return }
            let s = self.state
            if self.applying || (s.canUndo == h.canUndo && s.canRedo == h.canRedo && s.undoLabel == h.undoName && s.redoLabel == h.redoName) {
                return
            }
            self.notify(specChanged: false)
        }
    }

    public func getState() -> ChartState {
        state
    }

    @discardableResult
    public func subscribe(_ listener: @escaping (ChartState) -> Void) -> Cancellable {
        if unsubscribeHistory == nil { connect() }
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in
            self?.listeners[id] = nil
        }
    }

    public func getSpec() -> ChartSpec {
        spec
    }

    public func getSeries(_ id: String) -> ChartSeries? {
        spec.series.first { $0.id == id }
    }

    internal func computeState() -> ChartState {
        let h = history.state
        let sel = selection
        let seriesId: String?
        switch sel {
        case .series(let id), .point(let id, _), .trendline(let id, _):
            seriesId = id
        default:
            seriesId = nil
        }
        let selectedIndex: Int?
        switch sel {
        case .point(_, let idx), .category(let idx):
            selectedIndex = idx
        default:
            selectedIndex = nil
        }
        let clampedRaceFrame: Double?
        if let rf = raceFrame {
            clampedRaceFrame = Swift.min(rf, Double(Swift.max(0, spec.categories.count - 1)))
        } else {
            clampedRaceFrame = nil
        }
        return ChartState(
            spec: spec,
            selection: sel,
            selectedSeries: seriesId.flatMap { id in spec.series.first { $0.id == id } },
            selectedIndex: selectedIndex,
            issues: issues,
            gesture: gestureKey,
            canUndo: h.canUndo,
            canRedo: h.canRedo,
            undoLabel: h.undoName,
            redoLabel: h.redoName,
            raceFrame: clampedRaceFrame,
            racePlaying: raceStop != nil,
            revision: revision
        )
    }

    internal func notify(specChanged: Bool) {
        revision += 1
        state = computeState()
        if specChanged { onChange?(spec) }
        let current = state
        for listener in listeners.values {
            listener(current)
        }
    }
}

public func createChartController(_ options: ChartControllerOptions = ChartControllerOptions()) -> ChartController {
    ChartController(options)
}

extension ChartController {
    internal func validSelection(_ sel: ChartSelection?, _ spec: ChartSpec) -> ChartSelection? {
        guard let sel else { return nil }
        switch sel {
        case .series(let seriesId):
            return spec.series.contains(where: { $0.id == seriesId }) ? sel : nil
        case .point(let seriesId, let index):
            return spec.series.contains(where: { $0.id == seriesId }) && index >= 0 && index < spec.categories.count ? sel : nil
        case .category(let index):
            return index >= 0 && index < spec.categories.count ? sel : nil
        case .trendline(let seriesId, let index):
            guard let t = spec.series.first(where: { $0.id == seriesId })?.trendlines else { return nil }
            return index >= 0 && index < t.count ? sel : nil
        case .title:
            return !spec.title.isEmpty ? sel : nil
        case .subtitle:
            return !spec.subtitle.isEmpty ? sel : nil
        default:
            return sel
        }
    }

    internal func applySpec(_ next: ChartSpec) {
        applying = true
        defer { applying = false }
        spec = next
        selection = validSelection(selection, next)
        notify(specChanged: true)
    }

    internal func commit(_ label: String, _ next: ChartSpec, select: ChartSelection?? = nil) {
        let before = spec
        let hadIssues = !issues.isEmpty
        issues = []
        if before == next {
            let reselect: Bool
            if let select {
                reselect = !sameChartSelection(selection, select) && !(select == nil && selection == nil)
                if reselect { selection = select }
            } else {
                reselect = false
            }
            if reselect || hadIssues { notify(specChanged: false) }
            return
        }
        let command = Command(
            name: label,
            tag: "chart",
            execute: { [weak self] in self?.applySpec(next) },
            undo: { [weak self] in self?.applySpec(before) },
            redo: { [weak self] in self?.applySpec(next) }
        )
        if let select { selection = select }
        if let gk = gestureKey {
            history.executeMerged(command, key: "chart.gesture:\(gk):\(gestureCount)")
        } else {
            history.execute(command)
        }
    }

    internal func reject(_ message: String, _ issuesList: [ChartIssue] = []) -> ChartActionResult {
        issues = issuesList.isEmpty ? [ChartIssue(path: "", message: message)] : issuesList
        notify(specChanged: false)
        return .failure(message, issues: issuesList.isEmpty ? nil : issuesList)
    }

    internal func edited(_ edit: (inout ChartSpec) -> Void) -> ChartSpec {
        var draft = cloneChartSpec(spec)
        edit(&draft)
        return draft
    }

    internal func unknownSeries(_ id: String) -> ChartActionResult {
        let ids = spec.series.map { "\"\($0.id)\"" }
        return .failure("There is no series \"\(id)\"; \(!ids.isEmpty ? "expected one of \(ids.joined(separator: ", "))" : "the chart has no series yet").")
    }

    internal func badIndex(_ index: Int) -> ChartActionResult {
        let n = spec.categories.count
        return .failure(n > 0 ? "Category index \(index) is out of range; expected 0 to \(n - 1)." : "The chart has no categories yet.")
    }

    // -------------------------------------------------------------------------
    // Presentation
    // -------------------------------------------------------------------------

    @discardableResult
    public func update(_ patch: JSONObject, options: ChartEditOptions = ChartEditOptions()) -> ChartActionResult {
        let s = spec
        guard case .object(var merged) = s.toJSON() else { return .success() }
        for (k, v) in patch {
            if (k == "xAxis" || k == "yAxis" || k == "yAxis2" || k == "legend"),
               case .object(let subPatch) = v,
               case .object(var existingSub) = merged[k] {
                for (sk, sv) in subPatch {
                    // `{ ...s.yAxis, ...patch.yAxis }` in TS: a new `format` replaces the old one whole.
                    if sv == .null && sk != "min" && sk != "max" && sk != "step" {
                        existingSub[sk] = nil
                    } else {
                        existingSub[sk] = sv
                    }
                }
                merged[k] = .object(existingSub)
            } else {
                merged[k] = v
            }
        }
        merged["version"] = .number(1)
        let normalized = normalizeChartSpec(.object(merged))
        if !normalized.issues.isEmpty {
            return reject(normalized.issues.map { $0.message }.joined(separator: " "), normalized.issues)
        }
        if normalized.spec == s { return .success() }
        commit(options.label ?? updateLabel(patch), normalized.spec)
        return .success()
    }

    @discardableResult
    public func setType(_ type: ChartType) -> ChartActionResult {
        update(JSONObject([("type", .string(type.rawValue))]), options: ChartEditOptions(label: "Change chart type"))
    }

    @discardableResult
    public func setTitle(_ title: String) -> ChartActionResult {
        update(JSONObject([("title", .string(title))]), options: ChartEditOptions(label: "Edit title"))
    }

    @discardableResult
    public func setSubtitle(_ subtitle: String) -> ChartActionResult {
        update(JSONObject([("subtitle", .string(subtitle))]), options: ChartEditOptions(label: "Edit subtitle"))
    }

    @discardableResult
    public func setAxis(_ axis: ChartSelectionAxis, _ patch: JSONObject) -> ChartActionResult {
        let key = axis == .x ? "xAxis" : axis == .y ? "yAxis" : "yAxis2"
        let axisName = axis == .x ? "category" : axis == .y ? "value" : "secondary value"
        return update(JSONObject([(key, .object(patch))]), options: ChartEditOptions(label: "Change \(axisName) axis"))
    }

    @discardableResult
    public func applyPreset(layout: String? = nil, colors: String? = nil) -> ChartActionResult {
        switch chartPresetPatch(layout: layout, colors: colors) {
        case .error(let msg):
            return reject(msg)
        case .ok(let patch):
            let label = (layout != nil && colors != nil) ? "Apply chart style" : (layout != nil ? "Apply quick layout" : "Change colours")
            return update(patch, options: ChartEditOptions(label: label))
        }
    }

    @discardableResult
    public func setLegend(_ patch: JSONObject) -> ChartActionResult {
        update(JSONObject([("legend", .object(patch))]), options: ChartEditOptions(label: "Change legend"))
    }

    // -------------------------------------------------------------------------
    // Persistence and history
    // -------------------------------------------------------------------------

    public func toJSON() -> ChartSpec {
        cloneChartSpec(spec)
    }

    @discardableResult
    public func load(_ input: JSONValue, clearHistory: Bool = false) -> [ChartIssue] {
        let normalized = normalizeChartSpec(input)
        spec = normalized.spec
        issues = normalized.issues
        selection = validSelection(selection, normalized.spec)
        if clearHistory {
            applying = true
            defer { applying = false }
            history.clear()
        }
        notify(specChanged: true)
        return normalized.issues
    }

    @discardableResult
    public func replace(_ input: JSONValue, options: ChartEditOptions = ChartEditOptions()) -> ChartActionResult {
        let normalized = normalizeChartSpec(input)
        if !normalized.issues.isEmpty {
            return reject(normalized.issues.map { $0.message }.joined(separator: " "), normalized.issues)
        }
        commit(options.label ?? "Replace chart", normalized.spec, select: .some(validSelection(selection, normalized.spec)))
        return .success()
    }

    @discardableResult
    public func undo() -> Bool {
        endGesture()
        return history.undo()
    }

    @discardableResult
    public func redo() -> Bool {
        endGesture()
        return history.redo()
    }

    public func beginGesture(_ key: String) {
        if gestureKey == key { return }
        history.endGesture()
        gestureKey = key
        gestureCount += 1
        gestureStart = (spec: spec, mark: history.mark())
        notify(specChanged: false)
    }

    public func cancelGesture() {
        guard gestureKey != nil else { return }
        let start = gestureStart
        gestureKey = nil
        gestureStart = nil
        history.endGesture()
        if let start { history.revertTo(start.mark) }
        notify(specChanged: false)
    }

    public func endGesture() {
        guard gestureKey != nil else { return }
        gestureKey = nil
        history.endGesture()
        let start = gestureStart
        gestureStart = nil
        if let start, start.spec == spec {
            history.revertTo(start.mark)
        }
        notify(specChanged: false)
    }

    public func destroy() {
        stopRace()
        unsubscribeHistory?.cancel()
        unsubscribeHistory = nil
        listeners.removeAll()
    }
}

private let UPDATE_LABELS: [String: String] = [
    "type": "Change chart type",
    "title": "Edit title",
    "subtitle": "Edit subtitle",
    "categories": "Edit categories",
    "series": "Edit series",
    "xAxis": "Change category axis",
    "yAxis": "Change value axis",
    "yAxis2": "Change secondary value axis",
    "labelPosition": "Change label position",
    "gapWidth": "Change bar spacing",
    "overlap": "Change bar overlap",
    "bins": "Change histogram bins",
    "showTotal": "Toggle waterfall total",
    "note": "Edit note",
    "highlight": "Change highlight",
    "referenceLines": "Change reference lines",
    "referenceBands": "Change reference bands",
    "varyColors": "Toggle colour by category",
    "likertNeutral": "Change neutral answer",
    "likertSort": "Sort questions",
    "parliamentArc": "Change hemicycle sweep",
    "parliamentMajority": "Change majority",
    "parliamentLabel": "Edit seat caption",
    "raceTopN": "Change bars shown",
    "map": "Change map",
    "mapSteps": "Change colour classes",
    "mapThresholds": "Change class breaks",
    "sunburstLabel": "Edit centre caption",
    "tree": "Replace grouped data",
    "links": "Replace flows",
    "sankeyNodes": "Reorder nodes",
    "sankeyLinkColor": "Change flow colours",
    "radarTicks": "Change radar rings",
    "radarGraticule": "Change radar grid",
    "legend": "Change legend",
    "stacking": "Change stacking",
    "orientation": "Change orientation",
    "curve": "Change line style",
    "points": "Toggle points",
    "dataLabels": "Toggle data labels",
    "palette": "Change colours",
    "innerRadius": "Change donut hole"
]

private func updateLabel(_ patch: JSONObject) -> String {
    guard patch.count == 1, let firstKey = patch.keys.first else { return "Change chart" }
    return UPDATE_LABELS[firstKey] ?? "Change chart"
}
