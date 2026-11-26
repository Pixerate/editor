import CoreGraphics
import Foundation
import PixerateCore
import PixeratePaint
import SwiftUI
import XCTest
@testable import PixeratePaintUI

/// Paint proposals drawn as ghosts over the canvas (`PaintEditorModel.showProposals`, `<PaintCanvas proposals>` on the web).
@MainActor
final class PaintProposalGhostTests: XCTestCase {
    private func line(_ y: Double) -> [JSONValue] {
        (0..<12).map { i in .object(["x": .number(60 + Double(i) * 30), "y": .number(y), "pressure": 0.7]) }
    }

    private func model() throws -> (PaintEditorModel, PaintProposals) {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 512, height: 384))
        let store = PaintProposals(controller: model.controller, origin: "agent:pixie")
        try model.showProposals(store)
        return (model, store)
    }

    func testGhostsFollowTheStoreAndStopWithNil() throws {
        let (model, store) = try model()
        XCTAssertTrue(model.proposalGhosts.isEmpty)
        let p = try store.propose(["title": "Horizon", "rationale": "A line to sit the trees on.", "ops": [["kind": "stroke", "points": .array(line(200)), "brushId": "soft-pastel", "color": "#335577", "size": 12]]])
        let ghost = try XCTUnwrap(model.proposalGhosts.first)
        XCTAssertEqual(ghost.id, p.id)
        XCTAssertEqual(ghost.title, "Horizon")
        XCTAssertEqual(ghost.rationale, "A line to sit the trees on.")
        XCTAssertEqual(ghost.origin, "agent:pixie")
        let b = try XCTUnwrap(p.bounds)
        XCTAssertEqual(ghost.rect, CGRect(x: b.x, y: b.y, width: b.width, height: b.height))
        XCTAssertEqual(ghost.image.width, b.width)
        XCTAssertEqual(ghost.accessibilityLabel, "Suggested: Horizon")

        let wash = try store.propose(["title": "Ground", "place": "bottom", "ops": [["kind": "wash", "color": "#e8c9a0"]]])
        XCTAssertEqual(model.proposalGhosts.map(\.id), [p.id, wash.id])
        XCTAssertTrue(model.proposalGhosts[0].image === ghost.image, "a ghost still pending keeps its image")

        _ = try store.accept(p.id)
        XCTAssertEqual(model.proposalGhosts.map(\.id), [wash.id], "accepted: painted, no longer a ghost")
        _ = try store.reject(wash.id)
        XCTAssertTrue(model.proposalGhosts.isEmpty)

        _ = try store.propose(["title": "Again", "ops": [["kind": "wash", "color": "#ffeedd"]]])
        XCTAssertEqual(model.proposalGhosts.count, 1)
        try model.showProposals(nil)
        XCTAssertTrue(model.proposalGhosts.isEmpty)
        _ = try store.propose(["title": "Unseen", "ops": [["kind": "wash", "color": "#ffeedd"]]])
        XCTAssertTrue(model.proposalGhosts.isEmpty, "a store no longer shown draws nothing")
    }

    func testRegistersTheProposalToolsWhileShown() async throws {
        let (model, store) = try model()
        let names = model.registry.listTools().map(\.name)
        for tool in ["propose_paint", "list_paint_proposals", "accept_paint_proposal", "reject_paint_proposal"] {
            XCTAssertTrue(names.contains { $0.hasSuffix(tool) }, "\(tool) is registered")
        }
        let propose = try XCTUnwrap(names.first { $0.hasSuffix("propose_paint") })
        let ok = await model.registry.callTool(propose, ["title": "Wash", "ops": [["kind": "wash", "color": "#ffeedd"]]])
        XCTAssertFalse(ok.isError)
        XCTAssertEqual(store.proposals.count, 1)
        XCTAssertEqual(model.proposalGhosts.count, 1, "a proposal made by an agent's tool call shows as a ghost")
        let bad = await model.registry.callTool(propose, ["title": "", "ops": []])
        XCTAssertTrue(bad.isError)

        try model.showProposals(nil)
        XCTAssertFalse(model.registry.listTools().contains { $0.name.hasSuffix("propose_paint") })
    }

    #if os(macOS)
    func testTheCanvasDrawsAGhostOverThePaper() throws {
        let (model, store) = try model()
        model.viewport = (512, 384)
        _ = model.controller.setView(zoom: 1, pan: (0, 0))
        func render() throws -> [UInt8] {
            let renderer = ImageRenderer(content: PaintCanvasView(model: model, interactive: false).frame(width: 512, height: 384))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            var out = [UInt8](repeating: 0, count: image.width * image.height * 4)
            out.withUnsafeMutableBytes { buf in
                let ctx = CGContext(data: buf.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            return out
        }
        let before = try render()
        _ = try store.propose(["title": "Dark band", "ops": [["kind": "stroke", "points": .array(line(190)), "brushId": "soft-pastel", "color": "#111111", "size": 30]]])
        let after = try render()
        // Ghost on the band: darker than the paper was, but not as dark as the paint (it's translucent).
        let i = (190 * 512 + 200) * 4
        XCTAssertLessThan(after[i], before[i] &- 40, "the ghost shows over the paper")
        XCTAssertGreaterThan(after[i], 17, "translucent, not painted")
        XCTAssertEqual(model.controller.strokes.count, 0, "nothing was painted")
    }
    #endif
}
