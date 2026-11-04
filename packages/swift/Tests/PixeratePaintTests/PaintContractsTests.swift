import Foundation
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// The generated paint types against the bundled contract files they were made from.
final class PaintContractsTests: XCTestCase {
    func testToolNamesMatchToolsJSON() throws {
        let providers = try PaintContracts.toolProviders()
        let names = providers.flatMap { $0.tools.map(\.name) }
        XCTAssertEqual(names, PaintToolName.allCases.map(\.rawValue))
        XCTAssertEqual(names.count, PaintContractVersions.toolCount)
        for provider in providers {
            for tool in provider.tools {
                XCTAssertEqual(PaintToolName(rawValue: tool.name)?.provider, provider.id, tool.name)
                XCTAssertNotNil(tool.title, tool.name)
                XCTAssertEqual(tool.inputSchema.objectValue?["type"], "object", tool.name)
            }
        }
        XCTAssertEqual(try PaintContracts.tool(.paintStroke).annotations?.readOnlyHint, false)
    }

    func testDefinitionsRoundTripToTheContractJSON() throws {
        let json = try PaintContracts.json("tools.json")
        let tools = json.objectValue?["providers"]?.arrayValue?.compactMap { $0.objectValue?["tools"]?.arrayValue }.flatMap { $0 } ?? []
        let parsed = try PaintContracts.toolProviders().flatMap(\.tools)
        XCTAssertEqual(parsed.count, tools.count)
        for (definition, raw) in zip(parsed, tools) {
            XCTAssertEqual(definition.json, raw, definition.name)
        }
    }

    func testCommandsMatchCommandsJSON() throws {
        let commands = try PaintContracts.commands()
        XCTAssertEqual(commands.map(\.id), PaintCommandID.allCases.map(\.rawValue))
        XCTAssertEqual(commands.count, PaintContractVersions.commandCount)
        let undo = try XCTUnwrap(commands.first { $0.id == PaintCommandID.undo.rawValue })
        XCTAssertEqual(undo.tool, PaintToolName.undoPaint.rawValue)
        for command in commands where command.tool != nil {
            XCTAssertNotNil(PaintToolName(rawValue: command.tool!), command.id)
        }
    }

    func testUITablesDecode() throws {
        let ui = try PaintContracts.uiTables()
        XCTAssertTrue(ui.tools.contains { $0.id == "brush" })
        XCTAssertEqual(ui.layerEffects.count, 10)
        XCTAssertFalse(ui.brushOptions.isEmpty)
        XCTAssertFalse(ui.blendMenu.isEmpty)
    }

    func testVersionsMatchTheManifest() throws {
        let manifest = try XCTUnwrap(PaintContracts.json("manifest.json").objectValue)
        XCTAssertEqual(manifest["document"]?.objectValue?["kind"]?.stringValue, PaintContractVersions.documentKind)
        XCTAssertEqual(manifest["document"]?.objectValue?["version"]?.numberValue, Double(PaintContractVersions.paintVersion))
        XCTAssertEqual(manifest["formatVersion"]?.numberValue, Double(PaintContractVersions.formatVersion))
    }

    /// Every call the recorded scenarios make reads into its typed arguments, and the schema
    /// refuses the ones the TypeScript core refused as invalid.
    func testScenarioArgumentsReadIntoTypedArguments() throws {
        let dir = ConformanceContracts.url("domains/paint/fixtures")
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertFalse(files.isEmpty)
        let definitions = Dictionary(uniqueKeysWithValues: try PaintContracts.toolProviders().flatMap(\.tools).map { ($0.name, $0) })
        var read = 0
        for file in files {
            let scenario = try XCTUnwrap(JSONValue.parse(Data(contentsOf: dir.appendingPathComponent(file))).objectValue)
            for step in scenario["steps"]?.arrayValue ?? [] {
                let step = try XCTUnwrap(step.objectValue)
                let name = try XCTUnwrap(step["tool"]?.stringValue)
                let tool = try XCTUnwrap(PaintToolName(rawValue: name), "\(file): \(name)")
                let args = step["arguments"]?.objectValue ?? JSONObject()
                let invalid = step["expect"]?.objectValue?["result"]?.objectValue?["error"]?.objectValue?["code"] == "invalid_arguments"
                let errors = validateJSONSchema(.object(args), definitions[name]?.inputSchema)
                XCTAssertEqual(!errors.isEmpty, invalid, "\(file): \(name) \(errors)")
                guard !invalid else { continue }
                XCTAssertNoThrow(try paintToolArguments(tool, args), "\(file): \(name)")
                read += 1
            }
        }
        XCTAssertGreaterThan(read, 100)
        let stroke = try PaintStrokeArguments(["points": [["x": 1, "y": 2]], "seed": 7, "color": "#ff0000"])
        XCTAssertEqual(stroke.seed, 7)
        XCTAssertEqual(stroke.points.count, 1)
        XCTAssertNil(stroke.layerId)
        XCTAssertThrowsError(try PaintStrokeArguments([:])) { XCTAssertEqual(($0 as? ToolArgumentError)?.message, "points is required.") }
        XCTAssertEqual(try ExportImageArguments(["format": "image/png"]).format, .imagePng)
    }
}
