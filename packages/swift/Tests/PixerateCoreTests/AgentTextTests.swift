import Foundation
import XCTest
import PixerateContracts
@testable import PixerateCore

/// A text with an undo log, as a host would have it.
@MainActor
private final class FakeText: AgentTextTarget {
    var text: String
    var readOnly: String?
    var canPreview = true
    var previews: [String] = []
    var commits: [(range: NSRange, text: String, action: String)] = []

    init(_ text: String) { self.text = text }

    var agentText: String { text }
    var agentReadOnlyReason: String? { readOnly }
    var canPreviewAgentTyping: Bool { canPreview }

    func previewAgentTyping(in range: NSRange, with text: String) {
        self.text = (self.text as NSString).replacingCharacters(in: range, with: text)
        previews.append(self.text)
    }

    func commitAgentEdit(in range: NSRange, with text: String, actionName: String) {
        self.text = (self.text as NSString).replacingCharacters(in: range, with: text)
        commits.append((range, text, actionName))
    }
}

/// An instant clock that runs `onWait` before each wait, so a test can act mid-performance.
private final class HookClock: PresenceClock, @unchecked Sendable {
    var time = 0.0
    var waits: [Double] = []
    var onWait: ((Int) -> Void)?

    func now() -> Double { time }

    func wait(_ ms: Double) async throws {
        try Task.checkCancellation()
        waits.append(ms)
        onWait?(waits.count)
        time += max(0, ms)
        try Task.checkCancellation()
    }
}

private let pixie = AgentCaretInfo(id: "pixie", name: "Pixie", color: "#7c3aed")

final class AgentTextTests: XCTestCase {
    // MARK: The planner matches the TypeScript one

    func testPlansMatchTheConformanceContracts() throws {
        let data = try Data(contentsOf: ConformanceContracts.url("domains/agent-text/typing-plans.json"))
        let plans = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertGreaterThan(plans.count, 5)
        for plan in plans {
            let name = plan["name"] as? String ?? "?"
            let edit = try XCTUnwrap(plan["edit"] as? [String: Any])
            let raw = plan["options"] as? [String: Any] ?? [:]
            var options = AgentTypingOptions()
            if raw.keys.contains("charsPerSecond") { options.charsPerSecond = (raw["charsPerSecond"] as? Double) ?? .infinity }
            if let v = raw["maxDurationMs"] as? Double { options.maxDurationMs = v }
            if let v = raw["selectMs"] as? Double { options.selectMs = v }
            if let v = raw["animate"] as? Bool { options.animate = v }
            let steps = planAgentTyping(AgentTextEdit(from: edit["from"] as! Int, to: edit["to"] as! Int, text: edit["text"] as! String), options: options)
            let expected = try XCTUnwrap(plan["steps"] as? [[String: Any]])
            XCTAssertEqual(steps.count, expected.count, name)
            for (step, want) in zip(steps, expected) {
                switch step {
                case .select(let from, let to, let ms):
                    XCTAssertEqual(want["type"] as? String, "select", name)
                    XCTAssertEqual(want["from"] as? Int, from, name)
                    XCTAssertEqual(want["to"] as? Int, to, name)
                    XCTAssertEqual(want["ms"] as? Double ?? -1, ms, accuracy: 1e-9, name)
                case .type(let chars, let text, let ms):
                    XCTAssertEqual(want["type"] as? String, "type", name)
                    XCTAssertEqual(want["chars"] as? Int, chars, name)
                    XCTAssertEqual(want["text"] as? String, text, name)
                    XCTAssertEqual(want["ms"] as? Double ?? -1, ms, accuracy: 1e-9, name)
                case .commit:
                    XCTAssertEqual(want["type"] as? String, "commit", name)
                }
            }
        }
    }

    func testDefaultsMatchTheManifest() throws {
        let data = try Data(contentsOf: ConformanceContracts.url("domains/agent-text/manifest.json"))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let defaults = try XCTUnwrap(manifest["defaults"] as? [String: Any])
        XCTAssertEqual(defaults["charsPerSecond"] as? Double, AgentTypingOptions.defaultCharsPerSecond)
        XCTAssertEqual(defaults["maxDurationMs"] as? Double, AgentTypingOptions.defaultMaxDurationMs)
        XCTAssertEqual(defaults["selectMs"] as? Double, AgentTypingOptions.defaultSelectMs)
        XCTAssertEqual(defaults["frameMs"] as? Double ?? 0, AgentTypingOptions.frameMs, accuracy: 1e-12)
    }

    // MARK: The director

    @MainActor
    func testReplacesAWordAsOneUndoStepAfterSelectingAndTypingIt() async throws {
        let text = FakeText("I dont know")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0)
        var selections: [NSRange] = []
        director.carets.subscribe { carets in if let c = carets.first, c.selection.length > 0 { selections.append(c.selection) } }

        let inserted = try await director.perform(AgentTextEdit(from: 2, to: 6, text: "don't"), by: pixie, actionName: "Punctuation")

        XCTAssertEqual(text.text, "I don't know")
        XCTAssertEqual(inserted, NSRange(location: 2, length: 5))
        XCTAssertEqual(selections.first, NSRange(location: 2, length: 4), "selects what it replaces first")
        XCTAssertEqual(text.previews.dropLast(), ["I don know", "I don't know"], "types it in frames")
        XCTAssertEqual(text.previews.last, "I dont know", "puts the original back before the commit")
        XCTAssertEqual(text.commits.count, 1)
        XCTAssertEqual(text.commits.first?.range, NSRange(location: 2, length: 4))
        XCTAssertEqual(text.commits.first?.action, "Punctuation")
        let caret = try XCTUnwrap(director.carets.caret("pixie"))
        XCTAssertEqual(caret.head, 7)
        XCTAssertEqual(caret.changed, [NSRange(location: 2, length: 5)])
        XCTAssertEqual(caret.name, "Pixie")
        XCTAssertEqual(clock.waits.first, 250, "the selection shows for selectMs")
    }

    @MainActor
    func testAnInsertionHasNoSelectionAndAHostWithoutPreviewsOnlySelects() async throws {
        let text = FakeText("Done here")
        let director = AgentTextDirector(target: text, clock: InstantPresenceClock(), linger: 0)
        try await director.perform(AgentTextEdit(from: 9, to: 9, text: "."), by: pixie)
        XCTAssertEqual(text.text, "Done here.")
        XCTAssertEqual(text.previews, ["Done here.", "Done here"], "one frame, then the original back before the commit")
        XCTAssertEqual(text.commits.map(\.range), [NSRange(location: 9, length: 0)])

        let plain = FakeText("teh dog")
        plain.canPreview = false
        let other = AgentTextDirector(target: plain, clock: InstantPresenceClock(), linger: 0)
        try await other.perform(AgentTextEdit(from: 0, to: 3, text: "The"), by: pixie)
        XCTAssertEqual(plain.text, "The dog")
        XCTAssertEqual(plain.previews, [])
        XCTAssertEqual(plain.commits.count, 1)
    }

    @MainActor
    func testWithoutAnimationItCommitsAtOnce() async throws {
        let text = FakeText("word")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, options: AgentTypingOptions(animate: false), linger: 0)
        try await director.perform(AgentTextEdit(from: 0, to: 4, text: "Word"), by: pixie)
        XCTAssertEqual(text.text, "Word")
        XCTAssertEqual(text.previews, [])
        XCTAssertEqual(clock.waits, [])
    }

    @MainActor
    func testAnEditBeforeTheRangeMovesIt() async throws {
        let text = FakeText("a dont b")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0)
        clock.onWait = { n in
            guard n == 1 else { return }
            // The person types "X" at the start while the agent's selection shows
            MainActor.assumeIsolated {
                text.text = "X" + text.text
                director.noteEdit(in: NSRange(location: 0, length: 0), replacement: "X")
            }
        }
        let inserted = try await director.perform(AgentTextEdit(from: 2, to: 6, text: "don't"), by: pixie)
        XCTAssertEqual(text.text, "Xa don't b")
        XCTAssertEqual(inserted, NSRange(location: 3, length: 5))
    }

    @MainActor
    func testAnEditInsideTheRangeStopsTheCallAndLeavesNothingPartial() async throws {
        let text = FakeText("one two three")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0)
        clock.onWait = { n in
            guard n == 2 else { return }
            // After the first typed frame, the person deletes a character inside the range
            MainActor.assumeIsolated {
                let range = NSRange(location: 4, length: 1)
                text.text = (text.text as NSString).replacingCharacters(in: range, with: "")
                director.noteEdit(in: range, replacement: "")
            }
        }
        do {
            try await director.perform(AgentTextEdit(from: 4, to: 7, text: "2 and a long replacement"), by: pixie)
            XCTFail("should have stopped")
        } catch let error as AgentTextDirectorError {
            XCTAssertEqual(error, .textChanged)
            XCTAssertEqual(error.localizedDescription, "The text changed where the agent was typing; it is as it was before the agent's edit.")
        }
        XCTAssertEqual(text.commits.count, 0)
    }

    @MainActor
    func testAnUnreportedChangeStopsTheCallToo() async throws {
        let text = FakeText("one two three")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0)
        clock.onWait = { n in
            if n == 1 { MainActor.assumeIsolated { text.text = "zero " + text.text } }
        }
        do {
            try await director.perform(AgentTextEdit(from: 4, to: 7, text: "2"), by: pixie)
            XCTFail("should have stopped")
        } catch {
            XCTAssertEqual(error as? AgentTextDirectorError, .textChanged)
        }
        XCTAssertEqual(text.commits.count, 0)
    }

    @MainActor
    func testCancellingPutsTheOriginalBack() async throws {
        let text = FakeText("a long sentence")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0)
        var task: Task<NSRange, Error>?
        clock.onWait = { n in if n == 3 { task?.cancel() } }
        task = Task { @MainActor in
            try await director.perform(AgentTextEdit(from: 2, to: 6, text: "much longer replacement text"), by: pixie)
        }
        do {
            _ = try await task!.value
            XCTFail("should have been cancelled")
        } catch {
            XCTAssertEqual(error as? AgentTextDirectorError, .cancelled)
            XCTAssertEqual(error.localizedDescription, "Typing was cancelled; the document is unchanged.")
        }
        XCTAssertEqual(text.text, "a long sentence")
        XCTAssertEqual(text.commits.count, 0)
    }

    @MainActor
    func testRefusesReadOnlyTextsAndRangesOutsideTheText() async throws {
        let text = FakeText("abc")
        let director = AgentTextDirector(target: text, clock: InstantPresenceClock(), linger: 0)
        do {
            try await director.perform(AgentTextEdit(from: 2, to: 9, text: "x"), by: pixie)
            XCTFail("out of range")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The range 2..9 is outside the text (0..3).")
        }
        text.readOnly = "The document is read-only."
        do {
            try await director.perform(AgentTextEdit(from: 0, to: 1, text: "x"), by: pixie)
            XCTFail("read-only")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The document is read-only.")
        }
        XCTAssertEqual(text.text, "abc")
    }

    @MainActor
    func testCallsByOneAgentRunOneAfterAnother() async throws {
        let text = FakeText("so i dont")
        let director = AgentTextDirector(target: text, clock: InstantPresenceClock(), linger: 0)
        async let first = director.perform(AgentTextEdit(from: 0, to: 2, text: "So"), by: pixie)
        async let second = director.perform(AgentTextEdit(from: 3, to: 4, text: "I"), by: pixie)
        _ = try await (first, second)
        XCTAssertEqual(text.text, "So I dont")
        XCTAssertEqual(text.commits.map(\.text), ["So", "I"])
    }

    @MainActor
    func testTheCaretAndTintGoAfterLinger() async throws {
        let text = FakeText("x")
        let director = AgentTextDirector(target: text, clock: InstantPresenceClock(), linger: 1500)
        try await director.perform(AgentTextEdit(from: 1, to: 1, text: "y"), by: pixie)
        XCTAssertNotNil(director.carets.caret("pixie"))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNil(director.carets.caret("pixie"))
    }

    // MARK: The caret store

    @MainActor
    func testCaretsFollowOtherPeoplesEdits() {
        let store = AgentCaretStore()
        store.set(pixie, anchor: 5, head: 9)
        store.markChanges("pixie", [NSRange(location: 5, length: 4)])
        store.mapThroughEdit(range: NSRange(location: 0, length: 0), length: 3)
        XCTAssertEqual(store.caret("pixie")?.selection, NSRange(location: 8, length: 4))
        XCTAssertEqual(store.caret("pixie")?.changed, [NSRange(location: 8, length: 4)])
        store.mapThroughEdit(range: NSRange(location: 9, length: 10), length: 0)
        XCTAssertEqual(store.caret("pixie")?.selection, NSRange(location: 8, length: 1))
        store.clear()
        XCTAssertTrue(store.carets.isEmpty)
    }
}
