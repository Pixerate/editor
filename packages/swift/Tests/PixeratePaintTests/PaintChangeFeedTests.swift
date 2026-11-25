import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// History origin, the paint change feed and proposal listeners, ported from
/// `packages/core/tests/paint-collaboration.test.ts`.
final class PaintChangeFeedTests: XCTestCase {
    private func line(_ y: Double, _ n: Int = 20, _ x0: Double = 20, _ x1: Double = 200) -> [PenPoint] {
        (0..<n).map { i in PenPoint(x: x0 + (x1 - x0) * Double(i) / Double(n - 1), y: y, pressure: 0.7) }
    }

    private func editor() throws -> PaintEditorController {
        try PaintEditorController(width: 240, height: 160, paperPreset: "cold-pressed")
    }

    private func pastel(_ c: PaintEditorController, _ y: Double, color: String? = nil, layerId: String? = nil) throws {
        _ = try c.paintStroke(PaintStrokeInit(layerId: layerId, color: color, brushId: "soft-pastel"), points: line(y))
    }

    // MARK: - History origin and grouping

    func testRecordsWhoMadeEachStepAndReportsCommits() throws {
        let c = try editor()
        var heard: [PaintCommitEvent] = []
        let off = c.onCommit { heard.append($0) }
        try pastel(c, 40, color: "#c0392b")
        try c.withOrigin("agent:pixie") { try pastel(c, 80) }
        _ = c.undo()
        _ = c.redo()
        let label = c.undoLabel ?? ""
        XCTAssertEqual(heard, [
            PaintCommitEvent(kind: .execute, label: label, origin: "user"),
            PaintCommitEvent(kind: .execute, label: label, origin: "agent:pixie"),
            PaintCommitEvent(kind: .undo, label: label, origin: "user"),
            PaintCommitEvent(kind: .redo, label: label, origin: "user"),
        ])
        XCTAssertEqual(c.currentOrigin, "user")
        off.cancel()
        _ = c.undo()
        XCTAssertEqual(heard.count, 4, "cancelled listeners hear nothing")
    }

    func testRestoresTheOuterOriginWhenTheBodyThrowsOrAwaits() async throws {
        let c = try editor()
        XCTAssertThrowsError(try c.withOrigin("agent:pixie") { throw PaintEditorError("stop") })
        XCTAssertEqual(c.currentOrigin, "user")
        let inside = await c.withOrigin("agent:pixie") { () async -> String in
            await Task.yield()
            return c.currentOrigin
        }
        XCTAssertEqual(inside, "agent:pixie")
        XCTAssertEqual(c.currentOrigin, "user")
    }

    func testCommitListenersHearAStepBeforeChangeListeners() throws {
        let c = try editor()
        var order: [String] = []
        let a = c.onCommit { order.append("commit:\($0.kind.rawValue)") }
        let b = c.subscribe { order.append("change") }
        try pastel(c, 40)
        XCTAssertEqual(order.first, "commit:execute")
        order = []
        _ = c.undo()
        XCTAssertEqual(order, ["commit:undo", "change"], "undo is announced once, after its commit")
        order = []
        _ = c.redo()
        XCTAssertEqual(order, ["commit:redo", "change"])
        a.cancel()
        b.cancel()
    }

    func testGroupsSeveralChangesIntoOneStepWithTheGroupsOrigin() throws {
        let c = try editor()
        var heard: [PaintCommitEvent] = []
        let off = c.onCommit { heard.append($0) }
        try c.withOrigin("agent:pixie") {
            try c.group("Sky") {
                let layer = try c.addLayer(name: "Sky")
                _ = try c.fillLayer(layerId: layer.id, color: "#88aadd", opacity: 0.4)
                try pastel(c, 30, layerId: layer.id)
            }
        }
        XCTAssertEqual(heard, [PaintCommitEvent(kind: .execute, label: "Sky", origin: "agent:pixie")])
        heard = []
        let before = c.doc
        XCTAssertThrowsError(try c.group("Broken") {
            _ = try c.addLayer(name: "Half")
            throw PaintEditorError("stop")
        })
        XCTAssertTrue(c.doc === before)
        XCTAssertEqual(heard, [], "a group that throws records nothing")
        off.cancel()
    }

    func testAPreviewReportsNoCommits() throws {
        let c = try editor()
        var heard: [PaintCommitEvent] = []
        let off = c.onCommit { heard.append($0) }
        _ = try c.previewPaint { id in try self.pastel(c, 100, layerId: id) }
        XCTAssertEqual(heard, [])
        off.cancel()
    }

    // MARK: - The change feed

    func testReportsStrokesFillsAndLayersWithWhoMadeThemAndTheStartAndEndOfAStroke() throws {
        let c = try editor()
        let feed = PaintChangeFeed(c, now: { 7 })
        var heard: [PaintChange] = []
        let sub = feed.subscribe { heard.append($0) }
        let session = try c.beginStroke(PaintStrokeInit(brushId: "soft-pastel"))
        session.push([PenPoint(x: 20, y: 20, pressure: 0.5)])
        var last = try XCTUnwrap(heard.last)
        XCTAssertTrue(last.inGesture)
        XCTAssertTrue(last.gestureStarted)
        XCTAssertEqual(last.addedStrokes.count, 0)
        XCTAssertNil(last.commit)
        let started = heard.count
        session.push(Array(line(20).dropFirst()))
        XCTAssertEqual(heard.count, started, "samples of the same stroke report nothing")
        _ = try session.end()
        last = try XCTUnwrap(heard.last)
        XCTAssertEqual(last.origin, "user")
        XCTAssertFalse(last.inGesture)
        XCTAssertTrue(last.gestureEnded)
        XCTAssertEqual(last.commit?.kind, .execute)
        XCTAssertEqual(last.addedStrokes.count, 1)
        XCTAssertEqual(last.at, 7)

        _ = try c.withOrigin("agent:pixie") { try c.fillLayer(color: "#eeddcc", opacity: 0.3) }
        last = try XCTUnwrap(heard.last)
        XCTAssertEqual(last.origin, "agent:pixie")
        XCTAssertEqual(last.events.map(\.kind), ["fill"])

        let layer = try c.addLayer(name: "Trees")
        XCTAssertEqual(heard.last?.addedLayers, [PaintChangeLayer(id: layer.id, name: "Trees")])
        _ = c.undo()
        last = try XCTUnwrap(heard.last)
        XCTAssertEqual(last.removedLayers, [PaintChangeLayer(id: layer.id, name: "Trees")])
        XCTAssertEqual(last.commit?.kind, .undo)

        _ = c.undo()
        XCTAssertEqual(heard.last?.removedStrokes.count, 0)
        _ = c.undo()
        XCTAssertEqual(heard.last?.removedStrokes.count, 1, "undoing a stroke removes it")
        XCTAssertEqual(heard.map(\.seq), Array(1...heard.count))

        let count = heard.count
        feed.dispose()
        _ = try c.addLayer(name: "After")
        XCTAssertEqual(heard.count, count)
        sub.cancel()
    }

    func testReportsLayerFieldChangesAndACancelledStroke() throws {
        let c = try editor()
        let feed = PaintChangeFeed(c)
        var heard: [PaintChange] = []
        let sub = feed.subscribe { heard.append($0) }
        let session = try c.beginStroke(PaintStrokeInit(brushId: "soft-pastel"))
        session.push(line(40))
        session.cancel()
        let last = try XCTUnwrap(heard.last)
        XCTAssertTrue(last.gestureEnded, "a cancelled stroke ends the gesture")
        XCTAssertEqual(last.addedStrokes.count, 0)
        XCTAssertNil(last.commit)

        let id = try XCTUnwrap(c.doc.activeLayerId)
        _ = try c.updateLayer(id, ["visible": false, "opacity": 0.5])
        XCTAssertEqual(heard.last?.changedLayers.first?.id, id)
        XCTAssertEqual(heard.last?.changedLayers.first?.fields, ["visible", "opacity"])
        feed.dispose()
        sub.cancel()
    }

    func testResetTakesANewSnapshotWithoutReporting() throws {
        let c = try editor()
        let feed = PaintChangeFeed(c)
        var heard: [PaintChange] = []
        let sub = feed.subscribe { heard.append($0) }
        feed.dispose()
        try pastel(c, 40)
        XCTAssertEqual(heard.count, 0)
        let fresh = PaintChangeFeed(c)
        let sub2 = fresh.subscribe { heard.append($0) }
        XCTAssertNil(fresh.check(), "nothing changed since it started")
        fresh.reset()
        XCTAssertNil(fresh.check())
        fresh.dispose()
        sub.cancel()
        sub2.cancel()
    }

    // MARK: - Proposals

    func testAcceptPaintsOneStepByTheProposerAndNotifiesAfterItCommits() throws {
        let c = try editor()
        try pastel(c, 40, color: "#2e7d32")
        let userLayer = c.doc.activeLayerId
        let stroke = try XCTUnwrap(c.strokes.first)
        let store = PaintProposals(controller: c, origin: "agent:pixie")
        var order: [String] = []
        var heard: [PaintCommitEvent] = []
        let offCommit = c.onCommit {
            heard.append($0)
            order.append("commit")
        }
        var lists: [[String]] = []
        let offStore = store.subscribe {
            lists.append($0.map(\.id))
            order.append("proposals")
        }
        let p = try store.propose(["title": "Echo the grass", "rationale": "Repeats your stroke lower down.", "ops": [["kind": "echo", "strokeIds": [.string(stroke.id)], "dy": 30, "repeat": 2]]])
        XCTAssertEqual(p.origin, "agent:pixie")
        XCTAssertEqual(p.anchors, [stroke.id])
        XCTAssertEqual(heard, [], "a proposal records nothing")
        XCTAssertEqual(lists, [[p.id]])

        let feed = PaintChangeFeed(c)
        var changes: [PaintChange] = []
        let offFeed = feed.subscribe {
            changes.append($0)
            order.append("change")
        }
        order = []
        let result = try store.accept(p.id)
        // One change, all of it the proposer's: the new layer and both strokes.
        XCTAssertEqual(changes.map { [$0.origin, "\($0.addedLayers.count)", "\($0.addedStrokes.count)"] }, [["agent:pixie", "1", "2"]])
        XCTAssertEqual(changes.first?.commit, PaintCommitEvent(kind: .execute, label: "Echo the grass", origin: "agent:pixie"))
        XCTAssertEqual(heard, [PaintCommitEvent(kind: .execute, label: "Echo the grass", origin: "agent:pixie")])
        XCTAssertEqual(order, ["commit", "change", "proposals"], "the store notifies after the step has committed")
        XCTAssertEqual(lists.last, [])
        XCTAssertEqual(result["label"]?.stringValue, "Echo the grass")
        XCTAssertEqual(result["strokeIds"]?.arrayValue?.count, 2)
        XCTAssertEqual(c.listLayers().first { $0.id == result["layerId"]?.stringValue }?.name, "Echo the grass")
        XCTAssertEqual(c.doc.activeLayerId, userLayer)
        XCTAssertEqual(c.currentOrigin, "user")
        _ = c.undo()
        XCTAssertEqual(c.strokes.count, 1)
        offCommit.cancel()
        offStore.cancel()
        offFeed.cancel()
        feed.dispose()
    }

    func testRejectAndClearByOriginNotifyListeners() throws {
        let c = try editor()
        try pastel(c, 40)
        let store = PaintProposals(controller: c, origin: "agent:pixie")
        var lists: [[String]] = []
        let off = store.subscribe { lists.append($0.map(\.origin)) }
        let p = try store.propose(["title": "Echo", "ops": [["kind": "echo", "strokeIds": [.string(c.strokes[0].id)], "dy": 40]]])
        _ = try store.propose(["title": "Wash", "origin": "agent:other", "ops": [["kind": "wash", "color": "#ffeedd"]]])
        XCTAssertEqual(store.clear(origin: "agent:nobody"), [])
        XCTAssertEqual(lists.count, 2, "clearing nothing notifies nobody")
        XCTAssertEqual(store.clear(origin: "agent:pixie"), [p.id])
        XCTAssertEqual(lists.last, ["agent:other"])
        let other = try XCTUnwrap(store.proposals.first)
        _ = try store.reject(other.id)
        XCTAssertEqual(lists.last, [])
        XCTAssertThrowsError(try store.reject("gone")) { XCTAssertEqual("\($0)", "No pending paint proposal \"gone\". Call list_paint_proposals for the ids.") }
        off.cancel()
    }
}
