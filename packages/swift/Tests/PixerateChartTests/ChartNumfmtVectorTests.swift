import Foundation
import PixerateChart
import PixerateCore
import XCTest

final class ChartNumfmtVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "chart-numfmt-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: String = "") -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w || (trig && abs(g - w) <= 1e-9 * max(1, abs(g), abs(w))) { return nil }
            return "\(path): \(JSONValue.jsNumber(g)) != \(JSONValue.jsNumber(w))"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items != \(w.count)" }
            for i in 0 ..< g.count { if let d = mismatch(g[i], w[i], trig, "\(path)[\(i)]") { return d } }
            return nil
        case let (.object(g), .object(w)):
            if Set(g.keys) != Set(w.keys) { return "\(path): keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys { if let d = mismatch(g[k]!, w[k]!, trig, "\(path).\(k)") { return d } }
            return nil
        default:
            return got == want ? nil : "\(path): \(got.stringified().prefix(200)) != \(want.stringified().prefix(200))"
        }
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        switch e["fn"]!.stringValue! {
        case "builtinNumberFormat":
            let ids = list("ids").map { Int($0.numberValue!) }
            let codes = list("codes").map { $0.stringValue! }
            return .object(JSONObject([
                ("byId", .array(ids.map { builtinNumberFormat($0).map(JSONValue.string) ?? .null })),
                ("byCode", .array(codes.map { builtinNumberFormatId($0).map { .number(Double($0)) } ?? .null })),
            ]))

        case "numberFormatPresets":
            let cellFormats = list("cellFormats").map { $0.stringValue! }
            let presetCodes = list("presetCodes").map { $0.stringValue! }
            return .object(JSONObject([
                ("presets", .array(NUMBER_FORMAT_PRESETS.map { $0.toJSON() })),
                ("forCellFormat", .array(cellFormats.map { numberFormatForCellFormat($0).map(JSONValue.string) ?? .null })),
                ("cellFormatForCode", .array(presetCodes.map { cellFormatForNumberFormat($0).map(JSONValue.string) ?? .null })),
                ("isGeneral", .array(presetCodes.map { .bool(isGeneralNumberFormat($0)) })),
            ]))

        case "parseNumberFormatProps":
            let codes = list("codes").map { $0.stringValue! }
            return .array(codes.map { c in
                let nf = NumberFormat.parse(c)
                return .object(JSONObject([
                    ("code", .string(nf.code)),
                    ("kind", .string(nf.kind().rawValue)),
                    ("isGeneral", .bool(nf.isGeneral())),
                    ("isDate", .bool(nf.isDate())),
                    ("isPercent", .bool(nf.isPercent())),
                    ("isText", .bool(nf.isText())),
                ]))
            })

        case "compileChartFormatCode":
            let codes = list("codes").map { $0.stringValue! }
            return .array(codes.map { c in
                _ = compileChartFormatCode(c)
                return .bool(true)
            })

        case "formatNumberFormatValue":
            let codes = list("codes").map { $0.stringValue! }
            let values = list("values")
            return .array(codes.map { code in
                .array(values.map { val in
                    let r = formatNumberFormatValue(val, code)
                    let fillJson: JSONValue
                    if let fill = r.fill {
                        fillJson = .object(JSONObject([
                            ("char", .string(fill.char)),
                            ("index", .number(Double(fill.index))),
                        ]))
                    } else {
                        fillJson = .null
                    }
                    return .object(JSONObject([
                        ("text", .string(r.text)),
                        ("color", r.color.map(JSONValue.string) ?? .null),
                        ("cssColor", r.color.map { .string(numberFormatColorToCss($0)) } ?? .null),
                        ("numeric", .bool(r.numeric)),
                        ("fill", fillJson),
                    ]))
                })
            })

        case "formatTextFunction":
            let codes = list("codes").map { $0.stringValue! }
            let values = list("values")
            return .array(codes.map { code in
                .array(values.map { v in
                    formatTextFunction(v, code).toJSON()
                })
            })

        case "formatGeneralFit":
            let values = list("values").map { $0.numberValue! }
            let widths = list("widths").map { Int($0.numberValue!) }
            return .array(widths.map { w in
                .array(values.map { n in
                    formatGeneralFit(n, w).map(JSONValue.string) ?? .null
                })
            })

        case "formatChartValueWithCode":
            let codes = list("codes").map { $0.stringValue! }
            let values = list("values").map { $0.numberValue! }
            return .array(codes.map { code in
                .array(values.map { n in
                    .string(formatChartValueWithCode(n, code))
                })
            })

        case "parseCellInput":
            let inputs = list("inputs").map { $0.stringValue! }
            return .array(inputs.map { raw in
                .object(JSONObject([
                    ("parsed", parseCellInput(raw).toJSON()),
                    ("numText", parseNumberText(raw).map(JSONValue.number) ?? .null),
                ]))
            })

        case "dateTimeSerials":
            let dates = list("dates").map { d -> (Int, Int, Int) in
                let arr = d.arrayValue!
                return (Int(arr[0].numberValue!), Int(arr[1].numberValue!), Int(arr[2].numberValue!))
            }
            let serials = list("serials").map { $0.numberValue! }
            let times = list("times").map { t -> (Double, Double, Double) in
                let arr = t.arrayValue!
                return (arr[0].numberValue!, arr[1].numberValue!, arr[2].numberValue!)
            }
            let isoFmt = ISO8601DateFormatter()
            isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            isoFmt.timeZone = TimeZone(secondsFromGMT: 0)
            let roundTrip = [1.0, 61.0, 25569.0, 45366.0].map { s -> JSONValue in
                let ms = chartSerialToDate(s)
                let dt = Date(timeIntervalSince1970: ms / 1000.0)
                return .object(JSONObject([
                    ("iso", .string(isoFmt.string(from: dt))),
                    ("back", .number(chartDateToSerial(ms))),
                ]))
            }
            return .object(JSONObject([
                ("daysFromCivil", .array(dates.map { .number(Double(daysFromCivil($0.0, $0.1, $0.2))) })),
                ("daysInMonth", .array(dates.map { .number(Double(daysInMonth($0.0, $0.1))) })),
                ("daysInMonth1900", .array(dates.map { .number(Double(daysInMonth1900($0.0, $0.1))) })),
                ("serialFromYmd", .array(dates.map { serialFromYmd($0.0, $0.1, $0.2).map { .number(Double($0)) } ?? .null })),
                ("dateFromSerial", .array(serials.map { s in
                    let d = dateFromSerial(Int(floor(s)))
                    return .object(JSONObject([
                        ("year", .number(Double(d.year))),
                        ("month", .number(Double(d.month))),
                        ("day", .number(Double(d.day))),
                        ("weekday", .number(Double(d.weekday))),
                    ]))
                })),
                ("timeFraction", .array(times.map { .number(timeFraction($0.0, $0.1, $0.2)) })),
                ("dateValueToSerial", .array(["2024-03-15", "2024-03-15 12:00:00", "14:30", "not-a-date"].map {
                    dateValueToSerial($0).map(JSONValue.number) ?? .null
                })),
                ("chartSerialRoundTrip", .array(roundTrip)),
            ]))

        case let fn:
            throw NSError(domain: "ChartNumfmtVectorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown fn \(fn)"])
        }
    }

    func testNumfmtVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThanOrEqual(entries.count, 9)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            do {
                let got = try run(e)
                if let d = mismatch(got, e["out"]!, e["trig"]!.boolValue!) {
                    XCTFail("entry \(i) \(fn): \(d)")
                }
            } catch {
                XCTFail("entry \(i) \(fn) threw: \(error)")
            }
        }
    }
}
