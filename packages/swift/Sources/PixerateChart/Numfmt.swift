import Foundation
import PixerateCore

/// A compiled spreadsheet number format code for chart labels, e.g. `#,##0.00`, `0.0%`,
/// `#,##0,,"M"`, `$#,##0;[Red]($#,##0);"–"` or `yyyy-mm-dd`. Backed by the spreadsheet's
/// format engine (`NumberFormat`), so charts and sheets write numbers the same way; colours
/// such as `[Red]` are ignored on charts.
public struct ChartFormatCode: Sendable {
    private let fmt: NumberFormat
    public var isDate: Bool { fmt.isDate() }
    public var isPercent: Bool { fmt.isPercent() }

    public init(_ code: String) {
        self.fmt = NumberFormat.parseCached(code)
    }

    public func format(_ value: Double) -> String {
        value.isFinite ? fmt.formatNumber(value).text : ""
    }
}

/// Compiles a spreadsheet format code (cached).
public func compileChartFormatCode(_ code: String) -> ChartFormatCode {
    ChartFormatCode(code)
}

/// Formats `value` with a spreadsheet format code.
public func formatChartValueWithCode(_ value: Double, _ code: String) -> String {
    compileChartFormatCode(code).format(value)
}

private let MS_1899_12_31: Double = -2209075200000 // Date.UTC(1899, 11, 31)
private let MS_1899_12_30: Double = -2209161600000 // Date.UTC(1899, 11, 30)

/// A spreadsheet serial day number (1 = 1900-01-01, with the 1900 leap-year quirk) as UTC milliseconds since 1970-01-01.
public func chartSerialToDate(_ serial: Double) -> Double {
    let origin = serial < 61 ? MS_1899_12_31 : MS_1899_12_30
    let offset = serial * 86400000.0
    let rounded: Double
    if !offset.isFinite || offset == 0 {
        rounded = offset
    } else if offset > 0 {
        rounded = floor(offset + 0.5)
    } else {
        let f = ceil(offset - 0.5)
        rounded = f == 0 ? 0 : f
    }
    return origin + rounded
}

/// UTC milliseconds since 1970-01-01 as a spreadsheet serial day number.
public func chartDateToSerial(_ utcMs: Double) -> Double {
    let serial = (utcMs - MS_1899_12_30) / 86400000.0
    return serial < 61 ? serial - 1 : serial
}
