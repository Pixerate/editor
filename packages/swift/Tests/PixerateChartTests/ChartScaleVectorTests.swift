import Foundation
import PixerateChart
import PixerateCore
import XCTest

final class ChartScaleVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "chart-scale-vectors", withExtension: "json", subdirectory: "Fixtures")!
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
        case "niceStep":
            return .array(list("cases").map { c in
                let a = c.arrayValue!
                return .number(niceStep(a[0].numberValue!, a[1].numberValue!))
            })

        case "niceScale":
            return .array(list("cases").map { c in
                let a = c.arrayValue!
                return niceScale(
                    a[0].numberValue!,
                    a[1].numberValue!,
                    a[2].numberValue!,
                    a[3].numberValue,
                    a[4].numberValue
                ).toJSON()
            })

        case "stepDecimals":
            return .array(list("steps").map { .number(Double(stepDecimals($0.numberValue!))) })

        case "formatChartNumber":
            let formats = list("formats").map { ChartNumberFormat(json: $0)! }
            let values = list("values").map { $0.numberValue }
            let fallbacks = list("fallbacks").map { $0.numberValue.map { Int($0) } }
            return .array(formats.map { fmt in
                .array(fallbacks.map { fb in
                    .array(values.map { v in
                        .string(formatChartNumber(v, fmt, fb))
                    })
                })
            })

        case "niceLogScale":
            return .array(list("cases").map { c in
                let a = c.arrayValue!
                return niceLogScale(
                    a[0].numberValue!,
                    a[1].numberValue!,
                    a[2].numberValue!,
                    a[3].numberValue!,
                    a[4].numberValue,
                    a[5].numberValue
                ).toJSON()
            })

        case "chartScalePixels":
            let scales = list("scales").map { s -> ChartValueScale in
                ChartValueScale(json: s)!
            }
            let values = list("values").map { $0.numberValue! }
            let pixels = list("pixels").map { $0.numberValue! }
            return .object(JSONObject([
                ("toPixel", .array(scales.map { s in
                    .array(values.map { v in .number(chartScaleToPixel(v, s)) })
                })),
                ("fromPixel", .array(scales.map { s in
                    .array(pixels.map { px in .number(chartScaleFromPixel(px, s)) })
                })),
                ("linear", .array(values.map { v in .number(linearMap(v, (0, 100), (50, 250))) })),
            ]))

        case "parseChartDate":
            return .array(list("inputs").map { s in
                parseChartDate(s.stringValue!).map(JSONValue.number) ?? .null
            })

        case "chartDateLabels":
            let catSets = list("categorySets").map { $0.arrayValue!.map { $0.stringValue! } }
            let bands = list("bands").map { $0.numberValue! }
            return .array(catSets.map { cats in
                .array(bands.map { band in
                    chartDateLabels(cats, band, { Double($0.utf16.count) * 7.0 })?.toJSON() ?? .null
                })
            })

        case "formatChartDate":
            let dates = list("dates").map { $0.numberValue! }
            return .array(CHART_DATE_STEPS.map { step in
                .array(dates.enumerated().map { idx, d in
                    .string(formatChartDate(d, step, idx > 0 ? dates[idx - 1] : nil))
                })
            })

        case "parseChartColor":
            return .array(list("colors").map { c in
                parseChartColor(c.stringValue!).map { .array($0.map(JSONValue.number)) } ?? .null
            })

        case "colorMath":
            let rgbs: [ChartRgb] = list("rgbs").map { $0.arrayValue!.map { $0.numberValue! } }
            let palette = list("colors").map { $0.stringValue! }
            let rawColors = [
                "#4269d0",
                "#efb118",
                "#ff725c",
                "#6cc5b0",
                "#3ca951",
                "#fff",
                "#000000",
                "#336699cc",
                "#f0a8",
                "rgb(255, 0, 128)",
                "rgba(30, 144, 255, 0.5)",
                "var(--primary, #2563eb)",
                "invalid",
            ]
            return .object(JSONObject([
                ("hex", .array(rgbs.map { .string(chartRgbToHex($0)) })),
                ("luminance", .array(rgbs.map { .number(chartLuminance($0)) })),
                ("oklab", .array(rgbs.map { .array(chartRgbToOklab($0).map(JSONValue.number)) })),
                ("contrast", .array(rawColors.map { chartContrastRatio($0, "#ffffff").map(JSONValue.number) ?? .null })),
                ("textOn", .array(rawColors.map { .string(chartTextOn($0, "#000000")) })),
                ("distance", .array(rgbs.enumerated().map { i, c in
                    .number(chartColorDistance(c, rgbs[(i + 1) % rgbs.count]))
                })),
                ("protanopia", .array(rgbs.map { .array(simulateChartVision($0, .protanopia).map(JSONValue.number)) })),
                ("deuteranopia", .array(rgbs.map { .array(simulateChartVision($0, .deuteranopia).map(JSONValue.number)) })),
                ("tritanopia", .array(rgbs.map { .array(simulateChartVision($0, .tritanopia).map(JSONValue.number)) })),
                ("checkDefault", checkChartColors(palette).toJSON()),
                ("checkBad", checkChartColors(["#ffffaa", "#ffffbb", "#228822", "#886622"]).toJSON()),
                ("shades", .array([-0.5, -0.2, 0.0, 0.25, 0.6].map { .string(shadeChartColor("#4269d0", $0)) })),
                ("cycled", .array((0 ..< 25).map { .string(cyclePaletteColor(Array(palette.prefix(4)), $0)) })),
            ]))

        case "chartHistogram":
            let dataSets = list("dataSets").map { $0.arrayValue!.map { $0.numberValue } }
            return .array(dataSets.map { ds in
                .object(JSONObject([
                    ("auto", .array(chartHistogram(ds).map { $0.toJSON() })),
                    ("bins4", .array(chartHistogram(ds, 4).map { $0.toJSON() })),
                ]))
            })

        case "chartQuantile":
            let sortedSets = list("sortedSets").map { $0.arrayValue!.map { $0.numberValue! } }
            let qs = list("qs").map { $0.numberValue! }
            return .array(sortedSets.map { s in
                .array(qs.map { q in .number(chartQuantile(s, q)) })
            })

        case "chartBoxStats":
            let dataSets = list("dataSets").map { $0.arrayValue!.map { $0.numberValue } }
            return .array(dataSets.map { ds in chartBoxStats(ds)?.toJSON() ?? .null })

        case "chartSquarify":
            let inputs = list("inputs").map { $0.arrayValue!.map { $0.numberValue! } }
            let r = e["rect"]!
            let rect = ChartRect(
                x: r["x"]!.numberValue!,
                y: r["y"]!.numberValue!,
                width: r["width"]!.numberValue!,
                height: r["height"]!.numberValue!
            )
            return .array(inputs.map { vals in
                .array(chartSquarify(vals, rect).map { $0.toJSON() })
            })

        case "decimateChartPoints":
            let pts = list("points").map { ChartPoint2D(x: $0["x"]!.numberValue!, y: $0["y"]!.numberValue!) }
            return .object(JSONObject([
                ("keepAll", .array(decimateChartPoints(pts, 100).map { $0.toJSON() })),
                ("decimated", .array(decimateChartPoints(pts, 10).map { $0.toJSON() })),
            ]))

        case "summarizeChartSeries":
            let categories = list("categories").map { $0.stringValue! }
            let seriesList = list("seriesList").map { ChartSeries(json: $0)! }
            let spec = createChartSpec(.object(JSONObject([
                ("categories", e["categories"]!),
                ("series", e["seriesList"]!),
            ])))
            let refs = suggestChartReferences(spec)
            return .object(JSONObject([
                ("summaries", .array(seriesList.map { summarizeChartSeries($0, categories).toJSON() })),
                ("references", .object(JSONObject([
                    ("line", refs.line.toJSON()),
                    ("band", refs.band.toJSON()),
                ]))),
            ]))

        case "fitChartTrendline":
            let trendlines = list("trendlines").map { ChartTrendline(json: $0)! }
            let points = list("points").map { p -> (Double, Double) in
                let a = p.arrayValue!
                return (a[0].numberValue!, a[1].numberValue!)
            }
            let expPoints = list("expPoints").map { p -> (Double, Double) in
                let a = p.arrayValue!
                return (a[0].numberValue!, a[1].numberValue!)
            }
            let evalXs = list("evalXs").map { $0.numberValue! }
            return .array(trendlines.map { t in
                let pts = (t.type == .exponential || t.type == .power) ? expPoints : points
                let fit = fitChartTrendline(t, pts)
                let fitJson: JSONValue
                if let fit {
                    fitJson = .object(JSONObject([
                        ("type", .string(fit.type.rawValue)),
                        ("coefficients", .array(fit.coefficients.map(JSONValue.number))),
                        ("r2", fit.r2.map(JSONValue.number) ?? .null),
                        ("equation", .string(fit.equation)),
                        ("points", .number(Double(fit.points))),
                        ("evaluated", .array(evalXs.map { x in fit.evaluate(x).map(JSONValue.number) ?? .null })),
                    ]))
                } else {
                    fitJson = .null
                }
                return .object(JSONObject([
                    ("name", .string(chartTrendlineName(t, "Revenue"))),
                    ("fit", fitJson),
                ]))
            })

        case "trendHelpers":
            let points = list("points").map { p -> (Double, Double) in
                let a = p.arrayValue!
                return (a[0].numberValue!, a[1].numberValue!)
            }
            let coeffNums = list("coeffNums").map { $0.numberValue! }
            func ptsJson(_ pts: [(Double, Double)]) -> JSONValue {
                .array(pts.map { .array([.number($0.0), .number($0.1)]) })
            }
            let supportPairs = [
                ("bar", "none"),
                ("bar", "stacked"),
                ("line", "none"),
                ("pie", "none"),
                ("scatter", "none"),
            ]
            return .object(JSONObject([
                ("numbers", .array(coeffNums.map { .string(trendNumberText($0)) })),
                ("ma2", ptsJson(chartMovingAverage(points, 2))),
                ("ma3", ptsJson(chartMovingAverage(points, 3))),
                ("supports", .array(supportPairs.map { .bool(chartSupportsTrendlines($0.0, $0.1)) })),
            ]))

        case "errorBars":
            let ebValues = list("values").map { $0.numberValue }
            let bars = list("bars").map { ChartErrorBars(json: $0)! }
            let types: [ChartErrorBarType?] = list("types").map {
                guard let s = $0.stringValue else { return nil }
                return ChartErrorBarType(rawValue: s)
            }
            let defaultTypes: [ChartErrorBarType] = [.fixed, .percent, .stddev, .stderr, .custom]
            return .object(JSONObject([
                ("defaults", .array(defaultTypes.map { defaultChartErrorBarValue($0).map(JSONValue.number) ?? .null })),
                ("amounts", .array(bars.map { b in
                    .array(chartErrorAmounts(b, ebValues).map { $0?.toJSON() ?? .null })
                })),
                ("descriptions", .array(bars.map { .string(describeChartErrorBars($0)) })),
                ("switched", .array(types.map { t in
                    chartErrorBarsOfType(t, bars[1], ebValues)?.toJSON() ?? .null
                })),
                ("formatted", .string(formatChartAmountList([1, 2.5, nil, 0]))),
                ("parsed", .array(parseChartAmountList("1, 2.5, - ; 0  4").map { $0.map(JSONValue.string) ?? .null })),
            ]))

        case let fn:
            throw NSError(domain: "ChartScaleVectorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown fn \(fn)"])
        }
    }

    func testScaleVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThanOrEqual(entries.count, 19)
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
