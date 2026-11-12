import CoreGraphics
import Foundation
import PixerateChart
import PixerateContracts
import PixerateCore
import PixerateRaster
import SwiftUI
import XCTest
@testable import PixerateChartUI

@MainActor
final class ChartUITests: XCTestCase {
    func testCoreTextChartMeasureText() {
        XCTAssertEqual(coreTextChartMeasureText("", 12, nil), 0)
        let normal = coreTextChartMeasureText("Quarterly Revenue", 12, 400)
        let bold = coreTextChartMeasureText("Quarterly Revenue", 12, 700)
        let larger = coreTextChartMeasureText("Quarterly Revenue", 18, 400)
        XCTAssertGreaterThan(normal, 40)
        XCTAssertGreaterThanOrEqual(bold, normal)
        XCTAssertGreaterThan(larger, normal)
    }

    func testChartDisplayTickerDrivesBarRace() {
        let ticker = ChartDisplayTicker(manual: true, initialTimeMs: 1000)
        let spec: JSONValue = [
            "type": "barrace",
            "title": "Race",
            "categories": ["2021", "2022", "2023"],
            "series": [
                ["id": "s1", "name": "Alpha", "values": [10, 20, 30]],
                ["id": "s2", "name": "Beta", "values": [15, 18, 35]]
            ]
        ]
        let controller = ChartController(
            ChartControllerOptions(spec: spec, raceTicker: ticker.raceTicker)
        )
        XCTAssertTrue(controller.playRace(msPerStep: 100).ok)
        XCTAssertEqual(controller.getState().racePlaying, true)
        XCTAssertEqual(controller.getState().raceFrame, 0)
        XCTAssertEqual(ticker.pendingCount, 1)

        ticker.advance(50)
        XCTAssertEqual(controller.getState().raceFrame!, 0.5, accuracy: 1e-6)
        XCTAssertEqual(ticker.pendingCount, 1)

        ticker.advance(200)
        XCTAssertEqual(controller.getState().racePlaying, false)
        XCTAssertNil(controller.getState().raceFrame)
        XCTAssertEqual(ticker.pendingCount, 0)
    }

    func testChartEditorModelToolsAndPngRasterization() async throws {
        let model = try ChartEditorModel(width: 480, height: 300)
        let toolNames = Set(model.registry.listTools().map(\.name))
        XCTAssertTrue(toolNames.contains("get_chart"))
        XCTAssertTrue(toolNames.contains("render_chart"))
        XCTAssertTrue(toolNames.contains("check_chart_style"))
        XCTAssertTrue(toolNames.contains("list_open_files"))
        XCTAssertTrue(toolNames.contains("run_command"))
        XCTAssertTrue(toolNames.contains("list_commands"))

        // Call render_chart with format: "png" through the ToolRegistry
        let res = await model.registry.callTool("render_chart", ["format": "png", "width": 320, "height": 200])
        XCTAssertFalse(res.isError, res.text ?? "")
        XCTAssertEqual(res.content.count, 2)
        guard case .image(let base64, let mimeType) = res.content[0] else {
            XCTFail("Expected first content item to be an image")
            return
        }
        XCTAssertEqual(mimeType, "image/png")
        let pngData = try XCTUnwrap(Data(base64Encoded: base64))
        let decoded = try decodePng([UInt8](pngData))
        XCTAssertEqual(decoded.width, 640)
        XCTAssertEqual(decoded.height, 400)
        XCTAssertGreaterThan(decoded.data.count, 0)
    }

    func testParseChartRGBAReturnsUnitComponents() throws {
        let red = try XCTUnwrap(parseChartRGBA("#ff0000"))
        XCTAssertEqual(red.r, 1, accuracy: 1e-9)
        XCTAssertEqual(red.g, 0, accuracy: 1e-9)
        XCTAssertEqual(red.a, 1, accuracy: 1e-9)
        let grey = try XCTUnwrap(parseChartRGBA("rgb(128, 128, 128)", opacity: 0.5))
        XCTAssertEqual(grey.r, 128.0 / 255.0, accuracy: 1e-9)
        XCTAssertEqual(grey.a, 0.5, accuracy: 1e-9)
        let named = try XCTUnwrap(parseChartRGBA("white"))
        XCTAssertEqual(named.b, 1, accuracy: 1e-9)
    }

    /// Paints read like SVG reads them: `#rgba` / `#rrggbbaa` and `rgb(… / a)` carry alpha.
    func testParseChartRGBAReadsAlpha() throws {
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("#ff000080")).a, 128.0 / 255.0, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("#F008", opacity: 0.5)).a, (136.0 / 255.0) * 0.5, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("#F008")).r, 1, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("rgb(0 0 255 / 25%)")).a, 0.25, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("rgba(0, 0, 255, 0.4)")).b, 1, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("rgba(0, 0, 255, 0.4)")).a, 0.4, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(parseChartRGBA("#ff0000", opacity: .nan)).a, 1, accuracy: 1e-9)
        XCTAssertNil(parseChartRGBA("none"))
    }

    /// A mark's `opacity` applies to its fill and stroke together (SVG group opacity): where the
    /// stroke covers the fill, the pixel is the colour at that opacity, not the two layered.
    func testMarkOpacityCompositesFillAndStrokeAsOneGroup() throws {
        let mark = ChartMark.rect(ChartRectMark(key: "r", role: .bar, x: 2, y: 2, width: 12, height: 12, fill: "#ff0000", stroke: "#ff0000", strokeWidth: 4, opacity: 0.5))
        let scene = ChartScene(width: 16, height: 16, plot: ChartRect(x: 0, y: 0, width: 16, height: 16), marks: [mark])
        var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
        pixels.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            drawChartSceneInCGContext(scene, context: ctx)
        }
        // (3, 3) lies under both the fill and the stroke; row 3 from the top.
        let alpha = pixels[(3 * 16 + 3) * 4 + 3]
        XCTAssertEqual(Double(alpha), 127.5, accuracy: 1.5, "fill and stroke at 0.5 each would give 191")
    }

    func testRenderChartPngUsesTheRequestedRaceFrame() async throws {
        let model = try ChartEditorModel(width: 320, height: 200)
        let data = await model.registry.callTool("set_chart_data", [
            "categories": ["2021", "2022", "2023"],
            "series": [
                ["name": "Alpha", "values": [10, 20, 90]],
                ["name": "Beta", "values": [80, 18, 5]]
            ]
        ])
        XCTAssertFalse(data.isError, data.text ?? "")
        let type = await model.registry.callTool("update_chart", ["type": "barrace"])
        XCTAssertFalse(type.isError, type.text ?? "")
        func png(_ time: Double) async throws -> String {
            let res = await model.registry.callTool("render_chart", ["format": "png", "time": .number(time)])
            XCTAssertFalse(res.isError, res.text ?? "")
            guard case .image(let data, _) = res.content[0] else { XCTFail("no image"); return "" }
            return data
        }
        let first = try await png(0)
        let last = try await png(2)
        XCTAssertNotEqual(first, last, "render_chart png must draw the frame at `time`")
        let again = try await png(0)
        XCTAssertEqual(first, again)
    }

    func testChartEditorModelInteractionClickDragHoverAndKeys() throws {
        let ticker = ChartDisplayTicker(manual: true)
        let model = try ChartEditorModel(
            displayTicker: ticker,
            measureText: estimateChartTextWidth,
            width: 640,
            height: 400
        )

        // Find a bar mark for point (s1, 0)
        let barMark = try XCTUnwrap(model.scene.marks.first { mark in
            mark.target == .point(seriesId: "s1", index: 0)
        })
        guard case .rect(let barRect) = barMark else {
            XCTFail("Expected bar mark to be a rect")
            return
        }
        let cx = barRect.x + barRect.width / 2.0
        let cy = barRect.y + barRect.height / 2.0

        // Hover over bar updates tooltip
        model.pointerMove(x: cx, y: cy)
        XCTAssertNotNil(model.tooltip)
        XCTAssertEqual(model.tooltip?.title, "Q1")
        model.pointerLeave()
        XCTAssertNil(model.tooltip)

        // Pointer down on bar selects point and starts a point drag
        let initialVal = try XCTUnwrap(model.spec.series[0].values[0])
        XCTAssertTrue(model.pointerDown(x: cx, y: barRect.y + 2))
        XCTAssertEqual(model.selection, .point(seriesId: "s1", index: 0))
        XCTAssertTrue(model.isDraggingPoint)
        XCTAssertNotNil(model.dragReadout)

        // Dragging upwards increases value in one merged gesture
        model.pointerMove(x: cx, y: barRect.y - 30)
        model.pointerMove(x: cx, y: barRect.y - 50)
        model.pointerUp()
        XCTAssertFalse(model.isDraggingPoint)
        XCTAssertNil(model.dragReadout)
        let draggedVal = try XCTUnwrap(model.spec.series[0].values[0])
        XCTAssertGreaterThan(draggedVal, initialVal)
        XCTAssertTrue(model.state.canUndo)

        // Single undo restores the value prior to the drag
        XCTAssertTrue(model.handleKey("z", mod: true))
        XCTAssertEqual(model.spec.series[0].values[0], initialVal)
        XCTAssertTrue(model.handleKey("z", shift: true, mod: true))
        XCTAssertEqual(model.spec.series[0].values[0], draggedVal)

        // Keyboard navigation: ArrowRight selects index 1, ArrowUp nudges value, Escape clears selection
        XCTAssertTrue(model.handleKey("ArrowRight"))
        XCTAssertEqual(model.selection, .point(seriesId: "s1", index: 1))
        let beforeNudge = try XCTUnwrap(model.spec.series[0].values[1])
        XCTAssertTrue(model.handleKey("ArrowUp", shift: true))
        let afterNudge = try XCTUnwrap(model.spec.series[0].values[1])
        XCTAssertGreaterThan(afterNudge, beforeNudge)
        XCTAssertTrue(model.handleKey("Escape"))
        XCTAssertNil(model.selection)
    }

    func testInspectorPresetsSchemesShadesAndErrorBars() throws {
        let model = try ChartEditorModel()
        XCTAssertFalse(model.ui.layoutPresets.isEmpty)
        XCTAssertFalse(model.ui.colorSchemes.isEmpty)
        XCTAssertFalse(model.ui.paletteShades.isEmpty)
        XCTAssertFalse(model.ui.errorBars.types.isEmpty)

        XCTAssertTrue(model.applyLayoutPreset("minimal"))
        XCTAssertEqual(model.spec.legend.show, false)

        XCTAssertTrue(model.applyColorScheme("okabe-ito"))
        XCTAssertEqual(model.spec.palette.first, "#e69f00")

        XCTAssertTrue(model.applyPaletteShade(0.4))
        let once = model.spec.palette.first
        XCTAssertNotEqual(once, "#e69f00")
        // Shade buttons pick a shade of the original palette rather than compounding.
        XCTAssertTrue(model.applyPaletteShade(0.4))
        XCTAssertEqual(model.spec.palette.first, once)
        XCTAssertTrue(model.applyPaletteShade(0))
        XCTAssertEqual(model.spec.palette.first, "#e69f00")

        XCTAssertTrue(model.setSeriesErrorBars(seriesId: "s1", type: .percent, value: 15, direction: .both))
        XCTAssertEqual(model.spec.series.first?.errorBars?.type, .percent)
        XCTAssertEqual(model.spec.series.first?.errorBars?.value, 15)
        XCTAssertTrue(model.setSeriesErrorBars(seriesId: "s1", type: nil))
        XCTAssertNil(model.spec.series.first?.errorBars)
    }

    #if os(macOS)
    func testChartViewSnapshotRendersMarks() throws {
        let model = try ChartEditorModel(width: 480, height: 320)
        _ = model.setType(.donut)
        let renderer = ImageRenderer(
            content: ChartView(model: model, interactive: false).frame(width: 480, height: 320)
        )
        renderer.scale = 1
        let cgImage = try XCTUnwrap(renderer.cgImage)
        XCTAssertEqual(cgImage.width, 480)
        XCTAssertEqual(cgImage.height, 320)

        let editorView = ChartEditorView(model: model)
        XCTAssertNotNil(editorView.body)
    }
    #endif
}
