import Foundation
@testable import PixerateChart
import PixerateCore
import XCTest

final class ChartSvgMermaidVectorTests: XCTestCase {
    static let vectors: JSONObject = {
        let url = Bundle.module.url(forResource: "chart-svg-mermaid-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url)).objectValue!
    }()

    override class func setUp() {
        super.setUp()
        registerChartMap(EUROPE_CHART_MAP)
    }

    private func parseSvgOptions(_ val: JSONValue?) -> ChartSvgOptions {
        guard let obj = val?.objectValue else { return ChartSvgOptions() }
        return ChartSvgOptions(
            hideSelection: obj["hideSelection"]?.boolValue,
            ariaLabel: obj["ariaLabel"]?.stringValue,
            description: obj["description"]?.stringValue
        )
    }

    private func parseLayoutOptions(_ val: JSONValue?, width: Double, height: Double) -> ChartLayoutOptions {
        var obj = val?.objectValue ?? JSONObject()
        obj["width"] = .number(width)
        obj["height"] = .number(height)
        return ChartLayoutOptions(json: .object(obj))
    }

    func testSvgVectors() {
        let items = Self.vectors["svgVectors"]!.arrayValue!
        XCTAssertFalse(items.isEmpty)
        for item in items {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let spec = normalizeChartSpec(obj["spec"]!).spec
            let width = obj["width"]!.doubleValue!
            let height = obj["height"]!.doubleValue!
            let layoutOpts = parseLayoutOptions(obj["layoutOptions"], width: width, height: height)
            let svgOpts = parseSvgOptions(obj["svgOptions"])
            let scene = layoutChart(spec, layoutOpts)
            let gotSceneSvg = chartSceneToSvg(scene, svgOpts)
            let gotDirectSvg = chartToSvg(
                spec,
                width: width,
                height: height,
                theme: layoutOpts.theme,
                measureText: layoutOpts.measureText,
                emptyMessage: layoutOpts.emptyMessage,
                valueDomain: layoutOpts.valueDomain,
                valueDomain2: layoutOpts.valueDomain2,
                xDomain: layoutOpts.xDomain,
                readout: layoutOpts.readout,
                raceFrame: layoutOpts.raceFrame,
                hideSelection: svgOpts.hideSelection,
                ariaLabel: svgOpts.ariaLabel,
                description: svgOpts.description
            )
            XCTAssertEqual(gotSceneSvg, obj["sceneSvg"]!.stringValue!, "sceneSvg mismatch in \(name)")
            XCTAssertEqual(gotDirectSvg, obj["directSvg"]!.stringValue!, "directSvg mismatch in \(name)")
        }
    }

    func testDomSpecVectors() {
        let items = Self.vectors["domSpecVectors"]!.arrayValue!
        XCTAssertFalse(items.isEmpty)
        for item in items {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let spec = normalizeChartSpec(obj["spec"]!).spec
            let width = obj["width"]!.doubleValue!
            let height = obj["height"]!.doubleValue!
            let layoutOpts = parseLayoutOptions(obj["layoutOptions"], width: width, height: height)
            let svgOpts = parseSvgOptions(obj["svgOptions"])
            let extraAttrs: [(String, String)] = (obj["extraAttrs"]?.arrayValue ?? []).compactMap { pair in
                guard let arr = pair.arrayValue, arr.count == 2,
                      let k = arr[0].stringValue, let v = arr[1].stringValue else { return nil }
                return (k, v)
            }
            let scene = layoutChart(spec, layoutOpts)
            let domSpec = chartSceneToDomSpec(scene, svgOpts, attrs: extraAttrs)
            XCTAssertEqual(domSpec.toJSON(), obj["domSpec"]!, "domSpec mismatch in \(name)")
        }
    }

    func testSparklineVectors() {
        let items = Self.vectors["sparklineVectors"]!.arrayValue!
        XCTAssertFalse(items.isEmpty)
        for item in items {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let values: [ChartValue] = obj["values"]!.arrayValue!.map { $0.doubleValue }
            let options = ChartSparklineOptions(json: obj["options"]!)
            let got = sparklineToSvg(values, options)
            XCTAssertEqual(got, obj["svg"]!.stringValue!, "sparklineToSvg mismatch in \(name)")
        }
    }

    func testRasterPaintSizeAndFileNameVectors() {
        let paintItems = Self.vectors["paintVectors"]!.arrayValue!
        for item in paintItems {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let svg = obj["svg"]!.stringValue!
            let varsObj = obj["vars"]?.objectValue
            let color = obj["color"]?.stringValue
            let fontFamily = obj["fontFamily"]?.stringValue
            let lookupFn: (@Sendable (String) -> String)?
            if let dict = varsObj {
                lookupFn = { key in dict[key]?.stringValue ?? "" }
            } else {
                lookupFn = nil
            }
            let scope = ChartPaintScope(
                lookup: lookupFn,
                color: color,
                fontFamily: fontFamily
            )
            let got = resolveChartSvgPaints(svg, scope)
            XCTAssertEqual(got, obj["resolved"]!.stringValue!, "resolveChartSvgPaints mismatch in \(name)")
        }

        let sizeItems = Self.vectors["rasterSizeVectors"]!.arrayValue!
        for item in sizeItems {
            let obj = item.objectValue!
            let width = obj["width"]!.doubleValue!
            let height = obj["height"]!.doubleValue!
            let scale = obj["scale"]?.doubleValue ?? 2
            let maxSize = obj["maxSize"]?.doubleValue ?? CHART_RASTER_MAX_SIZE
            if let wantErr = obj["error"]?.stringValue {
                XCTAssertThrowsError(try chartRasterSize(width, height, scale: scale, maxSize: maxSize)) { err in
                    XCTAssertEqual(err.localizedDescription, wantErr)
                }
            } else {
                let got = try! chartRasterSize(width, height, scale: scale, maxSize: maxSize)
                XCTAssertEqual(got.toJSON(), obj["result"]!)
            }
        }

        let fileItems = Self.vectors["fileNameVectors"]!.arrayValue!
        for item in fileItems {
            let obj = item.objectValue!
            let title = obj["title"]!.stringValue!
            let ext = obj["extension"]!.stringValue!
            let spec = createChartSpec(.object(JSONObject([("title", .string(title))])))
            XCTAssertEqual(chartFileName(spec, ext), obj["fileName"]!.stringValue!)
        }
    }

    func testSankeyAndTreemapParserVectors() {
        let sankeyItems = Self.vectors["sankeyVectors"]!.arrayValue!
        for item in sankeyItems {
            let obj = item.objectValue!
            let source = obj["source"]!.stringValue!
            let got = parseSankey(source).toJSON()
            XCTAssertNil(firstChartDifference(got, obj["result"]!), "parseSankey mismatch for:\n\(source)")
        }

        let treemapItems = Self.vectors["treemapVectors"]!.arrayValue!
        for item in treemapItems {
            let obj = item.objectValue!
            let source = obj["source"]!.stringValue!
            let parsed = parseTreemap(source)
            XCTAssertNil(firstChartDifference(parsed.toJSON(), obj["result"]!), "parseTreemap mismatch for:\n\(source)")
            if case .data(let d) = parsed {
                let totals = JSONValue.array(d.items.map { .number(treemapValue($0)) })
                XCTAssertNil(firstChartDifference(totals, obj["totals"]!), "treemapValue mismatch for:\n\(source)")
            }
        }
    }

    func testMermaidExportAndRoundTripVectors() {
        let items = Self.vectors["mermaidExportVectors"]!.arrayValue!
        for item in items {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let spec = normalizeChartSpec(obj["spec"]!).spec
            let optsObj = obj["options"]?.objectValue
            let opts = ChartMermaidOptions(
                meta: optsObj?["meta"]?.boolValue,
                indent: optsObj?["indent"]?.stringValue
            )
            let gotFamily = chartMermaidFamily(spec).rawValue
            XCTAssertEqual(gotFamily, obj["family"]!.stringValue!, "chartMermaidFamily mismatch in \(name)")

            let gotMermaid = chartToMermaid(spec, opts)
            XCTAssertEqual(gotMermaid, obj["mermaid"]!.stringValue!, "chartToMermaid mismatch in \(name)")

            let gotRoundTrip = chartFromMermaid(gotMermaid).toJSON()
            XCTAssertNil(firstChartDifference(gotRoundTrip, obj["roundTrip"]!), "chartFromMermaid roundTrip mismatch in \(name)")

            let gotWithoutMeta = chartFromMermaid(gotMermaid, ChartMermaidParseOptions(ignoreMeta: true)).toJSON()
            XCTAssertNil(firstChartDifference(gotWithoutMeta, obj["withoutMeta"]!), "chartFromMermaid ignoreMeta mismatch in \(name)")
        }
    }

    func testMermaidParseAndFindVectors() {
        let parseItems = Self.vectors["mermaidParseVectors"]!.arrayValue!
        for item in parseItems {
            let obj = item.objectValue!
            let name = obj["name"]!.stringValue!
            let text = obj["text"]!.stringValue!
            let optsObj = obj["options"]?.objectValue
            let opts = ChartMermaidParseOptions(
                partial: optsObj?["partial"]?.boolValue,
                ignoreMeta: optsObj?["ignoreMeta"]?.boolValue
            )
            let got = chartFromMermaid(text, opts).toJSON()
            XCTAssertNil(firstChartDifference(got, obj["result"]!), "chartFromMermaid mismatch in \(name)")
        }

        let findItems = Self.vectors["findMermaidVectors"]!.arrayValue!
        for item in findItems {
            let obj = item.objectValue!
            let text = obj["text"]!.stringValue!
            let got = JSONValue.array(findMermaidCharts(text).map { $0.toJSON() })
            XCTAssertNil(firstChartDifference(got, obj["found"]!), "findMermaidCharts mismatch")
        }
    }

    func testRenderChartPngToolHookAndFallback() async throws {
        let initialSpec: JSONValue = [
            "type": "bar",
            "title": "Sales",
            "categories": ["Q1", "Q2"],
            "series": [["id": "s1", "name": "Revenue", "values": [10, 20]]],
        ]
        let controller = ChartController(ChartControllerOptions(spec: initialSpec))

        // Without rasterize hook: returns the documented error
        let regNoRaster = ToolRegistry()
        try regNoRaster.register(createChartToolProvider(controller))
        let errRes = await regNoRaster.callTool("render_chart", ["format": "png"])
        XCTAssertTrue(errRes.isError)
        XCTAssertEqual(
            errRes.text,
            "This host cannot rasterize charts; call render_chart with format \"svg\", or get_chart for the layout warnings."
        )

        // With rasterize hook: returns image + text content and structuredContent
        let regWithRaster = ToolRegistry()
        try regWithRaster.register(createChartToolProvider(
            controller,
            ChartToolProviderOptions(
                rasterize: { svg, size in
                    XCTAssertTrue(svg.hasPrefix("<svg "))
                    return ChartRasterImage(
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        mimeType: "image/png",
                        width: Int(size.width),
                        height: Int(size.height)
                    )
                }
            )
        ))
        let okRes = await regWithRaster.callTool("render_chart", ["format": "png", "width": 500, "height": 300])
        XCTAssertFalse(okRes.isError)
        XCTAssertEqual(okRes.content.count, 2)
        XCTAssertEqual(
            okRes.content[0],
            McpToolContent.image(
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                mimeType: "image/png"
            )
        )
        XCTAssertEqual(okRes.content[1], McpToolContent.text("Chart at 500 × 300. No layout warnings."))
        XCTAssertEqual(okRes.structuredContent?["width"], JSONValue.number(500))
        XCTAssertEqual(okRes.structuredContent?["height"], JSONValue.number(300))
        XCTAssertEqual(okRes.structuredContent?["mimeType"], JSONValue.string("image/png"))
    }
}
