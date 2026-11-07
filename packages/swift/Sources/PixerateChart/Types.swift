import Foundation
import PixerateCore

extension JSONValue {
    internal var doubleValue: Double? { numberValue }
    internal var intValue: Int? {
        guard let n = numberValue, n.isFinite, floor(n) == n else { return nil }
        return Int(n)
    }
}

public enum ChartType: String, CaseIterable, Sendable, Equatable {
    case bar
    case line
    case area
    case scatter
    case bubble
    case pie
    case donut
    case radar
    case waterfall
    case histogram
    case box
    case funnel
    case treemap
    case sunburst
    case sankey
    case streamgraph
    case slope
    case likert
    case parliament
    case barrace
    case choropleth
}

public enum ChartSeriesType: String, CaseIterable, Sendable, Equatable {
    case bar
    case line
    case area
    case scatter
}

public enum ChartStacking: String, CaseIterable, Sendable, Equatable {
    case none
    case stacked
    case percent
}

public enum ChartOrientation: String, CaseIterable, Sendable, Equatable {
    case vertical
    case horizontal
}

public enum ChartCurve: String, CaseIterable, Sendable, Equatable {
    case linear
    case smooth
    case step
}

public enum ChartLegendPosition: String, CaseIterable, Sendable, Equatable {
    case top
    case bottom
    case left
    case right
}

public enum ChartMarker: String, CaseIterable, Sendable, Equatable {
    case circle
    case square
    case diamond
    case triangle
    case cross
    case none
}

public enum ChartLabelPosition: String, CaseIterable, Sendable, Equatable {
    case auto
    case inside
    case outside
    case center
}

public enum ChartRadarGraticule: String, CaseIterable, Sendable, Equatable {
    case polygon
    case circle
}

public enum ChartLikertNeutral: String, CaseIterable, Sendable, Equatable {
    case split
    case separate
}

public enum ChartLikertSort: String, CaseIterable, Sendable, Equatable {
    case none
    case positive
    case negative
}

public enum ChartSankeyLinkColor: String, CaseIterable, Sendable, Equatable {
    case source
    case target
    case gray
}

public enum ChartReferenceAxis: String, CaseIterable, Sendable, Equatable {
    case y
    case y2
    case x
}

public enum ChartNumberStyle: String, CaseIterable, Sendable, Equatable {
    case number
    case percent
    case currency
    case compact
}

public enum ChartAxisKind: String, CaseIterable, Sendable, Equatable {
    case category
    case date
}

public enum ChartAxisScale: String, CaseIterable, Sendable, Equatable {
    case linear
    case log
}

public enum ChartSeriesAxis: String, CaseIterable, Sendable, Equatable {
    case primary
    case secondary
}

public typealias ChartValue = Double?

public struct ChartNumberFormat: Sendable, Equatable {
    public var style: ChartNumberStyle?
    public var decimals: Int?
    public var currency: String?
    public var prefix: String?
    public var suffix: String?
    public var code: String?

    public init(
        style: ChartNumberStyle? = nil,
        decimals: Int? = nil,
        currency: String? = nil,
        prefix: String? = nil,
        suffix: String? = nil,
        code: String? = nil
    ) {
        self.style = style
        self.decimals = decimals
        self.currency = currency
        self.prefix = prefix
        self.suffix = suffix
        self.code = code
    }

    public var isEmpty: Bool {
        style == nil && decimals == nil && currency == nil && prefix == nil && suffix == nil && code == nil
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        if let style { obj["style"] = .string(style.rawValue) }
        if let decimals { obj["decimals"] = .number(Double(decimals)) }
        if let currency { obj["currency"] = .string(currency) }
        if let prefix { obj["prefix"] = .string(prefix) }
        if let suffix { obj["suffix"] = .string(suffix) }
        if let code { obj["code"] = .string(code) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.style = obj["style"]?.stringValue.flatMap(ChartNumberStyle.init(rawValue:))
        self.decimals = obj["decimals"]?.intValue
        self.currency = obj["currency"]?.stringValue
        self.prefix = obj["prefix"]?.stringValue
        self.suffix = obj["suffix"]?.stringValue
        self.code = obj["code"]?.stringValue
    }
}

public struct ChartAxis: Sendable, Equatable {
    public var show: Bool
    public var title: String
    public var min: Double?
    public var max: Double?
    public var step: Double?
    public var gridlines: Bool
    public var format: ChartNumberFormat
    public var kind: ChartAxisKind?
    public var scale: ChartAxisScale?
    public var logBase: Double?
    public var reverse: Bool?

    public init(
        show: Bool = true,
        title: String = "",
        min: Double? = nil,
        max: Double? = nil,
        step: Double? = nil,
        gridlines: Bool = false,
        format: ChartNumberFormat = ChartNumberFormat(),
        kind: ChartAxisKind? = nil,
        scale: ChartAxisScale? = nil,
        logBase: Double? = nil,
        reverse: Bool? = nil
    ) {
        self.show = show
        self.title = title
        self.min = min
        self.max = max
        self.step = step
        self.gridlines = gridlines
        self.format = format
        self.kind = kind
        self.scale = scale
        self.logBase = logBase
        self.reverse = reverse
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["show"] = .bool(show)
        obj["title"] = .string(title)
        obj["min"] = min.map(JSONValue.number) ?? .null
        obj["max"] = max.map(JSONValue.number) ?? .null
        obj["step"] = step.map(JSONValue.number) ?? .null
        obj["gridlines"] = .bool(gridlines)
        obj["format"] = format.toJSON()
        if let kind { obj["kind"] = .string(kind.rawValue) }
        if let scale { obj["scale"] = .string(scale.rawValue) }
        if let logBase { obj["logBase"] = .number(logBase) }
        if let reverse { obj["reverse"] = .bool(reverse) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.show = obj["show"]?.boolValue ?? true
        self.title = obj["title"]?.stringValue ?? ""
        self.min = obj["min"]?.doubleValue
        self.max = obj["max"]?.doubleValue
        self.step = obj["step"]?.doubleValue
        self.gridlines = obj["gridlines"]?.boolValue ?? false
        self.format = obj["format"].flatMap(ChartNumberFormat.init(json:)) ?? ChartNumberFormat()
        self.kind = obj["kind"]?.stringValue.flatMap(ChartAxisKind.init(rawValue:))
        self.scale = obj["scale"]?.stringValue.flatMap(ChartAxisScale.init(rawValue:))
        self.logBase = obj["logBase"]?.doubleValue
        self.reverse = obj["reverse"]?.boolValue
    }
}

public struct ChartLegend: Sendable, Equatable {
    public var show: Bool
    public var position: ChartLegendPosition

    public init(show: Bool = true, position: ChartLegendPosition = .bottom) {
        self.show = show
        self.position = position
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("show", .bool(show)),
            ("position", .string(position.rawValue))
        ]))
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.show = obj["show"]?.boolValue ?? true
        self.position = obj["position"]?.stringValue.flatMap(ChartLegendPosition.init(rawValue:)) ?? .bottom
    }
}

public enum ChartTrendlineType: String, CaseIterable, Sendable, Equatable {
    case linear
    case exponential
    case logarithmic
    case power
    case polynomial
    case movingAverage = "moving-average"
}

public struct ChartTrendline: Sendable, Equatable {
    public var type: ChartTrendlineType
    public var order: Int?
    public var period: Int?
    public var forward: Double?
    public var backward: Double?
    public var intercept: Double?
    public var showEquation: Bool?
    public var showR2: Bool?
    public var name: String?
    public var color: String?

    public init(
        type: ChartTrendlineType,
        order: Int? = nil,
        period: Int? = nil,
        forward: Double? = nil,
        backward: Double? = nil,
        intercept: Double? = nil,
        showEquation: Bool? = nil,
        showR2: Bool? = nil,
        name: String? = nil,
        color: String? = nil
    ) {
        self.type = type
        self.order = order
        self.period = period
        self.forward = forward
        self.backward = backward
        self.intercept = intercept
        self.showEquation = showEquation
        self.showR2 = showR2
        self.name = name
        self.color = color
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["type"] = .string(type.rawValue)
        if let order { obj["order"] = .number(Double(order)) }
        if let period { obj["period"] = .number(Double(period)) }
        if let forward { obj["forward"] = .number(forward) }
        if let backward { obj["backward"] = .number(backward) }
        if let intercept { obj["intercept"] = .number(intercept) }
        if let showEquation { obj["showEquation"] = .bool(showEquation) }
        if let showR2 { obj["showR2"] = .bool(showR2) }
        if let name { obj["name"] = .string(name) }
        if let color { obj["color"] = .string(color) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let typeStr = obj["type"]?.stringValue,
              let type = ChartTrendlineType(rawValue: typeStr) else { return nil }
        self.type = type
        self.order = obj["order"]?.intValue
        self.period = obj["period"]?.intValue
        self.forward = obj["forward"]?.doubleValue
        self.backward = obj["backward"]?.doubleValue
        self.intercept = obj["intercept"]?.doubleValue
        self.showEquation = obj["showEquation"]?.boolValue
        self.showR2 = obj["showR2"]?.boolValue
        self.name = obj["name"]?.stringValue
        self.color = obj["color"]?.stringValue
    }
}

public enum ChartErrorBarType: String, CaseIterable, Sendable, Equatable {
    case fixed
    case percent
    case stddev
    case stderr
    case custom
}

public enum ChartErrorBarDirection: String, CaseIterable, Sendable, Equatable {
    case both
    case plus
    case minus
}

public struct ChartErrorBars: Sendable, Equatable {
    public var type: ChartErrorBarType
    public var value: Double?
    public var plus: [ChartValue]?
    public var minus: [ChartValue]?
    public var direction: ChartErrorBarDirection?
    public var cap: Bool?

    public init(
        type: ChartErrorBarType,
        value: Double? = nil,
        plus: [ChartValue]? = nil,
        minus: [ChartValue]? = nil,
        direction: ChartErrorBarDirection? = nil,
        cap: Bool? = nil
    ) {
        self.type = type
        self.value = value
        self.plus = plus
        self.minus = minus
        self.direction = direction
        self.cap = cap
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["type"] = .string(type.rawValue)
        if let value { obj["value"] = .number(value) }
        if let plus { obj["plus"] = .array(plus.map { $0.map(JSONValue.number) ?? .null }) }
        if let minus { obj["minus"] = .array(minus.map { $0.map(JSONValue.number) ?? .null }) }
        if let direction { obj["direction"] = .string(direction.rawValue) }
        if let cap { obj["cap"] = .bool(cap) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let typeStr = obj["type"]?.stringValue,
              let type = ChartErrorBarType(rawValue: typeStr) else { return nil }
        self.type = type
        self.value = obj["value"]?.doubleValue
        self.plus = obj["plus"]?.arrayValue?.map { $0.doubleValue }
        self.minus = obj["minus"]?.arrayValue?.map { $0.doubleValue }
        self.direction = obj["direction"]?.stringValue.flatMap(ChartErrorBarDirection.init(rawValue:))
        self.cap = obj["cap"]?.boolValue
    }
}

public struct ChartSeries: Sendable, Equatable {
    public var id: String
    public var name: String
    public var values: [ChartValue]
    public var color: String?
    public var type: ChartSeriesType?
    public var hidden: Bool?
    public var axis: ChartSeriesAxis?
    public var x: [ChartValue]?
    public var sizes: [ChartValue]?
    public var pointColors: [String?]?
    public var callouts: [String?]?
    public var marker: ChartMarker?
    public var curve: ChartCurve?
    public var dataLabels: Bool?
    public var format: ChartNumberFormat?
    public var errorBars: ChartErrorBars?
    public var xErrorBars: ChartErrorBars?
    public var trendlines: [ChartTrendline]?

    public init(
        id: String,
        name: String,
        values: [ChartValue],
        color: String? = nil,
        type: ChartSeriesType? = nil,
        hidden: Bool? = nil,
        axis: ChartSeriesAxis? = nil,
        x: [ChartValue]? = nil,
        sizes: [ChartValue]? = nil,
        pointColors: [String?]? = nil,
        callouts: [String?]? = nil,
        marker: ChartMarker? = nil,
        curve: ChartCurve? = nil,
        dataLabels: Bool? = nil,
        format: ChartNumberFormat? = nil,
        errorBars: ChartErrorBars? = nil,
        xErrorBars: ChartErrorBars? = nil,
        trendlines: [ChartTrendline]? = nil
    ) {
        self.id = id
        self.name = name
        self.values = values
        self.color = color
        self.type = type
        self.hidden = hidden
        self.axis = axis
        self.x = x
        self.sizes = sizes
        self.pointColors = pointColors
        self.callouts = callouts
        self.marker = marker
        self.curve = curve
        self.dataLabels = dataLabels
        self.format = format
        self.errorBars = errorBars
        self.xErrorBars = xErrorBars
        self.trendlines = trendlines
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["id"] = .string(id)
        obj["name"] = .string(name)
        obj["values"] = .array(values.map { $0.map(JSONValue.number) ?? .null })
        if let color { obj["color"] = .string(color) }
        if let type { obj["type"] = .string(type.rawValue) }
        if let hidden { obj["hidden"] = .bool(hidden) }
        if let axis { obj["axis"] = .string(axis.rawValue) }
        if let x { obj["x"] = .array(x.map { $0.map(JSONValue.number) ?? .null }) }
        if let sizes { obj["sizes"] = .array(sizes.map { $0.map(JSONValue.number) ?? .null }) }
        if let pointColors { obj["pointColors"] = .array(pointColors.map { $0.map(JSONValue.string) ?? .null }) }
        if let callouts { obj["callouts"] = .array(callouts.map { $0.map(JSONValue.string) ?? .null }) }
        if let marker { obj["marker"] = .string(marker.rawValue) }
        if let curve { obj["curve"] = .string(curve.rawValue) }
        if let dataLabels { obj["dataLabels"] = .bool(dataLabels) }
        if let format { obj["format"] = format.toJSON() }
        if let errorBars { obj["errorBars"] = errorBars.toJSON() }
        if let xErrorBars { obj["xErrorBars"] = xErrorBars.toJSON() }
        if let trendlines { obj["trendlines"] = .array(trendlines.map { $0.toJSON() }) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let id = obj["id"]?.stringValue,
              let name = obj["name"]?.stringValue,
              let vals = obj["values"]?.arrayValue else { return nil }
        self.id = id
        self.name = name
        self.values = vals.map { $0.doubleValue }
        self.color = obj["color"]?.stringValue
        self.type = obj["type"]?.stringValue.flatMap(ChartSeriesType.init(rawValue:))
        self.hidden = obj["hidden"]?.boolValue
        self.axis = obj["axis"]?.stringValue.flatMap(ChartSeriesAxis.init(rawValue:))
        self.x = obj["x"]?.arrayValue?.map { $0.doubleValue }
        self.sizes = obj["sizes"]?.arrayValue?.map { $0.doubleValue }
        self.pointColors = obj["pointColors"]?.arrayValue?.map { $0.stringValue }
        self.callouts = obj["callouts"]?.arrayValue?.map { $0.stringValue }
        self.marker = obj["marker"]?.stringValue.flatMap(ChartMarker.init(rawValue:))
        self.curve = obj["curve"]?.stringValue.flatMap(ChartCurve.init(rawValue:))
        self.dataLabels = obj["dataLabels"]?.boolValue
        self.format = obj["format"].flatMap(ChartNumberFormat.init(json:))
        self.errorBars = obj["errorBars"].flatMap(ChartErrorBars.init(json:))
        self.xErrorBars = obj["xErrorBars"].flatMap(ChartErrorBars.init(json:))
        self.trendlines = obj["trendlines"]?.arrayValue?.compactMap(ChartTrendline.init(json:))
    }
}

public struct ChartReferenceLine: Sendable, Equatable {
    public var value: Double
    public var label: String?
    public var axis: ChartReferenceAxis?
    public var color: String?

    public init(value: Double, label: String? = nil, axis: ChartReferenceAxis? = nil, color: String? = nil) {
        self.value = value
        self.label = label
        self.axis = axis
        self.color = color
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["value"] = .number(value)
        if let label { obj["label"] = .string(label) }
        if let axis { obj["axis"] = .string(axis.rawValue) }
        if let color { obj["color"] = .string(color) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let value = obj["value"]?.doubleValue else { return nil }
        self.value = value
        self.label = obj["label"]?.stringValue
        self.axis = obj["axis"]?.stringValue.flatMap(ChartReferenceAxis.init(rawValue:))
        self.color = obj["color"]?.stringValue
    }
}

public struct ChartReferenceBand: Sendable, Equatable {
    public var from: Double
    public var to: Double
    public var label: String?
    public var axis: ChartReferenceAxis?
    public var color: String?

    public init(from: Double, to: Double, label: String? = nil, axis: ChartReferenceAxis? = nil, color: String? = nil) {
        self.from = from
        self.to = to
        self.label = label
        self.axis = axis
        self.color = color
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["from"] = .number(from)
        obj["to"] = .number(to)
        if let label { obj["label"] = .string(label) }
        if let axis { obj["axis"] = .string(axis.rawValue) }
        if let color { obj["color"] = .string(color) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let from = obj["from"]?.doubleValue,
              let to = obj["to"]?.doubleValue else { return nil }
        self.from = from
        self.to = to
        self.label = obj["label"]?.stringValue
        self.axis = obj["axis"]?.stringValue.flatMap(ChartReferenceAxis.init(rawValue:))
        self.color = obj["color"]?.stringValue
    }
}

public struct ChartTreeNode: Sendable, Equatable {
    public var name: String
    public var value: Double?
    public var children: [ChartTreeNode]?
    public var color: String?

    public init(name: String, value: Double? = nil, children: [ChartTreeNode]? = nil, color: String? = nil) {
        self.name = name
        self.value = value
        self.children = children
        self.color = color
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["name"] = .string(name)
        if let color { obj["color"] = .string(color) }
        if let children { obj["children"] = .array(children.map { $0.toJSON() }) }
        if let value { obj["value"] = .number(value) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let name = obj["name"]?.stringValue else { return nil }
        self.name = name
        self.color = obj["color"]?.stringValue
        self.children = obj["children"]?.arrayValue?.compactMap(ChartTreeNode.init(json:))
        self.value = obj["value"]?.doubleValue
    }
}

public struct ChartLink: Sendable, Equatable {
    public var source: String
    public var target: String
    public var value: Double
    public var color: String?

    public init(source: String, target: String, value: Double, color: String? = nil) {
        self.source = source
        self.target = target
        self.value = value
        self.color = color
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["source"] = .string(source)
        obj["target"] = .string(target)
        obj["value"] = .number(value)
        if let color { obj["color"] = .string(color) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let source = obj["source"]?.stringValue,
              let target = obj["target"]?.stringValue,
              let value = obj["value"]?.doubleValue else { return nil }
        self.source = source
        self.target = target
        self.value = value
        self.color = obj["color"]?.stringValue
    }
}

public struct ChartSpec: Sendable, Equatable {
    public var version: Int
    public var type: ChartType
    public var title: String
    public var subtitle: String
    public var categories: [String]
    public var series: [ChartSeries]
    public var xAxis: ChartAxis
    public var yAxis: ChartAxis
    public var yAxis2: ChartAxis
    public var legend: ChartLegend
    public var stacking: ChartStacking
    public var orientation: ChartOrientation
    public var curve: ChartCurve
    public var points: Bool
    public var dataLabels: Bool
    public var labelPosition: ChartLabelPosition
    public var palette: [String]
    public var innerRadius: Double
    public var gapWidth: Double
    public var overlap: Double
    public var bins: Int?
    public var showTotal: Bool
    public var radarTicks: Int?
    public var radarGraticule: ChartRadarGraticule
    public var note: String
    public var highlight: [String]
    public var referenceLines: [ChartReferenceLine]
    public var referenceBands: [ChartReferenceBand]
    public var varyColors: Bool
    public var likertNeutral: ChartLikertNeutral
    public var likertSort: ChartLikertSort
    public var parliamentArc: Double
    public var parliamentMajority: Int?
    public var parliamentLabel: String
    public var tree: [ChartTreeNode]
    public var sunburstLabel: String
    public var links: [ChartLink]
    public var sankeyNodes: [String]
    public var sankeyLinkColor: ChartSankeyLinkColor
    public var raceTopN: Int
    public var map: String
    public var mapSteps: Int
    public var mapThresholds: [Double]

    public init(
        version: Int = 1,
        type: ChartType = .bar,
        title: String = "",
        subtitle: String = "",
        categories: [String] = [],
        series: [ChartSeries] = [],
        xAxis: ChartAxis = defaultChartAxis(false),
        yAxis: ChartAxis = defaultChartAxis(true),
        yAxis2: ChartAxis = defaultChartAxis(false),
        legend: ChartLegend = ChartLegend(),
        stacking: ChartStacking = .none,
        orientation: ChartOrientation = .vertical,
        curve: ChartCurve = .linear,
        points: Bool = true,
        dataLabels: Bool = false,
        labelPosition: ChartLabelPosition = .auto,
        palette: [String] = DEFAULT_CHART_PALETTE,
        innerRadius: Double = 0.55,
        gapWidth: Double = 0.28,
        overlap: Double = -0.12,
        bins: Int? = nil,
        showTotal: Bool = true,
        radarTicks: Int? = nil,
        radarGraticule: ChartRadarGraticule = .polygon,
        note: String = "",
        highlight: [String] = [],
        referenceLines: [ChartReferenceLine] = [],
        referenceBands: [ChartReferenceBand] = [],
        varyColors: Bool = false,
        likertNeutral: ChartLikertNeutral = .split,
        likertSort: ChartLikertSort = .none,
        parliamentArc: Double = 180,
        parliamentMajority: Int? = nil,
        parliamentLabel: String = "",
        tree: [ChartTreeNode] = [],
        sunburstLabel: String = "",
        links: [ChartLink] = [],
        sankeyNodes: [String] = [],
        sankeyLinkColor: ChartSankeyLinkColor = .source,
        raceTopN: Int = 10,
        map: String = "europe",
        mapSteps: Int = 5,
        mapThresholds: [Double] = []
    ) {
        self.version = version
        self.type = type
        self.title = title
        self.subtitle = subtitle
        self.categories = categories
        self.series = series
        self.xAxis = xAxis
        self.yAxis = yAxis
        self.yAxis2 = yAxis2
        self.legend = legend
        self.stacking = stacking
        self.orientation = orientation
        self.curve = curve
        self.points = points
        self.dataLabels = dataLabels
        self.labelPosition = labelPosition
        self.palette = palette
        self.innerRadius = innerRadius
        self.gapWidth = gapWidth
        self.overlap = overlap
        self.bins = bins
        self.showTotal = showTotal
        self.radarTicks = radarTicks
        self.radarGraticule = radarGraticule
        self.note = note
        self.highlight = highlight
        self.referenceLines = referenceLines
        self.referenceBands = referenceBands
        self.varyColors = varyColors
        self.likertNeutral = likertNeutral
        self.likertSort = likertSort
        self.parliamentArc = parliamentArc
        self.parliamentMajority = parliamentMajority
        self.parliamentLabel = parliamentLabel
        self.tree = tree
        self.sunburstLabel = sunburstLabel
        self.links = links
        self.sankeyNodes = sankeyNodes
        self.sankeyLinkColor = sankeyLinkColor
        self.raceTopN = raceTopN
        self.map = map
        self.mapSteps = mapSteps
        self.mapThresholds = mapThresholds
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("version", .number(Double(version))),
            ("type", .string(type.rawValue)),
            ("title", .string(title)),
            ("subtitle", .string(subtitle)),
            ("categories", .array(categories.map(JSONValue.string))),
            ("series", .array(series.map { $0.toJSON() })),
            ("xAxis", xAxis.toJSON()),
            ("yAxis", yAxis.toJSON()),
            ("yAxis2", yAxis2.toJSON()),
            ("legend", legend.toJSON()),
            ("stacking", .string(stacking.rawValue)),
            ("orientation", .string(orientation.rawValue)),
            ("curve", .string(curve.rawValue)),
            ("points", .bool(points)),
            ("dataLabels", .bool(dataLabels)),
            ("labelPosition", .string(labelPosition.rawValue)),
            ("palette", .array(palette.map(JSONValue.string))),
            ("innerRadius", .number(innerRadius)),
            ("gapWidth", .number(gapWidth)),
            ("overlap", .number(overlap)),
            ("bins", bins.map { .number(Double($0)) } ?? .null),
            ("showTotal", .bool(showTotal)),
            ("radarTicks", radarTicks.map { .number(Double($0)) } ?? .null),
            ("radarGraticule", .string(radarGraticule.rawValue)),
            ("note", .string(note)),
            ("highlight", .array(highlight.map(JSONValue.string))),
            ("referenceLines", .array(referenceLines.map { $0.toJSON() })),
            ("referenceBands", .array(referenceBands.map { $0.toJSON() })),
            ("varyColors", .bool(varyColors)),
            ("likertNeutral", .string(likertNeutral.rawValue)),
            ("likertSort", .string(likertSort.rawValue)),
            ("parliamentArc", .number(parliamentArc)),
            ("parliamentMajority", parliamentMajority.map { .number(Double($0)) } ?? .null),
            ("parliamentLabel", .string(parliamentLabel)),
            ("tree", .array(tree.map { $0.toJSON() })),
            ("sunburstLabel", .string(sunburstLabel)),
            ("links", .array(links.map { $0.toJSON() })),
            ("sankeyNodes", .array(sankeyNodes.map(JSONValue.string))),
            ("sankeyLinkColor", .string(sankeyLinkColor.rawValue)),
            ("raceTopN", .number(Double(raceTopN))),
            ("map", .string(map)),
            ("mapSteps", .number(Double(mapSteps))),
            ("mapThresholds", .array(mapThresholds.map(JSONValue.number)))
        ]))
    }

    public init(json: JSONValue) {
        self = normalizeChartSpec(json).spec
    }
}

public struct ChartIssue: Sendable, Equatable {
    public var path: String
    public var message: String
    public var line: Int?

    public init(path: String, message: String, line: Int? = nil) {
        self.path = path
        self.message = message
        self.line = line
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("path", .string(path)),
            ("message", .string(message))
        ])
        if let line { obj["line"] = .number(Double(line)) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let path = obj["path"]?.stringValue,
              let message = obj["message"]?.stringValue else { return nil }
        self.path = path
        self.message = message
        self.line = obj["line"]?.intValue
    }
}

public enum ChartWarningCode: String, CaseIterable, Sendable, Equatable {
    case labelsHidden = "labels-hidden"
    case labelsTruncated = "labels-truncated"
    case legendTruncated = "legend-truncated"
    case pointsDecimated = "points-decimated"
    case valuesSkipped = "values-skipped"
    case dataLabelsHidden = "data-labels-hidden"
    case typeFallback = "type-fallback"
    case annotationsSkipped = "annotations-skipped"
    case highlightUnmatched = "highlight-unmatched"
}

public struct ChartWarning: Sendable, Equatable {
    public var code: ChartWarningCode
    public var message: String

    public init(code: ChartWarningCode, message: String) {
        self.code = code
        self.message = message
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("code", .string(code.rawValue)),
            ("message", .string(message))
        ]))
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let codeStr = obj["code"]?.stringValue,
              let code = ChartWarningCode(rawValue: codeStr),
              let message = obj["message"]?.stringValue else { return nil }
        self.code = code
        self.message = message
    }
}

public enum ChartSelectionAxis: String, CaseIterable, Sendable, Equatable {
    case x
    case y
    case y2
}

public enum ChartSelection: Sendable, Equatable {
    case chart
    case title
    case subtitle
    case legend
    case axis(ChartSelectionAxis)
    case series(seriesId: String)
    case point(seriesId: String, index: Int)
    case category(index: Int)
    case trendline(seriesId: String, index: Int)

    public func toJSON() -> JSONValue {
        switch self {
        case .chart:
            return .object(JSONObject([("kind", .string("chart"))]))
        case .title:
            return .object(JSONObject([("kind", .string("title"))]))
        case .subtitle:
            return .object(JSONObject([("kind", .string("subtitle"))]))
        case .legend:
            return .object(JSONObject([("kind", .string("legend"))]))
        case .axis(let axis):
            return .object(JSONObject([("kind", .string("axis")), ("axis", .string(axis.rawValue))]))
        case .series(let seriesId):
            return .object(JSONObject([("kind", .string("series")), ("seriesId", .string(seriesId))]))
        case .point(let seriesId, let index):
            return .object(JSONObject([("kind", .string("point")), ("seriesId", .string(seriesId)), ("index", .number(Double(index)))]))
        case .category(let index):
            return .object(JSONObject([("kind", .string("category")), ("index", .number(Double(index)))]))
        case .trendline(let seriesId, let index):
            return .object(JSONObject([("kind", .string("trendline")), ("seriesId", .string(seriesId)), ("index", .number(Double(index)))]))
        }
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue, let kind = obj["kind"]?.stringValue else { return nil }
        switch kind {
        case "chart": self = .chart
        case "title": self = .title
        case "subtitle": self = .subtitle
        case "legend": self = .legend
        case "axis":
            guard let axisStr = obj["axis"]?.stringValue,
                  let axis = ChartSelectionAxis(rawValue: axisStr) else { return nil }
            self = .axis(axis)
        case "series":
            guard let seriesId = obj["seriesId"]?.stringValue else { return nil }
            self = .series(seriesId: seriesId)
        case "point":
            guard let seriesId = obj["seriesId"]?.stringValue,
                  let index = obj["index"]?.intValue else { return nil }
            self = .point(seriesId: seriesId, index: index)
        case "category":
            guard let index = obj["index"]?.intValue else { return nil }
            self = .category(index: index)
        case "trendline":
            guard let seriesId = obj["seriesId"]?.stringValue,
                  let index = obj["index"]?.intValue else { return nil }
            self = .trendline(seriesId: seriesId, index: index)
        default:
            return nil
        }
    }
}

public enum ChartMarkRole: String, CaseIterable, Sendable, Equatable {
    case background
    case title
    case subtitle
    case grid
    case axis
    case tick
    case tickLabel = "tick-label"
    case axisTitle = "axis-title"
    case bar
    case line
    case area
    case point
    case slice
    case cell
    case box
    case whisker
    case outlier
    case connector
    case trendline
    case trendlineLabel = "trendline-label"
    case errorBar = "error-bar"
    case dataLabel = "data-label"
    case legendSwatch = "legend-swatch"
    case legendLabel = "legend-label"
    case dragReadout = "drag-readout"
    case referenceLine = "reference-line"
    case referenceBand = "reference-band"
    case referenceLabel = "reference-label"
    case callout
    case node
    case raceTime = "race-time"
    case region
    case mapLand = "map-land"
    case link
    case note
    case selection
    case empty
}

public enum ChartTextAnchor: String, CaseIterable, Sendable, Equatable {
    case start
    case middle
    case end
}

public enum ChartTextBaseline: String, CaseIterable, Sendable, Equatable {
    case top
    case middle
    case bottom
}

public struct ChartRectMark: Sendable, Equatable {
    public var key: String
    public var role: ChartMarkRole
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var fill: String
    public var stroke: String?
    public var strokeWidth: Double?
    public var radius: Double?
    public var opacity: Double?
    public var target: ChartSelection?
    public var selected: Bool?

    public init(
        key: String,
        role: ChartMarkRole,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        fill: String,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        radius: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) {
        self.key = key
        self.role = role
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.fill = fill
        self.stroke = stroke
        self.strokeWidth = strokeWidth
        self.radius = radius
        self.opacity = opacity
        self.target = target
        self.selected = selected
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("kind", .string("rect")),
            ("key", .string(key)),
            ("role", .string(role.rawValue)),
            ("x", .number(x)),
            ("y", .number(y)),
            ("width", .number(width)),
            ("height", .number(height)),
            ("fill", .string(fill))
        ])
        if let stroke { obj["stroke"] = .string(stroke) }
        if let strokeWidth { obj["strokeWidth"] = .number(strokeWidth) }
        if let radius { obj["radius"] = .number(radius) }
        if let opacity { obj["opacity"] = .number(opacity) }
        if let target { obj["target"] = target.toJSON() }
        if let selected { obj["selected"] = .bool(selected) }
        return .object(obj)
    }
}

public struct ChartPathMark: Sendable, Equatable {
    public var key: String
    public var role: ChartMarkRole
    public var d: String
    public var fill: String?
    public var stroke: String?
    public var strokeWidth: Double?
    public var dash: String?
    public var opacity: Double?
    public var target: ChartSelection?
    public var selected: Bool?

    public init(
        key: String,
        role: ChartMarkRole,
        d: String,
        fill: String? = nil,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        dash: String? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) {
        self.key = key
        self.role = role
        self.d = d
        self.fill = fill
        self.stroke = stroke
        self.strokeWidth = strokeWidth
        self.dash = dash
        self.opacity = opacity
        self.target = target
        self.selected = selected
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("kind", .string("path")),
            ("key", .string(key)),
            ("role", .string(role.rawValue)),
            ("d", .string(d))
        ])
        if let fill { obj["fill"] = .string(fill) }
        if let stroke { obj["stroke"] = .string(stroke) }
        if let strokeWidth { obj["strokeWidth"] = .number(strokeWidth) }
        if let dash { obj["dash"] = .string(dash) }
        if let opacity { obj["opacity"] = .number(opacity) }
        if let target { obj["target"] = target.toJSON() }
        if let selected { obj["selected"] = .bool(selected) }
        return .object(obj)
    }
}

public struct ChartCircleMark: Sendable, Equatable {
    public var key: String
    public var role: ChartMarkRole
    public var cx: Double
    public var cy: Double
    public var r: Double
    public var fill: String
    public var stroke: String?
    public var strokeWidth: Double?
    public var opacity: Double?
    public var target: ChartSelection?
    public var selected: Bool?

    public init(
        key: String,
        role: ChartMarkRole,
        cx: Double,
        cy: Double,
        r: Double,
        fill: String,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) {
        self.key = key
        self.role = role
        self.cx = cx
        self.cy = cy
        self.r = r
        self.fill = fill
        self.stroke = stroke
        self.strokeWidth = strokeWidth
        self.opacity = opacity
        self.target = target
        self.selected = selected
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("kind", .string("circle")),
            ("key", .string(key)),
            ("role", .string(role.rawValue)),
            ("cx", .number(cx)),
            ("cy", .number(cy)),
            ("r", .number(r)),
            ("fill", .string(fill))
        ])
        if let stroke { obj["stroke"] = .string(stroke) }
        if let strokeWidth { obj["strokeWidth"] = .number(strokeWidth) }
        if let opacity { obj["opacity"] = .number(opacity) }
        if let target { obj["target"] = target.toJSON() }
        if let selected { obj["selected"] = .bool(selected) }
        return .object(obj)
    }
}

public struct ChartLineMark: Sendable, Equatable {
    public var key: String
    public var role: ChartMarkRole
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var stroke: String
    public var strokeWidth: Double?
    public var dash: String?
    public var opacity: Double?
    public var target: ChartSelection?
    public var selected: Bool?

    public init(
        key: String,
        role: ChartMarkRole,
        x1: Double,
        y1: Double,
        x2: Double,
        y2: Double,
        stroke: String,
        strokeWidth: Double? = nil,
        dash: String? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) {
        self.key = key
        self.role = role
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.stroke = stroke
        self.strokeWidth = strokeWidth
        self.dash = dash
        self.opacity = opacity
        self.target = target
        self.selected = selected
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("kind", .string("line")),
            ("key", .string(key)),
            ("role", .string(role.rawValue)),
            ("x1", .number(x1)),
            ("y1", .number(y1)),
            ("x2", .number(x2)),
            ("y2", .number(y2)),
            ("stroke", .string(stroke))
        ])
        if let strokeWidth { obj["strokeWidth"] = .number(strokeWidth) }
        if let dash { obj["dash"] = .string(dash) }
        if let opacity { obj["opacity"] = .number(opacity) }
        if let target { obj["target"] = target.toJSON() }
        if let selected { obj["selected"] = .bool(selected) }
        return .object(obj)
    }
}

public struct ChartTextMark: Sendable, Equatable {
    public var key: String
    public var role: ChartMarkRole
    public var x: Double
    public var y: Double
    public var text: String
    public var anchor: ChartTextAnchor
    public var baseline: ChartTextBaseline
    public var size: Double
    public var weight: Double?
    public var fill: String
    public var rotate: Double?
    public var opacity: Double?
    public var target: ChartSelection?
    public var selected: Bool?

    public init(
        key: String,
        role: ChartMarkRole,
        x: Double,
        y: Double,
        text: String,
        anchor: ChartTextAnchor,
        baseline: ChartTextBaseline,
        size: Double,
        weight: Double? = nil,
        fill: String,
        rotate: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) {
        self.key = key
        self.role = role
        self.x = x
        self.y = y
        self.text = text
        self.anchor = anchor
        self.baseline = baseline
        self.size = size
        self.weight = weight
        self.fill = fill
        self.rotate = rotate
        self.opacity = opacity
        self.target = target
        self.selected = selected
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("kind", .string("text")),
            ("key", .string(key)),
            ("role", .string(role.rawValue)),
            ("x", .number(x)),
            ("y", .number(y)),
            ("text", .string(text)),
            ("anchor", .string(anchor.rawValue)),
            ("baseline", .string(baseline.rawValue)),
            ("size", .number(size))
        ])
        if let weight { obj["weight"] = .number(weight) }
        obj["fill"] = .string(fill)
        if let rotate { obj["rotate"] = .number(rotate) }
        if let opacity { obj["opacity"] = .number(opacity) }
        if let target { obj["target"] = target.toJSON() }
        if let selected { obj["selected"] = .bool(selected) }
        return .object(obj)
    }
}

public enum ChartMark: Sendable, Equatable {
    case rect(ChartRectMark)
    case path(ChartPathMark)
    case circle(ChartCircleMark)
    case line(ChartLineMark)
    case text(ChartTextMark)

    public var key: String {
        switch self {
        case .rect(let m): return m.key
        case .path(let m): return m.key
        case .circle(let m): return m.key
        case .line(let m): return m.key
        case .text(let m): return m.key
        }
    }

    public var role: ChartMarkRole {
        switch self {
        case .rect(let m): return m.role
        case .path(let m): return m.role
        case .circle(let m): return m.role
        case .line(let m): return m.role
        case .text(let m): return m.role
        }
    }

    public var target: ChartSelection? {
        get {
            switch self {
            case .rect(let m): return m.target
            case .path(let m): return m.target
            case .circle(let m): return m.target
            case .line(let m): return m.target
            case .text(let m): return m.target
            }
        }
        set {
            switch self {
            case .rect(var m): m.target = newValue; self = .rect(m)
            case .path(var m): m.target = newValue; self = .path(m)
            case .circle(var m): m.target = newValue; self = .circle(m)
            case .line(var m): m.target = newValue; self = .line(m)
            case .text(var m): m.target = newValue; self = .text(m)
            }
        }
    }

    public var selected: Bool? {
        get {
            switch self {
            case .rect(let m): return m.selected
            case .path(let m): return m.selected
            case .circle(let m): return m.selected
            case .line(let m): return m.selected
            case .text(let m): return m.selected
            }
        }
        set {
            switch self {
            case .rect(var m): m.selected = newValue; self = .rect(m)
            case .path(var m): m.selected = newValue; self = .path(m)
            case .circle(var m): m.selected = newValue; self = .circle(m)
            case .line(var m): m.selected = newValue; self = .line(m)
            case .text(var m): m.selected = newValue; self = .text(m)
            }
        }
    }

    public var opacity: Double? {
        get {
            switch self {
            case .rect(let m): return m.opacity
            case .path(let m): return m.opacity
            case .circle(let m): return m.opacity
            case .line(let m): return m.opacity
            case .text(let m): return m.opacity
            }
        }
        set {
            switch self {
            case .rect(var m): m.opacity = newValue; self = .rect(m)
            case .path(var m): m.opacity = newValue; self = .path(m)
            case .circle(var m): m.opacity = newValue; self = .circle(m)
            case .line(var m): m.opacity = newValue; self = .line(m)
            case .text(var m): m.opacity = newValue; self = .text(m)
            }
        }
    }

    public func toJSON() -> JSONValue {
        switch self {
        case .rect(let m): return m.toJSON()
        case .path(let m): return m.toJSON()
        case .circle(let m): return m.toJSON()
        case .line(let m): return m.toJSON()
        case .text(let m): return m.toJSON()
        }
    }

    public static func rect(
        key: String,
        role: ChartMarkRole,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        fill: String,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        radius: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) -> ChartMark {
        .rect(ChartRectMark(
            key: key,
            role: role,
            x: x,
            y: y,
            width: width,
            height: height,
            fill: fill,
            stroke: stroke,
            strokeWidth: strokeWidth,
            radius: radius,
            opacity: opacity,
            target: target,
            selected: selected
        ))
    }

    public static func path(
        key: String,
        role: ChartMarkRole,
        d: String,
        fill: String? = nil,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        dash: String? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) -> ChartMark {
        .path(ChartPathMark(
            key: key,
            role: role,
            d: d,
            fill: fill,
            stroke: stroke,
            strokeWidth: strokeWidth,
            dash: dash,
            opacity: opacity,
            target: target,
            selected: selected
        ))
    }

    public static func circle(
        key: String,
        role: ChartMarkRole,
        cx: Double,
        cy: Double,
        r: Double,
        fill: String,
        stroke: String? = nil,
        strokeWidth: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) -> ChartMark {
        .circle(ChartCircleMark(
            key: key,
            role: role,
            cx: cx,
            cy: cy,
            r: r,
            fill: fill,
            stroke: stroke,
            strokeWidth: strokeWidth,
            opacity: opacity,
            target: target,
            selected: selected
        ))
    }

    public static func line(
        key: String,
        role: ChartMarkRole,
        x1: Double,
        y1: Double,
        x2: Double,
        y2: Double,
        stroke: String,
        strokeWidth: Double? = nil,
        dash: String? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) -> ChartMark {
        .line(ChartLineMark(
            key: key,
            role: role,
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2,
            stroke: stroke,
            strokeWidth: strokeWidth,
            dash: dash,
            opacity: opacity,
            target: target,
            selected: selected
        ))
    }

    public static func text(
        key: String,
        role: ChartMarkRole,
        x: Double,
        y: Double,
        text: String,
        anchor: ChartTextAnchor,
        baseline: ChartTextBaseline,
        size: Double,
        weight: Double? = nil,
        fill: String,
        rotate: Double? = nil,
        opacity: Double? = nil,
        target: ChartSelection? = nil,
        selected: Bool? = nil
    ) -> ChartMark {
        .text(ChartTextMark(
            key: key,
            role: role,
            x: x,
            y: y,
            text: text,
            anchor: anchor,
            baseline: baseline,
            size: size,
            weight: weight,
            fill: fill,
            rotate: rotate,
            opacity: opacity,
            target: target,
            selected: selected
        ))
    }
}

public struct ChartTheme: Sendable, Equatable {
    public var background: String
    public var surface: String
    public var text: String
    public var mutedText: String
    public var grid: String
    public var axis: String
    public var selection: String
    public var positive: String
    public var negative: String
    public var fontFamily: String
    public var fontSize: Double
    public var titleSize: Double

    public init(
        background: String,
        surface: String,
        text: String,
        mutedText: String,
        grid: String,
        axis: String,
        selection: String,
        positive: String,
        negative: String,
        fontFamily: String,
        fontSize: Double,
        titleSize: Double
    ) {
        self.background = background
        self.surface = surface
        self.text = text
        self.mutedText = mutedText
        self.grid = grid
        self.axis = axis
        self.selection = selection
        self.positive = positive
        self.negative = negative
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.titleSize = titleSize
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("background", .string(background)),
            ("surface", .string(surface)),
            ("text", .string(text)),
            ("mutedText", .string(mutedText)),
            ("grid", .string(grid)),
            ("axis", .string(axis)),
            ("selection", .string(selection)),
            ("positive", .string(positive)),
            ("negative", .string(negative)),
            ("fontFamily", .string(fontFamily)),
            ("fontSize", .number(fontSize)),
            ("titleSize", .number(titleSize))
        ]))
    }
}

public struct ChartRect: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("x", .number(x)),
            ("y", .number(y)),
            ("width", .number(width)),
            ("height", .number(height))
        ]))
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let x = obj["x"]?.doubleValue,
              let y = obj["y"]?.doubleValue,
              let width = obj["width"]?.doubleValue,
              let height = obj["height"]?.doubleValue else { return nil }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public typealias ChartBox = ChartRect

public enum ChartScaleAxis: String, CaseIterable, Sendable, Equatable {
    case x
    case y
}

public struct ChartValueScale: Sendable, Equatable {
    public var axis: ChartScaleAxis
    public var domain: (Double, Double)
    public var range: (Double, Double)
    public var ticks: [Double]
    public var logBase: Double?

    public init(
        axis: ChartScaleAxis = .y,
        domain: (Double, Double),
        range: (Double, Double),
        ticks: [Double],
        logBase: Double? = nil
    ) {
        self.axis = axis
        self.domain = domain
        self.range = range
        self.ticks = ticks
        self.logBase = logBase
    }

    public static func == (lhs: ChartValueScale, rhs: ChartValueScale) -> Bool {
        lhs.axis == rhs.axis &&
            lhs.domain.0 == rhs.domain.0 &&
            lhs.domain.1 == rhs.domain.1 &&
            lhs.range.0 == rhs.range.0 &&
            lhs.range.1 == rhs.range.1 &&
            lhs.ticks == rhs.ticks &&
            lhs.logBase == rhs.logBase
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("axis", .string(axis.rawValue)),
            ("domain", .array([.number(domain.0), .number(domain.1)])),
            ("range", .array([.number(range.0), .number(range.1)])),
            ("ticks", .array(ticks.map(JSONValue.number)))
        ])
        if let logBase { obj["logBase"] = .number(logBase) }
        return .object(obj)
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let dom = obj["domain"]?.arrayValue, dom.count == 2,
              let d0 = dom[0].doubleValue, let d1 = dom[1].doubleValue,
              let rng = obj["range"]?.arrayValue, rng.count == 2,
              let r0 = rng[0].doubleValue, let r1 = rng[1].doubleValue,
              let ticks = obj["ticks"]?.arrayValue?.compactMap({ $0.doubleValue }) else { return nil }
        self.axis = obj["axis"]?.stringValue.flatMap(ChartScaleAxis.init(rawValue:)) ?? .y
        self.domain = (d0, d1)
        self.range = (r0, r1)
        self.ticks = ticks
        self.logBase = obj["logBase"]?.doubleValue
    }
}

public typealias ChartScaleSnapshot = ChartValueScale

public struct ChartCategoryScale: Sendable, Equatable {
    public var axis: ChartScaleAxis
    public var start: Double
    public var length: Double
    public var count: Int
    public var reverse: Bool

    public init(axis: ChartScaleAxis = .x, start: Double, length: Double, count: Int, reverse: Bool = false) {
        self.axis = axis
        self.start = start
        self.length = length
        self.count = count
        self.reverse = reverse
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("axis", .string(axis.rawValue)),
            ("start", .number(start)),
            ("length", .number(length)),
            ("count", .number(Double(count))),
            ("reverse", .bool(reverse))
        ]))
    }
}

public struct ChartScene: Sendable, Equatable {
    public var width: Double
    public var height: Double
    public var plot: ChartRect
    public var marks: [ChartMark]
    public var valueScale: ChartValueScale?
    public var valueScale2: ChartValueScale?
    public var xScale: ChartValueScale?
    public var categoryScale: ChartCategoryScale?
    public var percent: Bool
    public var theme: ChartTheme
    public var warnings: [ChartWarning]

    public init(
        width: Double = 640,
        height: Double = 400,
        plot: ChartRect = ChartRect(x: 0, y: 0, width: 640, height: 400),
        marks: [ChartMark] = [],
        valueScale: ChartValueScale? = nil,
        valueScale2: ChartValueScale? = nil,
        xScale: ChartValueScale? = nil,
        categoryScale: ChartCategoryScale? = nil,
        percent: Bool = false,
        theme: ChartTheme = DEFAULT_CHART_THEME,
        warnings: [ChartWarning] = []
    ) {
        self.width = width
        self.height = height
        self.plot = plot
        self.marks = marks
        self.valueScale = valueScale
        self.valueScale2 = valueScale2
        self.xScale = xScale
        self.categoryScale = categoryScale
        self.percent = percent
        self.theme = theme
        self.warnings = warnings
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("width", .number(width)),
            ("height", .number(height)),
            ("plot", plot.toJSON()),
            ("marks", .array(marks.map { $0.toJSON() })),
            ("percent", .bool(percent)),
            ("theme", theme.toJSON()),
            ("warnings", .array(warnings.map { $0.toJSON() }))
        ])
        if let valueScale { obj["valueScale"] = valueScale.toJSON() }
        if let valueScale2 { obj["valueScale2"] = valueScale2.toJSON() }
        if let xScale { obj["xScale"] = xScale.toJSON() }
        if let categoryScale { obj["categoryScale"] = categoryScale.toJSON() }
        return .object(obj)
    }
}
