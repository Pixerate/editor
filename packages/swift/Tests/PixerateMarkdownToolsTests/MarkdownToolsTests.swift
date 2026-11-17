import Foundation
import XCTest
import PixerateCore
import PixerateMarkdown
@testable import PixerateMarkdownTools

/// A registry with every Markdown provider under the web's bare tool names.
private func setup(_ text: String, selection: NSRange? = nil, readOnly: String? = nil) throws -> (registry: ToolRegistry, buffer: MarkdownTextBuffer) {
    let buffer = MarkdownTextBuffer(text, selection: selection, readOnlyReason: readOnly)
    let registry = ToolRegistry()
    try registry.register(createMarkdownToolProvider(buffer, MarkdownToolProviderOptions(namespace: "")))
    try registry.register(createMarkdownCommandToolProvider(buffer, MarkdownCommandToolProviderOptions(namespace: "")).provider)
    try registry.register(createMarkdownTextMechanicsToolProvider(buffer, MarkdownTextMechanicsToolOptions(namespace: "")))
    return (registry, buffer)
}

private func errorMessage(_ result: McpToolResult) -> String? {
    result.structuredContent?["error"]?["message"]?.stringValue
}

final class MarkdownToolsTests: XCTestCase {
    func testToolNamesMatchTheWebTools() throws {
        let (registry, _) = try setup("Hello")
        XCTAssertEqual(registry.listTools().map(\.name), [
            "get_text", "find_text", "insert_text", "replace_text", "replace_range", "replace_selection", "set_selection", "format_text", "set_block_type",
            "list_commands", "run_command", "run_commands",
            "check_text_mechanics", "fix_text_mechanics",
        ])
    }

    func testEveryToolIsDescribed() throws {
        let (registry, _) = try setup("Hello")
        for tool in registry.listTools() {
            XCTAssertNotNil(tool.title, tool.name)
            XCTAssertNotNil(tool.description, tool.name)
            let a = try XCTUnwrap(tool.annotations, tool.name)
            XCTAssertNotNil(a.readOnlyHint, tool.name)
            XCTAssertNotNil(a.destructiveHint, tool.name)
            XCTAssertNotNil(a.idempotentHint, tool.name)
            XCTAssertNotNil(a.openWorldHint, tool.name)
            XCTAssertEqual(tool.inputSchema["additionalProperties"], false, tool.name)
            for (key, property) in tool.inputSchema["properties"]?.objectValue ?? JSONObject() where tool.name != "run_commands" {
                XCTAssertNotNil(property["description"]?.stringValue, "\(tool.name).\(key)")
            }
        }
    }

    func testReadOnlyTextKeepsOnlyTheReadTools() async throws {
        let (registry, buffer) = try setup("hello", readOnly: "The note is locked.")
        XCTAssertEqual(registry.listTools().map(\.name), ["get_text", "find_text", "list_commands", "run_command", "run_commands", "check_text_mechanics"])
        let run = await registry.callTool("run_command", ["id": "format.bold"])
        XCTAssertTrue(run.isError)
        XCTAssertTrue(run.text?.contains("The note is locked.") == true, run.text ?? "")
        var announced = 0
        let listening = registry.onListChanged { _ in announced += 1 }
        buffer.readOnlyReason = nil
        XCTAssertEqual(announced, 1)
        XCTAssertTrue(registry.hasTool("format_text"))
        listening.cancel()
    }

    // MARK: Reading

    func testGetTextReturnsTheSourceSelectionAndBlocks() async throws {
        let text = "# Title\n\nSome **bold** text.\n\n- [x] done\n\n> quoted\n\n```swift\nlet a = 1\n```"
        let (registry, _) = try setup(text, selection: NSRange(location: 2, length: 5))
        let result = await registry.callTool("get_text", ["blocks": true])
        XCTAssertFalse(result.isError)
        let s = try XCTUnwrap(result.structuredContent)
        XCTAssertEqual(s["format"], "text")
        XCTAssertEqual(s["content"]?.stringValue, text)
        XCTAssertEqual(s["size"], .number(Double((text as NSString).length)))
        XCTAssertEqual(s["selection"], ["from": 2, "to": 7, "text": "Title"])
        XCTAssertEqual(s["blocks"], [
            ["type": "heading", "from": 2, "to": 7, "text": "Title", "level": 1],
            ["type": "paragraph", "from": 9, "to": 28, "text": "Some **bold** text."],
            ["type": "paragraph", "from": 36, "to": 40, "text": "done", "in": "taskList", "checked": true],
            ["type": "paragraph", "from": 44, "to": 50, "text": "quoted", "in": "blockquote"],
            ["type": "codeBlock", "from": 61, "to": 70, "text": "let a = 1"],
        ])
        let html = await registry.callTool("get_text", ["format": "html"])
        XCTAssertTrue(html.structuredContent?["content"]?.stringValue?.contains("<h1>Title</h1>") == true)
        let bad = await registry.callTool("get_text", ["format": "rtf"])
        XCTAssertTrue(bad.isError)
    }

    func testFindTextReturnsPositionsAndContext() async throws {
        let (registry, _) = try setup("The cat sat. Concatenate the CAT.")
        let all = await registry.callTool("find_text", ["query": "cat"])
        XCTAssertEqual(all.structuredContent?["total"], 3)
        XCTAssertEqual(all.structuredContent?["truncated"], false)
        XCTAssertEqual(all.structuredContent?["matches"]?.arrayValue?.first, ["from": 4, "to": 7, "text": "cat", "before": "The ", "after": " sat. Concatenate the CAT."])
        let whole = await registry.callTool("find_text", ["query": "cat", "wholeWord": true, "matchCase": true])
        XCTAssertEqual(whole.structuredContent?["total"], 1)
        let capped = await registry.callTool("find_text", ["query": "cat", "maxResults": 1])
        XCTAssertEqual(capped.structuredContent?["truncated"], true)
        XCTAssertEqual(capped.structuredContent?["matches"]?.arrayValue?.count, 1)
        let regex = await registry.callTool("find_text", ["query": "c[a-z]t", "regex": true, "matchCase": true])
        XCTAssertEqual(regex.structuredContent?["total"], 2)
        let invalid = await registry.callTool("find_text", ["query": "(", "regex": true])
        XCTAssertTrue(invalid.isError)
        XCTAssertTrue(errorMessage(invalid)?.hasPrefix("Invalid search pattern") == true)
        let empty = await registry.callTool("find_text", ["query": ""])
        XCTAssertEqual(empty.structuredContent?["error"]?["code"], "invalid_arguments")
    }

    // MARK: Writing

    func testReplaceRangeIsOneUndoStepAndKeepsTheSelection() async throws {
        let (registry, buffer) = try setup("Hello world. Bye.", selection: NSRange(location: 13, length: 3))
        let result = await registry.callTool("replace_range", ["from": 6, "to": 11, "text": "there"])
        XCTAssertFalse(result.isError, result.text ?? "")
        XCTAssertEqual(buffer.markdown, "Hello there. Bye.")
        XCTAssertEqual(result.structuredContent?["replaced"], ["from": 6, "to": 11])
        XCTAssertEqual(result.structuredContent?["range"], ["from": 6, "to": 11])
        XCTAssertEqual(result.structuredContent?["selection"], ["from": 13, "to": 16, "text": "Bye"])
        XCTAssertEqual(result.structuredContent?["size"], 17)
        XCTAssertEqual(buffer.undoActionNames, ["Replace Text"])
        buffer.undo()
        XCTAssertEqual(buffer.markdown, "Hello world. Bye.")

        let backwards = await registry.callTool("replace_range", ["from": 5, "to": 2, "text": ""])
        XCTAssertEqual(errorMessage(backwards), "\"from\" (5) must not be after \"to\" (2).")
        let outside = await registry.callTool("replace_range", ["from": 0, "to": 99, "text": ""])
        XCTAssertEqual(errorMessage(outside), "Position 99 is outside the document (size 17).")
        let missing = await registry.callTool("replace_range", ["from": 0, "text": ""])
        XCTAssertEqual(missing.structuredContent?["error"]?["code"], "invalid_arguments")
        XCTAssertEqual(buffer.markdown, "Hello world. Bye.")
    }

    func testInsertTextAtAPositionOrTheCursor() async throws {
        let (registry, buffer) = try setup("ab", selection: NSRange(location: 1, length: 0))
        let atCursor = await registry.callTool("insert_text", ["text": "X"])
        XCTAssertEqual(buffer.markdown, "aXb")
        XCTAssertEqual(atCursor.structuredContent?["inserted"], 1)
        XCTAssertEqual(atCursor.structuredContent?["range"], ["from": 1, "to": 2])
        let at = await registry.callTool("insert_text", ["text": "😀", "at": 3])
        XCTAssertEqual(buffer.markdown, "aXb😀")
        XCTAssertEqual(at.structuredContent?["range"], ["from": 3, "to": 5])
        let outside = await registry.callTool("insert_text", ["text": "!", "at": 9])
        XCTAssertEqual(errorMessage(outside), "Position 9 is outside the document (size 5).")
    }

    func testReplaceTextReplacesAllOrOneOccurrence() async throws {
        let (registry, buffer) = try setup("one two one two one")
        let one = await registry.callTool("replace_text", ["find": "one", "replace": "1", "occurrence": 2])
        XCTAssertEqual(buffer.markdown, "one two 1 two one")
        XCTAssertEqual(one.structuredContent?["replaced"], 1)
        XCTAssertEqual(one.structuredContent?["total"], 3)
        let all = await registry.callTool("replace_text", ["find": "two", "replace": "2!"])
        XCTAssertEqual(buffer.markdown, "one 2! 1 2! one")
        XCTAssertEqual(all.structuredContent?["ranges"], [["from": 4, "to": 6], ["from": 9, "to": 11]])
        XCTAssertEqual(buffer.undoActionNames, ["Replace Text", "Replace Text"])
        let none = await registry.callTool("replace_text", ["find": "three", "replace": "3"])
        XCTAssertEqual(errorMessage(none), "No match for \"three\".")
        let tooFar = await registry.callTool("replace_text", ["find": "one", "replace": "1", "occurrence": 5])
        XCTAssertEqual(errorMessage(tooFar), "Occurrence 5 requested, but there are only 2 matches.")
    }

    func testSelectionTools() async throws {
        let (registry, buffer) = try setup("Hello world")
        let set = await registry.callTool("set_selection", ["from": 6, "to": 11])
        XCTAssertEqual(set.structuredContent?["selection"], ["from": 6, "to": 11, "text": "world"])
        let replaced = await registry.callTool("replace_selection", ["text": "there"])
        XCTAssertEqual(buffer.markdown, "Hello there")
        XCTAssertEqual(replaced.structuredContent?["replaced"], ["from": 6, "to": 11])
        let caret = await registry.callTool("set_selection", ["from": 3])
        XCTAssertEqual(caret.structuredContent?["selection"], ["from": 3, "to": 3, "text": ""])
        let outside = await registry.callTool("set_selection", ["from": 3, "to": 40])
        XCTAssertTrue(outside.isError)
    }

    // MARK: Formatting

    func testFormatTextSetsAndClearsInlineFormats() async throws {
        let (registry, buffer) = try setup("Make this bold now.", selection: NSRange(location: 0, length: 0))
        let bold = await registry.callTool("format_text", ["from": 5, "to": 14, "bold": true])
        XCTAssertFalse(bold.isError, bold.text ?? "")
        XCTAssertEqual(buffer.markdown, "Make **this bold** now.")
        XCTAssertEqual(bold.structuredContent?["range"], ["from": 7, "to": 16])
        XCTAssertEqual(bold.structuredContent?["text"], "this bold")
        XCTAssertEqual(bold.structuredContent?["formatting"], ["bold": true])
        XCTAssertEqual(buffer.selectedRange, NSRange(location: 0, length: 0))
        // Setting it again changes nothing.
        let again = await registry.callTool("format_text", ["from": 7, "to": 16, "bold": true])
        XCTAssertFalse(again.isError)
        XCTAssertEqual(buffer.undoActionNames, ["Format Text"])

        let both = await registry.callTool("format_text", ["from": 7, "to": 16, "bold": false, "italic": true, "link": "https://example.com"])
        XCTAssertFalse(both.isError, both.text ?? "")
        XCTAssertEqual(buffer.markdown, "Make *[this bold](https://example.com)* now.")
        XCTAssertEqual(both.structuredContent?["formatting"], ["italic": true, "link": "https://example.com"])
        XCTAssertEqual(buffer.undoActionNames, ["Format Text", "Format Text"])
        buffer.undo()
        XCTAssertEqual(buffer.markdown, "Make **this bold** now.")
    }

    func testFormatTextReportsPartlyAndClearsIt() async throws {
        let (registry, buffer) = try setup("one **two** three")
        let partly = await registry.callTool("get_text")
        XCTAssertFalse(partly.isError)
        let clear = await registry.callTool("format_text", ["from": 0, "to": 17, "bold": false])
        XCTAssertFalse(clear.isError, clear.text ?? "")
        XCTAssertEqual(buffer.markdown, "one two three")
        XCTAssertEqual(clear.structuredContent?["formatting"], [:])
    }

    func testFormatTextValidatesFirst() async throws {
        let (registry, buffer) = try setup("Hello world")
        let nothing = await registry.callTool("format_text", ["from": 0, "to": 5])
        XCTAssertEqual(errorMessage(nothing), "Pass at least one formatting property: bold, italic, strike, code, link.")
        let half = await registry.callTool("format_text", ["from": 0, "bold": true])
        XCTAssertEqual(errorMessage(half), "Pass both \"from\" and \"to\", or neither to use the selection.")
        let empty = await registry.callTool("format_text", ["bold": true])
        XCTAssertTrue(errorMessage(empty)?.hasPrefix("The range is empty") == true)
        let unsafe = await registry.callTool("format_text", ["from": 0, "to": 5, "link": "javascript:alert(1)"])
        XCTAssertEqual(errorMessage(unsafe), "Links may not use javascript:, data: or vbscript: URLs. Nothing was changed.")
        let unknown = await registry.callTool("format_text", ["from": 0, "to": 5, "underline": true])
        XCTAssertEqual(unknown.structuredContent?["error"]?["code"], "invalid_arguments")
        XCTAssertEqual(buffer.markdown, "Hello world")
        XCTAssertTrue(buffer.undoActionNames.isEmpty)
    }

    func testSetBlockTypeSwitchesBetweenKinds() async throws {
        let (registry, buffer) = try setup("First line\nSecond line", selection: NSRange(location: 0, length: 0))
        let bullets = await registry.callTool("set_block_type", ["from": 0, "to": 22, "type": "bullet_list"])
        XCTAssertFalse(bullets.isError, bullets.text ?? "")
        XCTAssertEqual(buffer.markdown, "- First line\n- Second line")
        let numbered = await registry.callTool("set_block_type", ["from": 2, "to": 26, "type": "ordered_list"])
        XCTAssertFalse(numbered.isError, numbered.text ?? "")
        XCTAssertEqual(buffer.markdown, "1. First line\n2. Second line")
        XCTAssertEqual(numbered.structuredContent?["blocks"]?.arrayValue?.first?["in"], "orderedList")
        let heading = await registry.callTool("set_block_type", ["from": 3, "to": 3, "type": "heading", "level": 2])
        XCTAssertFalse(heading.isError, heading.text ?? "")
        XCTAssertEqual(buffer.markdown, "## First line\n2. Second line")
        XCTAssertEqual(heading.structuredContent?["blocks"], [["type": "heading", "from": 3, "to": 13, "text": "First line", "level": 2]])
        let paragraph = await registry.callTool("set_block_type", ["from": 0, "to": 28, "type": "paragraph"])
        XCTAssertFalse(paragraph.isError, paragraph.text ?? "")
        XCTAssertEqual(buffer.markdown, "First line\nSecond line")
        let quote = await registry.callTool("set_block_type", ["from": 0, "to": 22, "type": "blockquote"])
        XCTAssertFalse(quote.isError, quote.text ?? "")
        XCTAssertEqual(buffer.markdown, "> First line\n> Second line")
        let code = await registry.callTool("set_block_type", ["from": 2, "to": 26, "type": "code_block"])
        XCTAssertFalse(code.isError, code.text ?? "")
        XCTAssertEqual(buffer.markdown, "```\nFirst line\nSecond line\n```")
        XCTAssertEqual(code.structuredContent?["blocks"]?.arrayValue?.first?["type"], "codeBlock")
        XCTAssertEqual(buffer.undoActionNames.count, 6)
        XCTAssertEqual(buffer.selectedRange, NSRange(location: 0, length: 0))
    }

    func testSetBlockTypeValidatesLevel() async throws {
        let (registry, buffer) = try setup("Text")
        let noLevel = await registry.callTool("set_block_type", ["type": "heading"])
        XCTAssertEqual(errorMessage(noLevel), "Pass a heading \"level\" (1, 2, 3, 4, 5, 6).")
        let stray = await registry.callTool("set_block_type", ["type": "paragraph", "level": 2])
        XCTAssertEqual(errorMessage(stray), "\"level\" only applies to type \"heading\".")
        let badLevel = await registry.callTool("set_block_type", ["type": "heading", "level": 7])
        XCTAssertEqual(badLevel.structuredContent?["error"]?["code"], "invalid_arguments")
        let badType = await registry.callTool("set_block_type", ["type": "table"])
        XCTAssertEqual(badType.structuredContent?["error"]?["code"], "invalid_arguments")
        XCTAssertEqual(buffer.markdown, "Text")
    }

    // MARK: Format commands

    func testFormatCommandsHaveTheManifestIdsAndSchemas() async throws {
        let (registry, _) = try setup("Hello")
        let listed = await registry.callTool("list_commands")
        let commands = try XCTUnwrap(listed.structuredContent?["commands"]?.arrayValue)
        XCTAssertEqual(commands.compactMap { $0["id"]?.stringValue }, FormatManifest.commands.map(\.id))
        let heading = try XCTUnwrap(commands.first { $0["id"] == "format.heading" })
        XCTAssertEqual(heading["params"], ["type": "object", "properties": ["level": ["type": "integer", "minimum": 1, "maximum": 6]], "required": ["level"]])
        XCTAssertEqual(heading["group"], "Block")
        let bold = try XCTUnwrap(commands.first { $0["id"] == "format.bold" })
        XCTAssertEqual(bold["label"], "Bold")
        XCTAssertEqual(bold["shortcuts"], ["Mod+B"])
        let table = try XCTUnwrap(commands.first { $0["id"] == "format.table" })
        XCTAssertEqual(table["enabled"], false)
        XCTAssertEqual(table["disabledReason"], "Not inside a table.")
    }

    func testRunCommandFormatsTheSelection() async throws {
        let (registry, buffer) = try setup("Hello world", selection: NSRange(location: 6, length: 5))
        let bold = await registry.callTool("run_command", ["id": "format.bold"])
        XCTAssertEqual(bold.structuredContent, ["id": "format.bold", "ok": true, "result": true])
        XCTAssertEqual(buffer.markdown, "Hello **world**")
        XCTAssertEqual(buffer.selectedRange, NSRange(location: 8, length: 5))
        XCTAssertEqual(buffer.undoActionNames, ["Bold"])
        let heading = await registry.callTool("run_command", ["id": "format.heading", "params": ["level": 2]])
        XCTAssertFalse(heading.isError, heading.text ?? "")
        XCTAssertEqual(buffer.markdown, "## Hello **world**")
        XCTAssertEqual(buffer.undoActionNames.last, "Heading 2")
        let link = await registry.callTool("run_command", ["id": "format.link", "params": ["url": "https://example.com"]])
        XCTAssertFalse(link.isError, link.text ?? "")
        XCTAssertTrue(buffer.markdown.contains("](https://example.com)"), buffer.markdown)
        let batch = await registry.callTool("run_commands", ["steps": [["id": "format.paragraph"], ["id": "format.italic"]]])
        XCTAssertFalse(batch.isError, batch.text ?? "")
        XCTAssertEqual(batch.structuredContent?["completed"], 2)
        XCTAssertFalse(buffer.markdown.hasPrefix("#"))
    }

    func testRunCommandRefusesBadInput() async throws {
        let (registry, buffer) = try setup("`code` here", selection: NSRange(location: 2, length: 2))
        let inCode = await registry.callTool("run_command", ["id": "format.bold"])
        XCTAssertTrue(inCode.isError)
        XCTAssertEqual(inCode.structuredContent?["error"]?["code"], "disabled")
        XCTAssertEqual(inCode.structuredContent?["error"]?["message"], "Cannot toggle bold at current selection.")
        let unknown = await registry.callTool("run_command", ["id": "format.underline"])
        XCTAssertTrue(unknown.isError)
        let noLevel = await registry.callTool("run_command", ["id": "format.heading"])
        XCTAssertTrue(noLevel.isError)
        let badParam = await registry.callTool("run_command", ["id": "format.bold", "params": ["level": 1]])
        XCTAssertTrue(badParam.isError)
        XCTAssertEqual(buffer.markdown, "`code` here")
    }

    func testCodeBlockLanguage() async throws {
        let (registry, buffer) = try setup("let a = 1", selection: NSRange(location: 0, length: 0))
        _ = await registry.callTool("run_command", ["id": "format.codeBlock", "params": ["language": "swift"]])
        XCTAssertEqual(buffer.markdown, "```swift\nlet a = 1\n```")
        _ = await registry.callTool("run_command", ["id": "format.codeBlock", "params": ["language": "python"]])
        XCTAssertEqual(buffer.markdown, "```python\nlet a = 1\n```")
        _ = await registry.callTool("run_command", ["id": "format.codeBlock"])
        XCTAssertEqual(buffer.markdown, "let a = 1")
    }

    // MARK: Text mechanics

    func testCheckAndFixTextMechanics() async throws {
        let (registry, buffer) = try setup("i think it works\n\n`dont touch`\n", selection: NSRange(location: 0, length: 0))
        let check = await registry.callTool("check_text_mechanics")
        XCTAssertFalse(check.isError, check.text ?? "")
        let s = try XCTUnwrap(check.structuredContent)
        XCTAssertEqual(s["ok"], false)
        XCTAssertEqual(s["note"], "No spell checker is available here, so spelling was not checked.")
        let first = try XCTUnwrap(s["findings"]?.arrayValue?.first)
        XCTAssertEqual(first["check"], "pronoun-i")
        XCTAssertEqual(first["from"], 0)
        XCTAssertEqual(first["to"], 1)
        XCTAssertEqual(first["text"], "i")
        XCTAssertEqual(first["replacement"], "I")
        XCTAssertEqual(first["message"], "Write \"i\" as \"I\".")
        let count = try XCTUnwrap(s["count"]?.numberValue)

        let only = await registry.callTool("check_text_mechanics", ["checks": ["pronoun-i"]])
        XCTAssertEqual(only.structuredContent?["count"], 1)
        let bad = await registry.callTool("check_text_mechanics", ["checks": ["grammar"]])
        XCTAssertEqual(bad.structuredContent?["error"]?["code"], "invalid_arguments")

        let fix = await registry.callTool("fix_text_mechanics")
        XCTAssertFalse(fix.isError, fix.text ?? "")
        XCTAssertEqual(fix.structuredContent?["fixed"], .number(count))
        XCTAssertEqual(fix.structuredContent?["byCheck"]?["pronoun-i"], 1)
        XCTAssertTrue(buffer.markdown.hasPrefix("I think it works"), buffer.markdown)
        XCTAssertTrue(buffer.markdown.contains("`dont touch`"))
        XCTAssertEqual(buffer.undoActionNames, ["Fix Punctuation and Spelling"])
        let clean = await registry.callTool("check_text_mechanics")
        XCTAssertEqual(clean.structuredContent?["ok"], true)
    }

    // MARK: Positions

    func testMinimalEditAndMapping() {
        XCTAssertNil(MarkdownTextEdit.minimal(from: "abc", to: "abc"))
        XCTAssertEqual(MarkdownTextEdit.minimal(from: "abc", to: "a**b**c"), MarkdownTextEdit(range: NSRange(location: 1, length: 1), replacement: "**b**"))
        // Never splits a surrogate pair.
        let emoji = MarkdownTextEdit.minimal(from: "a😀", to: "a😃")!
        XCTAssertEqual(emoji.range, NSRange(location: 1, length: 2))
        let edits = [MarkdownTextEdit(range: NSRange(location: 2, length: 3), replacement: "X")]
        XCTAssertEqual(mapPosition(1, through: edits), 1)
        XCTAssertEqual(mapPosition(6, through: edits), 4)
        XCTAssertEqual(mapPosition(3, through: edits, assoc: -1), 2)
        XCTAssertEqual(mapPosition(3, through: edits, assoc: 1), 3)
        XCTAssertEqual(mapRange(NSRange(location: 0, length: 7), through: edits), NSRange(location: 0, length: 5))
    }
}
