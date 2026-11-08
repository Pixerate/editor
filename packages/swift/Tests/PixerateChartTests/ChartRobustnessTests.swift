import Foundation
import PixerateChart
import PixerateCore
import XCTest

/// Inputs from review of the chart port (#694) where Swift's Character-based strings, ICU regexes
/// or Int conversions differed from the TypeScript or crashed. Expected values come from the TS core.
final class ChartRobustnessTests: XCTestCase {
    func testCsvAndTsvQuoteFieldsWithCrLf() {
        // "\r\n" is one Swift Character, so Character-based contains("\n") missed it.
        XCTAssertEqual(serializeCsv([["a\r\nb", "c"]]), "\"a\r\nb\",c")
        XCTAssertEqual(serializeTsv([["a\r\nb", "c"]]), "\"a\r\nb\"\tc")
        XCTAssertEqual(escapeCsvField("\"\u{301}x"), "\"\"\"\u{301}x\"")
    }

    func testEscapingSeesMarkupFollowedByCombiningMarks() {
        let (spec, _) = normalizeChartSpec([
            "type": "bar", "title": "x\"\u{301} onload=\"y",
            "categories": ["A"], "series": [["id": "s", "name": "R&\u{301}D", "values": [1]]]
        ])
        let xml = chartToOoxml(spec).xml
        XCTAssertTrue(xml.contains("R&amp;\u{301}D"))
        let svg = chartToSvg(spec, width: 320, height: 200, ariaLabel: spec.title)
        XCTAssertFalse(svg.jsIncludes("x\"\u{301} onload"), "a quote before a combining mark must be escaped")
        XCTAssertTrue(svg.jsIncludes("x&quot;\u{301} onload=&quot;y"))
    }

    func testMermaidEdgeCasesMatchTs() {
        XCTAssertEqual(findMermaidCharts("\u{FEFF}xychart-beta\n    x-axis [a]\n    bar [1]").count, 1)
        let radar = chartFromMermaid("radar-beta\n    axis a, b, c\n    curve x{1,2,3}\n    ticks 1e19")
        XCTAssertEqual(radar.issues.count, 0)
        XCTAssertEqual(radar.spec.radarTicks, 50)
    }

    func testChartexReaderSkipsBadPointIndices() {
        let xml = """
        <cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chartData><cx:data id="0">\
        <cx:strDim type="cat"><cx:lvl ptCount="2"><cx:pt idx="-1">X</cx:pt><cx:pt idx="0">A</cx:pt><cx:pt idx="9999999999">Z</cx:pt></cx:lvl></cx:strDim>\
        <cx:numDim type="val"><cx:lvl ptCount="2"><cx:pt idx="-1">5</cx:pt><cx:pt idx="0">1</cx:pt><cx:pt idx="1e12">7</cx:pt></cx:lvl></cx:numDim>\
        </cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="treemap"><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>
        """
        _ = chartFromOoxml(xml) // must not trap or allocate a huge array
    }

    func testImportCsvRefusesInvalidDelimiters() {
        let controller = ChartController(ChartControllerOptions())
        let result = controller.importCsv("a;b", delimiter: ";;")
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.message, "Invalid CSV delimiter: \";;\"")
    }
}
