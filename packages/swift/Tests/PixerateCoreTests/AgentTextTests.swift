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
            if let v = raw["checkMs"] as? Double { options.checkMs = v }
            let check = (edit["check"] as? [String: Int]).map { $0["from"]!..<$0["to"]! }
            let steps = planAgentTyping(AgentTextEdit(from: edit["from"] as! Int, to: edit["to"] as! Int, text: edit["text"] as! String, check: check), options: options)
            let expected = try XCTUnwrap(plan["steps"] as? [[String: Any]])
            XCTAssertEqual(steps.count, expected.count, name)
            for (step, want) in zip(steps, expected) {
                switch step {
                case .check(let from, let to, let ms):
                    XCTAssertEqual(want["type"] as? String, "check", name)
                    XCTAssertEqual(want["from"] as? Int, from, name)
                    XCTAssertEqual(want["to"] as? Int, to, name)
                    XCTAssertEqual(want["ms"] as? Double ?? -1, ms, accuracy: 1e-9, name)
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
        XCTAssertEqual(defaults["checkMs"] as? Double, AgentTypingOptions.defaultCheckMs)
        XCTAssertEqual(AgentTypingOptions.defaultCheckMs, BuiltInTextTreatment.checkMs)
        XCTAssertEqual(defaults["frameMs"] as? Double ?? 0, AgentTypingOptions.frameMs, accuracy: 1e-12)
    }

    // MARK: The built-in text treatment matches the TypeScript one

    func testBuiltInTreatmentPlansMatchTheConformanceContracts() throws {
        let data = try Data(contentsOf: ConformanceContracts.url("domains/agent-text/treatment-plans.json"))
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 100)
        for c in cases {
            let raw = try XCTUnwrap(c["target"] as? [String: Any])
            let rawLines = raw["lines"] as? [[String: Any]] ?? []
            var lines: [TextTreatmentRect] = []
            for l in rawLines { lines.append(TextTreatmentRect(x: treatmentNumber(l["x"]), y: treatmentNumber(l["y"]), width: treatmentNumber(l["width"]), height: treatmentNumber(l["height"]))) }
            var caret: TextTreatmentCaret?
            if let rc = raw["caret"] as? [String: Any] { caret = TextTreatmentCaret(x: treatmentNumber(rc["x"]), y: treatmentNumber(rc["y"]), height: treatmentNumber(rc["height"])) }
            let target = TextTreatmentTarget(lines: lines, caret: caret, label: raw["label"] as? String)
            let stage = try XCTUnwrap(TextTreatmentStage(rawValue: c["stage"] as? String ?? ""))
            let reduce = c["reduceMotion"] as? Bool ?? false
            let request = TextTreatmentPlanRequest(stage: stage, time: treatmentNumber(c["time"]), target: target, reduceMotion: reduce)
            let colour = (c["values"] as? [String: Any])?["color"] as? String
            let plan = try BuiltInTextTreatment.plan(request, color: colour)
            let want = try XCTUnwrap(c["plan"] as? [String: Any])
            let at = "\(c["name"] as? String ?? "") \(stage.rawValue) at \(request.time)\(reduce ? " reduced" : "")"
            XCTAssertEqual(plan.duration, treatmentNumber(want["duration"]), at)
            XCTAssertEqual(plan.done, want["done"] as? Bool, at)
            XCTAssertEqual(plan.reduced, want["reduced"] as? Bool, at)
            let layers = try XCTUnwrap(want["layers"] as? [[String: Any]])
            XCTAssertEqual(plan.layers.count, layers.count, at)
            for (l, w) in zip(plan.layers, layers) { checkTreatmentLayer(l, w, at) }
        }
    }

    func testTreatmentFramesRemoveFinishedStagesAndHoldTheSelection() throws {
        let target = TextTreatmentTarget(lines: [TextTreatmentRect(x: 0, y: 0, width: 50, height: 20)])
        let planAt = { (stage: TextTreatmentStage) in { (t: Double) in try BuiltInTextTreatment.plan(TextTreatmentPlanRequest(stage: stage, time: t, target: target)) } }
        XCTAssertNotNil(try textTreatmentFrame(.checking, at: 100, planAt: planAt(.checking)))
        XCTAssertNil(try textTreatmentFrame(.checking, at: 900, planAt: planAt(.checking)))
        XCTAssertEqual(try textTreatmentFrame(.selecting, at: 900, planAt: planAt(.selecting))?.time, 0)
        XCTAssertThrowsError(try BuiltInTextTreatment.plan(TextTreatmentPlanRequest(stage: .caret, time: -1, target: target))) {
            XCTAssertEqual(($0 as? TextTreatmentError)?.message, "The time is ms into the stage, 0 or more; it was -1.")
        }
        XCTAssertThrowsError(try BuiltInTextTreatment.plan(TextTreatmentPlanRequest(stage: .caret, time: 0, target: target), color: "red"))
    }

    // MARK: The director

    /// A provider with one treatment that draws only a caret, in the agent's colour.
    private final class CaretOnly: TextTreatmentProvider {
        var defaultTextTreatment: String? { "caret-only" }
        func textTreatmentPlan(_ id: String, _ request: TextTreatmentPlanRequest, values: JSONObject?) throws -> TextTreatmentPlan {
            guard id == "caret-only" else { throw TextTreatmentError("unknown_effect", "Unknown effect \"\(id)\".") }
            let color = TextTreatmentRGBA(hex: values?["color"]?.stringValue ?? "") ?? TextTreatmentRGBA(0, 0, 0)
            let layers = request.target.caret.map { [TextTreatmentLayer(kind: .rect, source: "caret", z: .above, x: $0.x, y: $0.y, width: 1, height: $0.height, color: color)] } ?? []
            return TextTreatmentPlan(stage: request.stage, time: request.time, duration: 100, done: false, reduced: request.reduceMotion, layers: layers)
        }
    }

    @MainActor
    func testTheDirectorRecordsEachStageForATextTreatment() async throws {
        let text = FakeText("I dont know it")
        let clock = HookClock()
        let director = AgentTextDirector(target: text, clock: clock, linger: 0, treatment: "caret-only")
        var stages: [(AgentCaretStage, NSRange?, Double)] = []
        clock.onWait = { _ in
            if let c = director.carets.carets.first { stages.append((c.stage, c.check ?? c.typed, c.stageSince)) }
        }
        try await director.perform(AgentTextEdit(from: 2, to: 6, text: "don't", check: 0..<14), by: pixie)
        XCTAssertEqual(stages.first?.0, .checking)
        XCTAssertEqual(stages.first?.1, NSRange(location: 0, length: 14))
        XCTAssertEqual(stages[1].0, .selecting)
        XCTAssertEqual(stages[1].2, 480, "a stage's clock starts when it does")
        XCTAssertEqual(stages.last?.0, .typing)
        XCTAssertEqual(stages.last?.1, NSRange(location: 2, length: 3))
        let caret = try XCTUnwrap(director.carets.caret("pixie"))
        XCTAssertEqual(caret.stage, .caret)
        XCTAssertEqual(caret.treatment, "caret-only")
        XCTAssertEqual(caret.changed, [NSRange(location: 2, length: 5)])
        XCTAssertEqual(caret.changedSince, clock.time)

        // An overlay plans what to draw, back to front: what landed, then the caret, from the
        // provider's treatment in the agent's colour.
        let lines = { (r: NSRange) in [TextTreatmentRect(x: Double(r.location) * 8, y: 0, width: Double(r.length) * 8, height: 20)] }
        let caretAt = { (p: Int) in TextTreatmentCaret(x: Double(p) * 8, y: 0, height: 20) }
        let plans = AgentTextTreatments(provider: CaretOnly()).plans(for: director.carets.carets, at: clock.time + 10, lines: lines, caretAt: caretAt)
        XCTAssertEqual(plans.map(\.stage), [.landed, .caret])
        XCTAssertEqual(plans[1].layers.first?.color, TextTreatmentRGBA(hex: "#7c3aed"))
        // Without a provider, the built-in look: an 18% tint on what landed, then the caret and its tag.
        let builtIn = AgentTextTreatments().plans(for: director.carets.carets, at: clock.time + 10, lines: lines, caretAt: caretAt)
        XCTAssertEqual(builtIn.flatMap { $0.layers.map(\.source) }, ["changed", "caret", "tag"])
        XCTAssertEqual(builtIn[0].layers[0].x, 16)
    }

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

private func treatmentNumber(_ v: Any?) -> Double {
    (v as? NSNumber)?.doubleValue ?? .nan
}

private func treatmentColour(_ v: Any?) -> TextTreatmentRGBA? {
    guard let a = v as? [Any], a.count == 4 else { return nil }
    return TextTreatmentRGBA(treatmentNumber(a[0]), treatmentNumber(a[1]), treatmentNumber(a[2]), treatmentNumber(a[3]))
}

private func assertNear(_ a: TextTreatmentRGBA?, _ b: TextTreatmentRGBA?, _ at: String) {
    guard let a, let b else {
        XCTAssertEqual(a == nil, b == nil, at)
        return
    }
    XCTAssertEqual(a.r, b.r, accuracy: 1e-12, at)
    XCTAssertEqual(a.g, b.g, accuracy: 1e-12, at)
    XCTAssertEqual(a.b, b.b, accuracy: 1e-12, at)
    XCTAssertEqual(a.a, b.a, accuracy: 1e-12, at)
}

/// One planned layer against the TypeScript plan's JSON.
private func checkTreatmentLayer(_ l: TextTreatmentLayer, _ w: [String: Any], _ at: String) {
    XCTAssertEqual(l.kind.rawValue, w["kind"] as? String, at)
    XCTAssertEqual(l.source, w["source"] as? String, at)
    XCTAssertEqual(l.z.rawValue, w["z"] as? String, at)
    XCTAssertEqual(l.blend, w["blend"] as? String, at)
    XCTAssertEqual(l.text, w["text"] as? String, at)
    XCTAssertEqual(l.x, treatmentNumber(w["x"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.y, treatmentNumber(w["y"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.width, treatmentNumber(w["width"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.height, treatmentNumber(w["height"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.radius, treatmentNumber(w["radius"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.opacity, treatmentNumber(w["opacity"]), accuracy: 1e-9, at)
    XCTAssertEqual(l.size, (w["size"] as? NSNumber)?.doubleValue, at)
    XCTAssertEqual(l.padX, (w["padX"] as? NSNumber)?.doubleValue, at)
    assertNear(l.color, treatmentColour(w["color"]), at)
    assertNear(l.textColor, treatmentColour(w["textColor"]), at)
    let g = w["gradient"] as? [String: Any]
    XCTAssertEqual(l.gradient == nil, g == nil, at)
    guard let lg = l.gradient, let g else { return }
    XCTAssertEqual(lg.x0, treatmentNumber(g["x0"]), accuracy: 1e-9, at)
    XCTAssertEqual(lg.y0, treatmentNumber(g["y0"]), accuracy: 1e-9, at)
    XCTAssertEqual(lg.x1, treatmentNumber(g["x1"]), accuracy: 1e-9, at)
    XCTAssertEqual(lg.y1, treatmentNumber(g["y1"]), accuracy: 1e-9, at)
    let stops = g["stops"] as? [[String: Any]] ?? []
    XCTAssertEqual(lg.stops.count, stops.count, at)
    for (stop, ws) in zip(lg.stops, stops) {
        XCTAssertEqual(stop.offset, treatmentNumber(ws["offset"]), at)
        assertNear(stop.color, treatmentColour(ws["color"]), at)
    }
}
