import Foundation
import PixerateCore

public struct ChartTableShape: Sendable, Equatable {
    public var headerRow: Bool
    public var labelColumn: Bool
    public var byRows: Bool
    public var series: Int
    public var points: Int
    public var anyNumber: Bool
    public var nonNegative: Bool
    public var mixedSigns: Bool
    public var dates: Bool

    public init(
        headerRow: Bool = false,
        labelColumn: Bool = false,
        byRows: Bool = false,
        series: Int,
        points: Int,
        anyNumber: Bool,
        nonNegative: Bool,
        mixedSigns: Bool,
        dates: Bool
    ) {
        self.headerRow = headerRow
        self.labelColumn = labelColumn
        self.byRows = byRows
        self.series = series
        self.points = points
        self.anyNumber = anyNumber
        self.nonNegative = nonNegative
        self.mixedSigns = mixedSigns
        self.dates = dates
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("headerRow", .bool(headerRow)),
            ("labelColumn", .bool(labelColumn)),
            ("byRows", .bool(byRows)),
            ("series", .number(Double(series))),
            ("points", .number(Double(points))),
            ("anyNumber", .bool(anyNumber)),
            ("nonNegative", .bool(nonNegative)),
            ("mixedSigns", .bool(mixedSigns)),
            ("dates", .bool(dates))
        ]))
    }
}

private func isBlankCell(_ c: JSONValue?) -> Bool {
    guard let c, c != .null else { return true }
    return jsCellString(c).jsTrimmed.isEmpty
}

private func isTextCell(_ c: JSONValue?) -> Bool {
    isBlankCell(c) || parseChartValue(c) == nil
}

/// Reads the shape of a block of cells the way spreadsheets do: a header row when the first
/// row is text, a label column when the first column is text (or the top-left cell is blank
/// above a header row, the convention for years and x values), and series along the longer side.
public func analyzeChartTable(_ rows: [[JSONValue]]) -> ChartTableShape {
    let grid = rows.filter { r in r.contains { !isBlankCell($0) } }
    let height = grid.count
    let width = grid.map { $0.count }.max() ?? 0
    func cell(_ r: Int, _ c: Int) -> JSONValue? {
        guard r >= 0 && r < grid.count, c >= 0 && c < grid[r].count else { return nil }
        return grid[r][c]
    }
    let headerRow = height > 1 &&
        grid[0].contains { !isBlankCell($0) && isTextCell($0) } &&
        (1..<Swift.max(1, width)).allSatisfy { c in isTextCell(cell(0, c)) }
    let blankCorner = headerRow && isBlankCell(cell(0, 0))
    let startRow = headerRow ? 1 : 0
    let labelColumn = width > 1 && (
        blankCorner ||
        (startRow..<Swift.max(startRow, height)).allSatisfy { r in isTextCell(cell(r, 0)) }
    )
    let byRows = width > height + 1
    let dataRows = height - (headerRow ? 1 : 0)
    let dataCols = width - (labelColumn ? 1 : 0)
    var anyNumber = false
    var nonNegative = true
    var anyNegative = false
    var anyPositive = false
    let rStart = headerRow ? 1 : 0
    let cStart = labelColumn ? 1 : 0
    if rStart < height && cStart < width {
        for r in rStart..<height {
            for c in cStart..<width {
                if case .some(.some(let v)) = parseChartValue(cell(r, c)) {
                    anyNumber = true
                    if v < 0 {
                        nonNegative = false
                        anyNegative = true
                    } else if v > 0 {
                        anyPositive = true
                    }
                }
            }
        }
    }
    let labels: [JSONValue?]
    if byRows {
        let firstRow = grid.first ?? []
        let dropCount = labelColumn ? 1 : 0
        labels = Array(firstRow.dropFirst(dropCount)).map { Optional.some($0) }
    } else {
        labels = grid.dropFirst(headerRow ? 1 : 0).map { $0.first }
    }
    let dateMatches = labels.filter { l in
        !isBlankCell(l) && parseChartDate(jsCellString(l)) != nil
    }.count
    let dates = (byRows ? headerRow : labelColumn) &&
        labels.count > 1 &&
        Double(dateMatches) >= Double(labels.count) * 0.8
    return ChartTableShape(
        headerRow: headerRow,
        labelColumn: labelColumn,
        byRows: byRows,
        series: Swift.max(0, byRows ? dataRows : dataCols),
        points: Swift.max(0, byRows ? dataCols : dataRows),
        anyNumber: anyNumber,
        nonNegative: nonNegative,
        mixedSigns: anyNegative && anyPositive,
        dates: dates
    )
}

public struct ChartRecommendation: Sendable, Equatable {
    public var type: ChartType
    public var stacking: ChartStacking?
    public var label: String
    public var reason: String

    public init(type: ChartType, label: String, reason: String, stacking: ChartStacking? = nil) {
        self.type = type
        self.stacking = stacking
        self.label = label
        self.reason = reason
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("type", .string(type.rawValue)),
            ("label", .string(label)),
            ("reason", .string(reason))
        ])
        if let stacking { obj["stacking"] = .string(stacking.rawValue) }
        return .object(obj)
    }
}

/// Chart types that suit the shape of a block of cells, best first.
public func recommendChartTypes(_ rows: [[JSONValue]]) -> [ChartRecommendation] {
    let shape = analyzeChartTable(rows)
    if !shape.anyNumber || shape.series == 0 { return [] }
    return recommendForShape(shape)
}

public func recommendForShape(_ shape: ChartTableShape) -> [ChartRecommendation] {
    var out: [ChartRecommendation] = []
    func add(_ type: ChartType, _ label: String, _ reason: String, _ stacking: ChartStacking? = nil) {
        out.append(ChartRecommendation(type: type, label: label, reason: reason, stacking: stacking))
    }
    if shape.series == 2 && !shape.labelColumn && !shape.byRows {
        add(.scatter, "Scatter", "Two numeric columns without labels: the first is x, the second y.")
        add(.line, "Line", "Shows the second column in order.")
        add(.bar, "Column", "Compares the values side by side.")
        return out
    }
    if shape.series == 1 && !shape.labelColumn && shape.points > 20 {
        add(.histogram, "Histogram", "Many unlabelled values: shows how they are distributed.")
        add(.box, "Box plot", "Summarises the spread: quartiles, median and outliers.")
        add(.line, "Line", "Shows the values in order.")
        return out
    }
    if shape.dates {
        add(.line, "Line", "The categories are dates: a line shows change over time.")
        add(.area, "Area", "Shows change over time with volume.")
        add(.bar, "Column", "Compares each period.")
        if shape.series > 1 {
            add(.area, "Stacked area", "Shows how the parts add up over time.", .stacked)
            add(.streamgraph, "Streamgraph", "Shows changing proportions and overall volume as an organic stream.")
        }
        if shape.series >= 5 && shape.points >= 3 {
            add(.barrace, "Bar race", "Many series over time: an animated ranking shows who leads when.")
        }
        return out
    }
    if shape.series == 1 {
        if shape.points > 12 {
            add(.line, "Line", "One long series: a line shows its shape.")
            add(.bar, "Column", "Compares every value.")
            add(.area, "Area", "Emphasises the volume under the series.")
        } else {
            add(.bar, "Column", "One short series: columns compare the values.")
            if shape.mixedSigns {
                add(.waterfall, "Waterfall", "Positive and negative values: shows how they add up to a total.")
            }
            add(.bar, "Bar", "Horizontal bars fit long category names.")
            if shape.nonNegative && shape.points >= 2 {
                add(.pie, "Pie", "Shares of a whole (all values are positive).")
                add(.donut, "Donut", "Shares of a whole with the total in the middle.")
                if shape.points >= 5 {
                    add(.treemap, "Treemap", "Compares many shares by area.")
                }
                add(.funnel, "Funnel", "Shows stages that narrow down.")
                add(.parliament, "Parliament", "Seats or votes per group, with the majority line.")
            }
            add(.line, "Line", "Shows the values in order.")
        }
        return out
    }
    if shape.points > 12 {
        add(.line, "Line", "Several long series: lines keep them readable.")
        add(.bar, "Column", "Compares the series at each category.")
        add(.area, "Area", "Emphasises volume.")
        add(.bar, "Stacked column", "Shows how the series add up.", .stacked)
    } else {
        if shape.series == 2 && shape.labelColumn {
            add(.slope, "Slope", "Two columns per item: shows what rose and what fell between them.")
        }
        add(.bar, "Column", "Several series: clustered columns compare them per category.")
        add(.bar, "Bar", "Horizontal bars fit long category names.")
        add(.bar, "Stacked column", "Shows how the series add up.", .stacked)
        add(.line, "Line", "Shows the series in order.")
        if shape.points >= 3 && shape.series <= 6 {
            add(.radar, "Radar", "Compares several measures across the series.")
        }
        if shape.nonNegative && shape.series >= 5 && shape.points >= 3 {
            add(.barrace, "Bar race", "Many series across ordered categories (such as years): an animated ranking shows who leads when.")
        }
        if shape.nonNegative && shape.series >= 3 && shape.series <= 7 {
            add(.likert, "Likert", "Survey answers per question (columns from most negative to most positive): shows agreement against disagreement.")
        }
    }
    return out
}

public struct ChartFromTable: Sendable, Equatable {
    public var type: ChartType
    public var stacking: ChartStacking
    public var categories: [String]
    public var series: [ChartSeries]
    public var issues: [ChartIssue]
    public var shape: ChartTableShape

    public init(
        type: ChartType,
        stacking: ChartStacking,
        categories: [String],
        series: [ChartSeries],
        issues: [ChartIssue],
        shape: ChartTableShape
    ) {
        self.type = type
        self.stacking = stacking
        self.categories = categories
        self.series = series
        self.issues = issues
        self.shape = shape
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("type", .string(type.rawValue)),
            ("stacking", .string(stacking.rawValue)),
            ("categories", .array(categories.map(JSONValue.string))),
            ("series", .array(series.map { $0.toJSON() })),
            ("issues", .array(issues.map { $0.toJSON() })),
            ("shape", shape.toJSON())
        ]))
    }
}

/// Builds chart data from a block of cells (CSV, a clipboard grid or a spreadsheet range) using
/// the spreadsheet conventions of `analyzeChartTable`. `type: nil` (auto) takes the
/// first recommendation. A scatter chart of a block without labels takes the first column as
/// the x values of the others.
public func chartFromTable(_ rows: [[JSONValue]], type requestedType: ChartType? = nil) -> ChartFromTable {
    let shape = analyzeChartTable(rows)
    let rec = requestedType == nil ? recommendForShape(shape).first : nil
    let type = rec?.type ?? (requestedType ?? .bar)
    let stacking = rec?.stacking ?? .none
    let grid = rows.filter { r in r.contains { !isBlankCell($0) } }
    let width = grid.map { $0.count }.max() ?? 0
    var table = grid
    if !shape.labelColumn {
        table = table.enumerated().map { i, r in
            let prefix = (shape.headerRow && i == 0) ? "" : String(i + (shape.headerRow ? 0 : 1))
            return [.string(prefix)] + r
        }
    }
    if !shape.headerRow {
        let headerRow: [JSONValue] = [.string("")] + (0..<width).map { .string("Series \($0 + 1)") }
        table = [headerRow] + table
    }
    let xFromFirst = type == .scatter && !shape.labelColumn && !shape.byRows && shape.series > 1
    if xFromFirst {
        table = table.map { r in
            let firstData: JSONValue = r.count > 1 ? r[1] : .null
            let rest = r.count > 2 ? Array(r.dropFirst(2)) : []
            return [firstData] + rest
        }
    }
    let data = chartDataFromTable(
        table,
        ChartTableOptions(
            seriesIn: shape.byRows ? .rows : .columns,
            header: .bool(true),
            xFromFirstColumn: xFromFirst
        )
    )
    return ChartFromTable(
        type: type,
        stacking: stacking,
        categories: data.categories,
        series: data.series,
        issues: data.issues,
        shape: shape
    )
}
