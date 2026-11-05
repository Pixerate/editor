import Foundation
import XCTest
@testable import PixerateMarkdown

/// HTMLToMarkdown runs on HTMLLiteDOM where Foundation's XMLDocument is missing (iOS). The paste
/// conversion cases in ParserChecks cover the converter on it in the iOS simulator run, or on macOS
/// with `swift test --filter PixerateMarkdownTests -Xswiftc -DPIXERATE_HTML_LITE`. (Its tree isn't
/// compared with XMLDocument's: tidy rewrites whitespace, so only the Markdown output agrees.)
final class HTMLLiteDOMTests: XCTestCase {
    private func outline(_ node: HTMLLiteNode) -> String {
        if node.kind == .text {
            let text = node.stringValue ?? ""
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text.debugDescription
        }
        let children = (node.children ?? []).map(outline).filter { !$0.isEmpty }
        return "\(node.name ?? "?")(\(children.joined(separator: ",")))"
    }

    func testClosesImpliedEndTags() throws {
        let body = try XCTUnwrap(HTMLLiteDocument(xmlString: "<html><body><ul><li>a<li>b</ul><p>x<p>y</body></html>").rootElement()?.elements(forName: "body").first)
        XCTAssertEqual(outline(body), #"body(ul(li("a"),li("b")),p("x"),p("y"))"#)
    }
}
