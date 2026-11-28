import Foundation
import PixerateMarkdown
import XCTest

final class ActiveFormatsTests: XCTestCase {
    private func assertFormats(
        _ marked: String,
        _ expected: Set<FormatCommand>,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let parsed = parseSelection(marked) else {
            XCTFail("Invalid selection marker in \(marked.debugDescription)", file: file, line: line)
            return
        }
        let formatting = MarkdownFormatting(text: parsed.text)
        XCTAssertEqual(
            FormatCommandEdits.activeFormats(at: parsed.selection, in: parsed.text),
            expected,
            "range+text for \(marked.debugDescription)",
            file: file,
            line: line
        )
        XCTAssertEqual(
            FormatCommandEdits.activeFormats(at: parsed.selection, in: formatting),
            expected,
            "range+formatting for \(marked.debugDescription)",
            file: file,
            line: line
        )
        if parsed.selection.length == 0 {
            XCTAssertEqual(
                FormatCommandEdits.activeFormats(at: parsed.selection.location, in: parsed.text),
                expected,
                "offset+text for \(marked.debugDescription)",
                file: file,
                line: line
            )
            XCTAssertEqual(
                FormatCommandEdits.activeFormats(at: parsed.selection.location, in: formatting),
                expected,
                "offset+formatting for \(marked.debugDescription)",
                file: file,
                line: line
            )
        }
    }

    func testFormatCommandHashableAndCheckListAlias() {
        let commands: Set<FormatCommand> = [
            .bold,
            .italic,
            .code,
            .strikethrough,
            .bulletList,
            .numberedList,
            .checkList,
            .taskList,
            .heading(1),
            .heading(2),
            .callout(.note),
            .callout(nil),
        ]
        XCTAssertEqual(FormatCommand.checkList, .taskList)
        XCTAssertTrue(Set([FormatCommand.taskList]).contains(.checkList))
        XCTAssertEqual(commands.count, 11)
        XCTAssertTrue(commands.contains(.bold))
        XCTAssertTrue(commands.contains(.italic))
        XCTAssertTrue(commands.contains(.code))
        XCTAssertTrue(commands.contains(.strikethrough))
        XCTAssertTrue(commands.contains(.bulletList))
        XCTAssertTrue(commands.contains(.numberedList))
        XCTAssertTrue(commands.contains(.checkList))
        XCTAssertTrue(commands.contains(.taskList))
        XCTAssertTrue(commands.contains(.heading(1)))
        XCTAssertTrue(commands.contains(.heading(2)))
        XCTAssertTrue(commands.contains(.callout(.note)))
        XCTAssertTrue(commands.contains(.callout(nil)))
    }

    func testEmptyListItems() {
        // Bullet lists
        assertFormats("- ‸", [.bulletList])
        assertFormats("‸- ", [.bulletList])
        assertFormats("-‸ ", [.bulletList])
        assertFormats("* ‸", [.bulletList])
        assertFormats("+ ‸", [.bulletList])
        assertFormats("  - ‸", [.bulletList])
        assertFormats("> - ‸", [.bulletList])
        assertFormats("First\n- ‸\nLast", [.bulletList])
        assertFormats("First\n\n- ‸\n\nLast", [.bulletList])

        // Numbered lists
        assertFormats("1. ‸", [.numberedList])
        assertFormats("‸1. ", [.numberedList])
        assertFormats("1) ‸", [.numberedList])
        assertFormats("42. ‸", [.numberedList])
        assertFormats("   1. ‸", [.numberedList])
        assertFormats("> 1. ‸", [.numberedList])
        assertFormats("First\n1. ‸\nLast", [.numberedList])

        // Checklists (.checkList == .taskList)
        assertFormats("- [ ] ‸", [.checkList])
        assertFormats("‸- [ ] ", [.checkList])
        assertFormats("- [‸ ] ", [.checkList])
        assertFormats("- [x] ‸", [.checkList])
        assertFormats("- [X] ‸", [.checkList])
        assertFormats("* [ ] ‸", [.checkList])
        assertFormats("+ [x] ‸", [.checkList])
        assertFormats("> - [ ] ‸", [.checkList])
        assertFormats("First\n- [ ] ‸\nLast", [.checkList])

        // Continuation lines & nested lists
        assertFormats("- item‸", [.bulletList])
        assertFormats("- first\n  second‸", [.bulletList])
        assertFormats("1. item\n   continued‸", [.numberedList])
        assertFormats("- [ ] task\n  continued‸", [.checkList])
        assertFormats("1. parent\n   - ‸", [.bulletList])
        assertFormats("- parent\n  1. ‸", [.numberedList])
        assertFormats("- parent\n  - [ ] ‸", [.checkList])

        // Blank lines after lists & thematic breaks
        assertFormats("- item\n\n‸", [])
        assertFormats("- item\n‸", [])
        assertFormats("---‸", [])
        assertFormats("- - -‸", [])
        assertFormats("* * *‸", [])
    }

    func testDelimiterBoundaries() {
        // Double asterisk bold
        assertFormats("‸**bold**", [])
        assertFormats("*‸*bold**", [])
        assertFormats("**‸bold**", [.bold])
        assertFormats("**bo‸ld**", [.bold])
        assertFormats("**bold‸**", [.bold])
        assertFormats("**bold*‸*", [])
        assertFormats("**bold**‸", [])

        // Double underscore bold
        assertFormats("‸__bold__", [])
        assertFormats("_‸_bold__", [])
        assertFormats("__‸bold__", [.bold])
        assertFormats("__bo‸ld__", [.bold])
        assertFormats("__bold‸__", [.bold])
        assertFormats("__bold_‸_", [])
        assertFormats("__bold__‸", [])

        // Single asterisk & underscore italic
        assertFormats("‸*italic*", [])
        assertFormats("*‸italic*", [.italic])
        assertFormats("*ita‸lic*", [.italic])
        assertFormats("*italic‸*", [.italic])
        assertFormats("*italic*‸", [])

        assertFormats("‸_italic_", [])
        assertFormats("_‸italic_", [.italic])
        assertFormats("_ita‸lic_", [.italic])
        assertFormats("_italic‸_", [.italic])
        assertFormats("_italic_‸", [])

        // Strikethrough (double and single tilde GFM)
        assertFormats("‸~~strike~~", [])
        assertFormats("~‸~strike~~", [])
        assertFormats("~~‸strike~~", [.strikethrough])
        assertFormats("~~str‸ike~~", [.strikethrough])
        assertFormats("~~strike‸~~", [.strikethrough])
        assertFormats("~~strike~‸~", [])
        assertFormats("~~strike~~‸", [])

        assertFormats("‸~strike~", [])
        assertFormats("~‸strike~", [.strikethrough])
        assertFormats("~strike‸~", [.strikethrough])
        assertFormats("~strike~‸", [])

        // Code spans (single, double, and space-padded)
        assertFormats("‸`code`", [])
        assertFormats("`‸code`", [.code])
        assertFormats("`co‸de`", [.code])
        assertFormats("`code‸`", [.code])
        assertFormats("`code`‸", [])

        assertFormats("‸``code``", [])
        assertFormats("`‸`code``", [])
        assertFormats("``‸code``", [.code])
        assertFormats("``code‸``", [.code])
        assertFormats("``code`‸`", [])
        assertFormats("``code``‸", [])

        assertFormats("‸`` a `b` c ``", [])
        assertFormats("`‸` a `b` c ``", [])
        assertFormats("``‸ a `b` c ``", [.code])
        assertFormats("`` ‸a `b` c ``", [.code])
        assertFormats("`` a `b` c‸ ``", [.code])
        assertFormats("`` a `b` c ‸``", [.code])
        assertFormats("`` a `b` c `‸`", [])
        assertFormats("`` a `b` c ``‸", [])

        // Adjacent spans
        assertFormats("**one**‸ **two**", [])
        assertFormats("**one** ‸**two**", [])
        assertFormats("**one**‸__two__", [])
        assertFormats("*one*‸_two_", [])
        assertFormats("`one`‸ `two`", [])
        assertFormats("`one` ‸`two`", [])
        assertFormats("`one`‸**two**", [])
        assertFormats("~~one~~‸ **two**", [])
        assertFormats("~~one~~ ‸~~two~~", [])
        assertFormats("~~one~~‸**two**", [])
        assertFormats("**bold**‸*italic*", [])
    }

    func testEmptyDelimiterPairs() {
        assertFormats("**‸**", [.bold])
        assertFormats("*‸***", [])
        assertFormats("***‸*", [])
        assertFormats("‸****", [])
        assertFormats("****‸", [])

        assertFormats("__‸__", [.bold])
        assertFormats("_‸___", [])
        assertFormats("___‸_", [])

        assertFormats("*‸*", [.italic])
        assertFormats("‸**", [])
        assertFormats("**‸", [])

        assertFormats("_‸_", [.italic])
        assertFormats("‸__", [])
        assertFormats("__‸", [])

        assertFormats("***‸***", [.bold, .italic])
        assertFormats("___‸___", [.bold, .italic])

        assertFormats("~~‸~~", [.strikethrough])
        assertFormats("~‸~~~", [])
        assertFormats("~~~‸~", [])
        assertFormats("First\n\n~~‸~~\n\nLast", [.strikethrough])

        assertFormats("`‸`", [.code])
        assertFormats("‸``", [])
        assertFormats("``‸", [])

        // Escaped delimiter
        assertFormats("\\*‸*", [])

        // Inside list items
        assertFormats("- **‸**", [.bulletList, .bold])
        assertFormats("1. *‸*", [.numberedList, .italic])
        assertFormats("- [ ] ~~‸~~", [.checkList, .strikethrough])
        assertFormats("- `‸`", [.bulletList, .code])

        // Inside outer inline formatting
        assertFormats("*italic **‸** italic*", [.italic, .bold])
        assertFormats("**bold *‸* bold**", [.bold, .italic])

        // Suppressed inside code spans
        assertFormats("`*‸*`", [.code])
        assertFormats("`**‸**`", [.code])
    }

    func testNestedFormatting() {
        assertFormats("*italic with **‸bold** inside*", [.italic, .bold])
        assertFormats("*italic with **bo‸ld** inside*", [.italic, .bold])
        assertFormats("*italic with **bold‸** inside*", [.italic, .bold])
        assertFormats("*italic with *‸*bold** inside*", [.italic])
        assertFormats("*italic with ‸**bold** inside*", [.italic])

        assertFormats("**bold `‸code` bold**", [.bold, .code])
        assertFormats("**bold `co‸de` bold**", [.bold, .code])
        assertFormats("**bold `code‸` bold**", [.bold, .code])
        assertFormats("**bold ‸`code` bold**", [.bold])

        assertFormats("~~strike *‸italic* strike~~", [.strikethrough, .italic])
        assertFormats("***‸both***", [.bold, .italic])
        assertFormats("***both‸***", [.bold, .italic])
        assertFormats("- **bold *‸italic* item**", [.bulletList, .bold, .italic])
        assertFormats("- [x] ~~done `‸code`~~", [.checkList, .strikethrough, .code])
        assertFormats("[**bo‸ld** link](https://example.com)", [.bold])
    }

    func testPlainParagraphsAndFilteredBlocks() {
        assertFormats("‸", [])
        assertFormats("\n‸\n", [])
        assertFormats("   ‸   ", [])
        assertFormats("‸Hello world", [])
        assertFormats("Hello ‸world", [])
        assertFormats("Hello world‸", [])

        // Non-list blocks (headings, quotes, alerts, tables) are filtered out
        assertFormats("# ‸Heading", [])
        assertFormats("## Heading‸", [])
        assertFormats("# **bo‸ld** heading", [.bold])
        assertFormats("> ‸Quoted text", [])
        assertFormats("> [!NOTE]\n> ‸Alert body", [])
        assertFormats("> *ita‸lic* quote", [.italic])
        assertFormats("| ‸Cell | **bold** |\n|---|---|\n| 1 | 2 |", [])
        assertFormats("| Cell | **bo‸ld** |\n|---|---|\n| 1 | 2 |", [.bold])

        // UTF-16 surrogate pairs
        assertFormats("👋 **‸bold**", [.bold])
        assertFormats("👋 *‸*bold**", [])
        assertFormats("- 👋 ‸", [.bulletList])

        // Out-of-bounds & NSNotFound handling
        XCTAssertEqual(FormatCommandEdits.activeFormats(at: NSNotFound, in: "**bold**"), [])
        XCTAssertEqual(
            FormatCommandEdits.activeFormats(at: NSRange(location: NSNotFound, length: 0), in: "**bold**"),
            []
        )
        XCTAssertEqual(FormatCommandEdits.activeFormats(at: -5, in: "- item"), [.bulletList])
        XCTAssertEqual(FormatCommandEdits.activeFormats(at: 999, in: "- "), [.bulletList])
    }

    func testCodeBlocksSuppressFormats() {
        assertFormats("```swift\n**not ‸bold**\n- not a list\n```", [])
        assertFormats("```\n- ‸\n```", [])

        assertFormats("~~~\n~~not ‸strike~~\n~~~", [])
        assertFormats("~~~~\n**not ‸bold**\n~~~~", [])
        assertFormats("~~‸~~\ncode\n~~~~", [])

        assertFormats("```\n**not ‸bold**\n- ", [])
        assertFormats("```\n- ‸", [])

        assertFormats("    **not ‸bold**", [])
        assertFormats("    - ‸", [])
        assertFormats("    1. ‸", [])

        assertFormats("- item\n\n  ```\n  **not ‸bold**\n  ```", [])
    }

    func testSelectionRanges() {
        assertFormats("Hello **⟦bold⟧** world", [.bold])
        assertFormats("Hello **⟦bo⟧ld** world", [.bold])
        assertFormats("Hello ⟦**bold**⟧ world", [.bold])
        assertFormats("Hello ⟦*⟧*bold** world", [])
        assertFormats("Hello ⟦**⟧bold** world", [])
        assertFormats("⟦Hello **bold**⟧ world", [])
        assertFormats("Hello **⟦bold** world⟧", [])
        assertFormats("*italic **⟦bold⟧** italic*", [.italic, .bold])
        assertFormats("*⟦italic **bold**⟧*", [.italic])
        assertFormats("**bold⟦ ⟧words**", [.bold])
        assertFormats("**one**⟦ ⟧**two**", [])

        assertFormats("- ⟦one\n- two⟧", [.bulletList])
        assertFormats("⟦- \n- ⟧", [.bulletList])
        assertFormats("1. **⟦one**\n2. **two⟧**", [.numberedList, .bold])
        assertFormats("- [ ] ⟦first\n- [x] second⟧", [.checkList])
        assertFormats("⟦- bullet\n1. numbered⟧", [])
        assertFormats("⟦- bullet\n\nPlain⟧", [])
    }
}
