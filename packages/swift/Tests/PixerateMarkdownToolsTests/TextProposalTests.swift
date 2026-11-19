import Foundation
import XCTest
import PixerateContracts
import PixerateCore
import PixerateMarkdown
@testable import PixerateMarkdownTools

private func contract(_ file: String) throws -> JSONValue {
    try JSONValue.parse(String(decoding: try ConformanceContracts.data("domains/text-proposals/\(file)"), as: UTF8.self))
}

private func splice(_ text: String, _ from: Int, _ to: Int, _ insert: String) -> String {
    let u = Array(text.utf16)
    return String(decoding: Array(u[0 ..< from]) + Array(insert.utf16) + Array(u[to...]), as: UTF16.self)
}

/// One scenario's world, as the TS contract runner builds it.
private final class World {
    var text: String
    var selection: TextSelection
    var clock: Double = 0
    var timer: (() -> Void)?
    let history = HistoryManager()
    var feed: TextChangeFeed!
    var proposals: TextProposals!
    let registry = ToolRegistry()
    var changes: [JSONValue] = []
    var outcomes: [JSONValue] = []

    init(_ scenario: JSONValue) throws {
        text = scenario["text"]?.stringValue ?? ""
        selection = TextSelection(from: text.utf16.count, to: text.utf16.count)
        let now: () -> Double = { [unowned self] in self.clock += 1; return self.clock }
        feed = TextChangeFeed(
            getText: { [unowned self] in self.text },
            getSelection: { [unowned self] in self.selection },
            history: history,
            burstMs: scenario["burstMs"]?.numberValue ?? 1500,
            now: now,
            schedule: { [unowned self] fn, _ in
                self.timer = fn
                return { [weak self] in self?.timer = nil }
            }
        )
        var n = 0
        let readOnly = scenario["readOnly"]?.stringValue
        proposals = TextProposals(
            getText: { [unowned self] in self.text },
            applyEdit: { [unowned self] edit, name, origin in
                let before = self.text
                let after = splice(before, edit.from, edit.to, edit.replacement)
                let caret = edit.from + edit.replacement.utf16.count
                self.history.execute(Command(name: name, origin: origin, execute: { [unowned self] in
                    self.text = after
                    self.selection = TextSelection(from: caret, to: caret)
                }, undo: { [unowned self] in
                    self.text = before
                    self.selection = TextSelection(from: edit.to, to: edit.to)
                }))
            },
            readOnly: { readOnly },
            idGenerator: { n += 1; return "p\(n)" },
            now: now
        )
        try registry.register(createTextProposalToolProvider(proposals, TextProposalToolProviderOptions(namespace: "")))
        _ = feed.subscribe { [unowned self] c in self.changes.append(c.json) }
        _ = proposals.onOutcome { [unowned self] e in self.outcomes.append(["id": .string(e.proposal.id), "outcome": .string(e.outcome.rawValue)]) }
    }

    func run(_ step: JSONValue) async throws -> JSONValue {
        changes = []
        outcomes = []
        var result: JSONValue?
        func int(_ k: String) -> Int { Int(step[k]?.numberValue ?? 0) }
        switch step["op"]?.stringValue {
        case "type":
            let at = int("at"), insert = step["text"]?.stringValue ?? ""
            text = splice(text, at, at, insert)
            selection = TextSelection(from: at + insert.utf16.count, to: at + insert.utf16.count)
        case "replace":
            let insert = step["text"]?.stringValue ?? ""
            text = splice(text, int("from"), int("to"), insert)
            selection = TextSelection(from: int("from") + insert.utf16.count, to: int("from") + insert.utf16.count)
        case "select":
            selection = TextSelection(from: int("from"), to: int("to"))
        case "call":
            let actor = step["actor"]?.stringValue.map { ToolActor(id: $0, name: $0) }
            let r = await registry.callTool(step["tool"]?.stringValue ?? "", step["args"]?.objectValue ?? JSONObject(), actor: actor)
            result = r.isError
                ? ["isError": true, "error": r.structuredContent?["error"]?["message"] ?? .null]
                : ["isError": false, "structuredContent": r.structuredContent.map { .object($0) } ?? .null]
        case "reject":
            try proposals.reject(step["id"]?.stringValue ?? "")
        case "clear":
            result = .array(proposals.clear(origin: step["origin"]?.stringValue).map { .string($0) })
        case "undo":
            history.undo()
        case "redo":
            history.redo()
        case "pause":
            let fire = timer
            timer = nil
            fire?()
        case "endGesture":
            feed.endGesture()
        default:
            XCTFail("unknown step \(step.stringified())")
        }
        feed.check()
        proposals.sync()
        var out = JSONObject([
            ("text", .string(text)),
            ("changes", .array(changes)),
            ("outcomes", .array(outcomes)),
            ("proposals", .array(proposals.proposals.map(\.json))),
        ])
        if let result { out["result"] = result }
        return .object(out)
    }
}

/// The text change feed, text proposals and their tools against `domains/text-proposals`.
final class TextProposalTests: XCTestCase {
    func testToolDefinitionsMatchTheContract() throws {
        let registry = ToolRegistry()
        try registry.register(createTextProposalToolProvider(TextProposals(getText: { "" }, applyEdit: { _, _, _ in }), TextProposalToolProviderOptions(namespace: "")))
        let want = try XCTUnwrap(contract("tools.json").arrayValue)
        let tools = registry.listTools()
        XCTAssertEqual(tools.map(\.name), want.map { $0["name"]?.stringValue ?? "" })
        for (tool, w) in zip(tools, want) {
            XCTAssertEqual(tool.title, w["title"]?.stringValue, tool.name)
            XCTAssertEqual(tool.description, w["description"]?.stringValue, tool.name)
            XCTAssertEqual(tool.inputSchema, w["inputSchema"], tool.name)
            for hint in ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] {
                let got: Bool? = switch hint {
                case "readOnlyHint": tool.annotations?.readOnlyHint
                case "destructiveHint": tool.annotations?.destructiveHint
                case "idempotentHint": tool.annotations?.idempotentHint
                default: tool.annotations?.openWorldHint
                }
                XCTAssertEqual(got, w["annotations"]?[hint]?.boolValue, "\(tool.name).\(hint)")
            }
        }
    }

    func testScenariosMatchTheContract() async throws {
        let scenarios = try XCTUnwrap(contract("scenarios.json").arrayValue)
        XCTAssertGreaterThanOrEqual(scenarios.count, 6)
        for scenario in scenarios {
            let name = scenario["name"]?.stringValue ?? "?"
            let world = try World(scenario)
            let steps = scenario["steps"]?.arrayValue ?? []
            let expected = scenario["expected"]?.arrayValue ?? []
            XCTAssertEqual(steps.count, expected.count, name)
            for (i, (step, want)) in zip(steps, expected).enumerated() {
                let got = try await world.run(step)
                XCTAssertEqual(got, want, "\(name) step \(i) \(step.stringified())\n got: \(got.stringified())\nwant: \(want.stringified())")
            }
        }
    }

    /// Proposals on a Markdown host: accepted as one step that records the proposer, and the feed keeps them in step.
    func testProposalsOnAMarkdownHost() async throws {
        let buffer = MarkdownTextBuffer("We utilize the tool.", selection: NSRange(location: 0, length: 0))
        let proposals = createMarkdownTextProposals(buffer)
        let feed = createMarkdownTextChangeFeed(buffer, proposals: proposals, burstMs: 0)
        var heard: [TextChange] = []
        _ = feed.subscribe { heard.append($0) }
        let registry = ToolRegistry()
        try registry.register(createTextProposalToolProvider(proposals, TextProposalToolProviderOptions(namespace: "")))
        try registry.register(createMarkdownToolProvider(buffer, MarkdownToolProviderOptions(namespace: "")))

        let proposed = await registry.callTool("propose_text_edit", ["from": 3, "to": 10, "replacement": "use", "expected": "utilize"], actor: ToolActor(id: "jazz"))
        XCTAssertFalse(proposed.isError, proposed.text ?? "")
        XCTAssertEqual(buffer.markdown, "We utilize the tool.")

        // The agent's own edit before it, through the Markdown tools.
        _ = await registry.callTool("insert_text", ["at": 0, "text": "So "])
        feed.check(origin: "agent:writer")
        XCTAssertEqual(heard.last?.origin, "agent:writer")
        XCTAssertEqual(proposals.proposals.first?.from, 6)

        let id = try XCTUnwrap(proposals.proposals.first?.id)
        let accepted = await registry.callTool("accept_text_proposal", ["proposalId": .string(id)])
        XCTAssertFalse(accepted.isError, accepted.text ?? "")
        XCTAssertEqual(buffer.markdown, "So We use the tool.")
        XCTAssertEqual(buffer.undoActionNames.last, "Replace \"utilize\" with \"use\"")
        XCTAssertEqual(buffer.undoOrigins.last, "agent:jazz")
        // The person's caret, before the edit, stays where it was.
        XCTAssertEqual(buffer.selectedRange, NSRange(location: 0, length: 0))

        buffer.readOnlyReason = "The note is locked."
        _ = try proposals.propose(from: 0, to: 2, replacement: "Then")
        XCTAssertThrowsError(try proposals.accept(proposals.proposals[0].id)) { XCTAssertEqual(($0 as? ToolHandlerError)?.message, "The note is locked.") }
    }
}
