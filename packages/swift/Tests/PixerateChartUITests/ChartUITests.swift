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
        XCTAssertNotEqual(model.spec.palette.first, "#e69f00")

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
