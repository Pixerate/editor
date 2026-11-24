import Foundation
@testable import PixerateChart
import PixerateCore
import XCTest

/// The chart UI components (#819) against the TypeScript renders (`chart-ui-components-vectors.json`,
/// written by `swift-chart-ui-components-vectors.test.ts`): the same SVG, byte for byte, and the
/// same refusals.
final class ChartUiComponentVectorTests: XCTestCase {
    static let vectors: JSONObject = {
        let url = Bundle.module.url(forResource: "chart-ui-components-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url)).objectValue!
    }()

    private func options(_ v: JSONValue) -> ChartUiRenderOptions {
        var colors: [String: String] = [:]
        for (k, c) in v["colors"]?.objectValue ?? JSONObject() { if let s = c.stringValue { colors[k] = s } }
        return ChartUiRenderOptions(
            width: v["width"]!.numberValue!,
            height: v["height"]!.numberValue!,
            theme: ChartUiThemeMode(rawValue: v["theme"]?.stringValue ?? "light")!,
            colors: colors
        )
    }

    func testListsTheSwiftReadyTypesWithTheirDescriptors() throws {
        let list = try chartUiComponents()
        XCTAssertEqual(list.map(\.id), ["sparkline", "bar-chart", "line-chart", "donut-chart"])
        for c in list {
            XCTAssertEqual(c.descriptor["implements"]?.stringValue, c.id)
            XCTAssertEqual(c.descriptor["platforms"], ["html-page", "swiftui"])
            XCTAssertEqual(c.descriptor["swiftReady"], true)
            XCTAssertNotNil(c.descriptor["contentHash"]?.stringValue)
            XCTAssertFalse(c.colorRoles.isEmpty)
            for mode in ChartUiThemeMode.allCases {
                XCTAssertEqual(Set(c.defaultColors[mode]!.keys), Set(c.colorRoles), "\(c.id) \(mode)")
            }
            XCTAssertEqual(Set(c.colorRoleUse.keys), Set(c.colorRoles))
        }
    }

    func testRendersMatchTypeScript() throws {
        let byId = Dictionary(uniqueKeysWithValues: try chartUiComponents().map { ($0.id, $0) })
        let items = Self.vectors["renders"]!.arrayValue!
        XCTAssertFalse(items.isEmpty)
        for item in items {
            let name = item["name"]!.stringValue!
            let c = byId[item["id"]!.stringValue!]!
            let got = try c.render(item["data"]!, options(item["options"]!))
            XCTAssertEqual(got, item["svg"]!.stringValue!, "svg mismatch in \(name)")
        }
    }

    func testTheExampleRendersAreTheOnesTheContentHashCovers() throws {
        // The descriptor's contentHash covers the example drawn at its example size in light and dark:
        // those renders are in the vectors, so equal renders mean the hash describes Swift's output.
        let renders = Self.vectors["renders"]!.arrayValue!
        for c in try chartUiComponents() {
            for mode in ChartUiThemeMode.allCases {
                let item = renders.first { $0["name"]?.stringValue == "\(c.id) example \(mode.rawValue)" }!
                XCTAssertEqual(item["data"], c.example)
                XCTAssertEqual(item["options"]?["width"]?.numberValue, c.exampleSize.width)
                XCTAssertEqual(item["options"]?["height"]?.numberValue, c.exampleSize.height)
                let got = try c.render(c.example, ChartUiRenderOptions(width: c.exampleSize.width, height: c.exampleSize.height, theme: mode))
                XCTAssertEqual(got, item["svg"]!.stringValue!, "\(c.id) \(mode)")
            }
        }
    }

    func testFallbacksMatchTypeScript() throws {
        let byId = Dictionary(uniqueKeysWithValues: try chartUiComponents().map { ($0.id, $0) })
        let items = Self.vectors["fallbacks"]!.arrayValue!
        XCTAssertFalse(items.isEmpty)
        for c in byId.values { XCTAssertEqual(c.descriptor["fallback"]?.stringValue, "table") }
        for item in items {
            let name = item["name"]!.stringValue!
            let c = byId[item["id"]!.stringValue!]!
            if let error = item["error"]?.stringValue {
                XCTAssertThrowsError(try c.fallback(item["data"]!), name) { e in
                    XCTAssertEqual((e as? ChartUiError)?.message, error, name)
                }
            } else {
                XCTAssertEqual(try c.fallback(item["data"]!), item["fallback"]!, name)
            }
        }
    }

    func testRefusesWithTheSameMessages() throws {
        let byId = Dictionary(uniqueKeysWithValues: try chartUiComponents().map { ($0.id, $0) })
        for item in Self.vectors["errors"]!.arrayValue! {
            let name = item["name"]!.stringValue!
            let c = byId[item["id"]!.stringValue!]!
            XCTAssertThrowsError(try c.render(item["data"]!, options(item["options"]!)), name) { error in
                XCTAssertEqual((error as? ChartUiError)?.message, item["error"]!.stringValue!, name)
            }
        }
    }

    func testDrawingGivesTheSceneAndItsAccessibleName() throws {
        let bar = try chartUiComponents().first { $0.id == "bar-chart" }!
        let d = try bar.drawing(bar.example, ChartUiRenderOptions(width: 480, height: 300, theme: .dark))
        XCTAssertEqual(d.scene.width, 480)
        XCTAssertEqual(d.scene.height, 300)
        XCTAssertEqual(d.ariaLabel, "Quarterly revenue")
        XCTAssertFalse(d.description.isEmpty)
        XCTAssertFalse(d.scene.marks.isEmpty)
    }

    func testPaletteWithAccentDropsColoursTooCloseToIt() {
        XCTAssertEqual(chartPaletteWithAccent("#4269d0"), DEFAULT_CHART_PALETTE)
        let p = chartPaletteWithAccent("#97bbf5")
        XCTAssertEqual(p.first, "#97bbf5")
        XCTAssertFalse(p.dropFirst().contains("#97bbf5"))
        XCTAssertEqual(chartPaletteWithAccent("not a colour").count, DEFAULT_CHART_PALETTE.count)
    }
}
