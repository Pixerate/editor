import XCTest
@testable import PixerateCore

/// A counter and commands that add to it.
private final class Counter {
    var value = 0
    func cmd(_ name: String, _ by: Int = 1, tag: String? = nil, origin: String? = nil) -> Command {
        Command(name: name, tag: tag, origin: origin, execute: { self.value += by }, undo: { self.value -= by })
    }
}

private struct Boom: Error, CustomStringConvertible { var description: String { "boom" } }

final class HistoryTests: XCTestCase {
    func testUndoRedoAndState() {
        let h = HistoryManager()
        let c = Counter()
        h.execute(c.cmd("A"))
        h.execute(c.cmd("B", 2))
        XCTAssertEqual(c.value, 3)
        XCTAssertEqual(h.state, HistoryState(canUndo: true, canRedo: false, undoName: "B", redoName: "", undoCount: 2, redoCount: 0))
        XCTAssertTrue(h.undo())
        XCTAssertEqual(c.value, 1)
        XCTAssertTrue(h.redo())
        XCTAssertEqual(c.value, 3)
        h.undo()
        h.execute(c.cmd("C", 10))
        XCTAssertFalse(h.state.canRedo)
        XCTAssertEqual(h.entries.map(\.label), ["A", "C"])
        XCTAssertFalse(HistoryManager().undo())
    }

    func testDepthAndByteLimits() {
        let h = HistoryManager(maxDepth: 2)
        let c = Counter()
        for n in ["A", "B", "C"] { h.execute(c.cmd(n)) }
        XCTAssertEqual(h.entries.map(\.label), ["B", "C"])
        let bytes = HistoryManager(maxBytes: 10)
        bytes.execute(Command(name: "big", byteSize: 8, execute: {}, undo: {}))
        bytes.execute(Command(name: "huge", byteSize: 20, execute: {}, undo: {}))
        // The newest step is always kept, even over the budget.
        XCTAssertEqual(bytes.entries.map(\.label), ["huge"])
    }

    func testBatchIsOneStepAndRollsBackOnThrow() throws {
        let h = HistoryManager()
        let c = Counter()
        h.batch("Both") {
            h.execute(c.cmd("A"))
            h.execute(c.cmd("B", 2))
        }
        XCTAssertEqual(h.entries.map(\.label), ["Both"])
        h.undo()
        XCTAssertEqual(c.value, 0)
        XCTAssertThrowsError(try h.batch("Fails") {
            h.execute(c.cmd("C", 5))
            throw Boom()
        })
        XCTAssertEqual(c.value, 0)
        XCTAssertEqual(h.entries.count, 1)
    }

    func testCoalescingWindowAndGestures() {
        var clock = 1000.0
        let h = HistoryManager(now: { clock })
        let c = Counter()
        h.executeMerged(c.cmd("Nudge", tag: "nudge"))
        clock += 100
        h.executeMerged(c.cmd("Nudge", tag: "nudge"))
        XCTAssertEqual(h.entries.count, 1)
        clock += 1000
        h.executeMerged(c.cmd("Nudge", tag: "nudge"))
        XCTAssertEqual(h.entries.count, 2)
        h.executeMerged(c.cmd("Drag", tag: "drag"), key: "g")
        clock += 10_000
        h.executeMerged(c.cmd("Drag", tag: "drag"), key: "g")
        XCTAssertEqual(h.entries.count, 3)
        h.endGesture()
        h.executeMerged(c.cmd("Drag", tag: "drag"), key: "g")
        XCTAssertEqual(h.entries.count, 4)
        h.undo()
        h.undo()
        // The gesture repeated one tag, so it is taken as absolute: one undo (the first command's).
        XCTAssertEqual(c.value, 4)
    }

    func testMarksRevertAndGoTo() {
        let h = HistoryManager()
        let c = Counter()
        h.execute(c.cmd("A"))
        let mark = h.mark()
        h.execute(c.cmd("B"))
        h.execute(c.cmd("C"))
        XCTAssertEqual(h.revertTo(mark), 2)
        XCTAssertEqual(c.value, 1)
        XCTAssertFalse(h.state.canRedo)
        h.execute(c.cmd("D"))
        h.execute(c.cmd("E"))
        XCTAssertEqual(h.goTo(-1), 3)
        XCTAssertEqual(c.value, 0)
        XCTAssertEqual(h.goTo(1), 2)
        XCTAssertEqual(c.value, 2)
        XCTAssertEqual(h.entries.map(\.current), [false, true, false])
        h.clear()
        XCTAssertFalse(h.isMarkValid(mark))
    }

    // MARK: Origin (packages/core/tests/history-origin.test.ts)

    func testRecordsStepsAsTheUsersByDefault() {
        let h = HistoryManager()
        h.execute(Counter().cmd("A"))
        XCTAssertEqual(h.entries[0].origin, "user")
        XCTAssertEqual(h.origin, "user")
    }

    func testTakesTheCommandsOwnOriginOverTheOneInEffect() {
        let h = HistoryManager()
        let c = Counter()
        h.withOrigin(agentOrigin("pixie")) {
            h.execute(c.cmd("A"))
            h.execute(c.cmd("B", origin: "user"))
        }
        XCTAssertEqual(h.entries.map(\.origin), ["agent:pixie", "user"])
    }

    func testRestoresTheOuterOriginAfterNestedAndFailingCalls() throws {
        let h = HistoryManager()
        try h.withOrigin("agent:a") {
            h.withOrigin("agent:b") { XCTAssertEqual(h.origin, "agent:b") }
            XCTAssertEqual(h.origin, "agent:a")
            XCTAssertThrowsError(try h.withOrigin("agent:c") { throw Boom() })
            XCTAssertEqual(h.origin, "agent:a")
        }
        XCTAssertEqual(h.origin, "user")
    }

    func testHoldsTheOriginUntilAnAsyncCallReturns() async {
        let h = HistoryManager()
        let c = Counter()
        let result = await h.withOrigin("agent:pixie") { () async -> Int in
            await Task.yield()
            XCTAssertEqual(h.origin, "agent:pixie")
            h.execute(c.cmd("Late"))
            return 7
        }
        XCTAssertEqual(result, 7)
        XCTAssertEqual(h.entries[0].origin, "agent:pixie")
        XCTAssertEqual(h.origin, "user")
    }

    func testGivesABatchTheOriginOfItsCommands() {
        let h = HistoryManager()
        let c = Counter()
        h.withOrigin("agent:pixie") {
            h.batch("Both") {
                h.execute(c.cmd("A"))
                h.execute(c.cmd("B"))
            }
        }
        XCTAssertEqual(h.entries.count, 1)
        XCTAssertEqual(h.entries[0].origin, "agent:pixie")
    }

    func testNeverFoldsAnotherOriginsChangeIntoAGestureOrACoalescedStep() {
        let h = HistoryManager()
        let c = Counter()
        h.executeMerged(c.cmd("Drag", tag: "drag"), key: "g")
        h.executeMerged(c.cmd("Drag", tag: "drag", origin: "agent:pixie"), key: "g")
        XCTAssertEqual(h.entries.map(\.origin), ["user", "agent:pixie"])
        h.executeMerged(c.cmd("Nudge", tag: "nudge"))
        h.executeMerged(c.cmd("Nudge", tag: "nudge", origin: "agent:pixie"))
        XCTAssertEqual(h.entries.count, 4)
        h.undo()
        XCTAssertEqual(c.value, 3)
    }

    func testParsesAgentOrigins() {
        XCTAssertEqual(originAgentId("agent:pixie"), "pixie")
        XCTAssertNil(originAgentId("user"))
        XCTAssertNil(originAgentId("agent:"))
        XCTAssertNil(originAgentId(nil))
    }

    // MARK: onCommit

    private func record(_ h: HistoryManager) -> (events: () -> [HistoryCommitEvent], off: Cancellable) {
        var events: [HistoryCommitEvent] = []
        let off = h.onCommit { events.append($0) }
        return ({ events }, off)
    }

    func testReportsExecutesAndMergesWithTheirStepAndOrigin() {
        let h = HistoryManager()
        let r = record(h)
        let c = Counter()
        h.execute(c.cmd("A", origin: "agent:pixie"))
        h.executeMerged(c.cmd("Drag", tag: "d"), key: "k")
        h.executeMerged(c.cmd("Drag", tag: "d"), key: "k")
        let events = r.events()
        XCTAssertEqual(events.map(\.kind), [.execute, .execute, .merge])
        XCTAssertEqual(events.map { $0.entry?.label }, ["A", "Drag", "Drag"])
        XCTAssertEqual(events.map(\.origin), ["agent:pixie", "user", "user"])
        XCTAssertEqual(events[2].revision, h.revision)
    }

    func testReportsUndoRedoEachStepOfGoToRevertAndClear() {
        let h = HistoryManager()
        let c = Counter()
        h.execute(c.cmd("A", origin: "agent:pixie"))
        h.execute(c.cmd("B"))
        let mark = h.mark()
        h.execute(c.cmd("C"))
        let r = record(h)
        h.undo()
        h.redo()
        h.goTo(0)
        h.revertTo(mark)
        h.clear()
        XCTAssertEqual(r.events().map(\.kind), [.undo, .redo, .undo, .undo, .clear])
        XCTAssertEqual(r.events().map { $0.entry?.label }, ["C", "C", "C", "B", nil])
        // The undone step keeps the origin of whoever made it.
        h.execute(c.cmd("D", origin: "agent:pixie"))
        let later = record(h)
        h.undo()
        XCTAssertEqual(later.events()[0].entry?.origin, "agent:pixie")
        XCTAssertEqual(later.events()[0].origin, "user")
    }

    func testReportsARevertAndStopsAfterUnsubscribing() {
        let h = HistoryManager()
        let c = Counter()
        let mark = h.mark()
        h.execute(c.cmd("A"))
        let r = record(h)
        h.revertTo(mark)
        r.off.cancel()
        h.execute(c.cmd("B"))
        XCTAssertEqual(r.events().map(\.kind), [.revert])
    }
}
