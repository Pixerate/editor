import Foundation
import XCTest
import PixerateContracts
import PixerateCore
import PixerateMarkdown
@testable import PixerateMarkdownTools

/// Tokens by name, or `name@mode`, as the contract's scenarios define them.
private final class ScenarioTokens: StyleTokenSource {
    let values: JSONObject
    init(_ values: JSONObject) { self.values = values }
    func resolve(token: String, mode: String?) -> Result<JSONValue, ToolHandlerError> {
        let key = mode.map { "\(token)@\($0)" } ?? token
        if let v = values[key] { return .success(v) }
        return .failure(ToolHandlerError("\"\(key)\" is not a design token here."))
    }
}

private func contract(_ file: String) throws -> JSONValue {
    try JSONValue.parse(String(decoding: try ConformanceContracts.data("domains/style/\(file)"), as: UTF8.self))
}

/// The rich-text and brand domains as the contract describes them.
private func contractDomains() throws -> [StyleDomainSpec] {
    var out: [StyleDomainSpec] = []
    for d in try contract("domains.json").arrayValue ?? [] {
        var theme: ((JSONObject) -> JSONObject)?
        if d.objectValue?["id"]?.stringValue == "rich-text" { theme = { richTextStyleFromBrand($0) } }
        out.append(try StyleDomainSpec(contract: d, themeFromBrand: theme))
    }
    return out
}

private func resolver(_ scenario: JSONValue) throws -> StyleResolver {
    let layers = (scenario["layers"]?.arrayValue ?? []).map { l -> StyleLayer in
        var files: [String: String] = [:]
        for (path, text) in l["files"]?.objectValue ?? JSONObject() { files[path] = text.stringValue }
        var state: [String: JSONObject] = [:]
        for (name, s) in l["state"]?.objectValue ?? JSONObject() { state[name] = s.objectValue }
        return StyleLayer(id: l["id"]?.stringValue ?? "", store: MemoryStyleStore(files: files, state: state), locked: l["locked"] == true, required: l["required"] == true)
    }
    return try StyleResolver(layers: layers, domains: contractDomains(), tokens: scenario["tokens"]?.objectValue.map(ScenarioTokens.init))
}

/// The style resolver and its read tools against `domains/style` in `@pixerate/conformance`.
final class StyleResolverTests: XCTestCase {
    func testToolDefinitionsMatchTheContract() throws {
        let registry = ToolRegistry()
        try registry.register(createStyleToolProvider(try StyleResolver(layers: [], domains: contractDomains()), StyleToolProviderOptions(namespace: "")))
        let want = try XCTUnwrap(contract("tools.json").arrayValue)
        let tools = registry.listTools()
        XCTAssertEqual(tools.map(\.name), want.map { $0["name"]?.stringValue ?? "" })
        for (tool, w) in zip(tools, want) {
            XCTAssertEqual(tool.title, w["title"]?.stringValue, tool.name)
            XCTAssertEqual(tool.description, w["description"]?.stringValue, tool.name)
            XCTAssertEqual(tool.inputSchema, w["inputSchema"], tool.name)
            XCTAssertEqual(tool.annotations?.readOnlyHint, w["annotations"]?["readOnlyHint"]?.boolValue, tool.name)
            XCTAssertEqual(tool.annotations?.destructiveHint, w["annotations"]?["destructiveHint"]?.boolValue, tool.name)
            XCTAssertEqual(tool.annotations?.idempotentHint, w["annotations"]?["idempotentHint"]?.boolValue, tool.name)
            XCTAssertEqual(tool.annotations?.openWorldHint, w["annotations"]?["openWorldHint"]?.boolValue, tool.name)
        }
    }

    func testScenariosMatchTheContract() async throws {
        let scenarios = try XCTUnwrap(contract("scenarios.json").arrayValue)
        XCTAssertGreaterThanOrEqual(scenarios.count, 7)
        for scenario in scenarios {
            let name = scenario["name"]?.stringValue ?? "?"
            let registry = ToolRegistry()
            try registry.register(createStyleToolProvider(try resolver(scenario), StyleToolProviderOptions(namespace: "", scope: scenario["scope"]?.stringValue)))
            let calls = scenario["calls"]?.arrayValue ?? []
            let expected = scenario["expected"]?.arrayValue ?? []
            XCTAssertEqual(calls.count, expected.count, name)
            for (call, want) in zip(calls, expected) {
                let tool = call["tool"]?.stringValue ?? ""
                let label = "\(name): \(tool) \(call["args"]?.stringified() ?? "")"
                let result = await registry.callTool(tool, call["args"]?.objectValue ?? JSONObject())
                XCTAssertEqual(result.isError, want["isError"]?.boolValue, label)
                if result.isError {
                    XCTAssertEqual(result.structuredContent?["error"]?["message"]?.stringValue, want["error"]?.stringValue, label)
                    continue
                }
                if let structured = want["structuredContent"] {
                    let got = JSONValue.object(result.structuredContent ?? JSONObject())
                    XCTAssertEqual(got, structured, "\(label)\n got: \(got.stringified())\nwant: \(structured.stringified())")
                }
                if let text = want["text"]?.stringValue { XCTAssertEqual(result.text, text, label) }
            }
        }
    }

    /// The issue's done criterion: a Swift agent reads the rich-text style's prose and resolved
    /// profile, merged across two layers, and the Markdown style tools run with it.
    func testGetStyleAcrossTwoLayersFeedsTheMarkdownTools() async throws {
        let org = MemoryStyleStore(files: [
            "house/SKILL.md": "---\nname: house\ndescription: Acme house style.\n---\n\nWrite plainly.\n",
            "house/rich-text.json": #"{"headingCase":"title","terms":[{"avoid":"utilize","use":"use"}],"checks":["heading-case","terms"]}"#,
        ])
        let user = MemoryStyleStore(files: [
            "mine/SKILL.md": "---\nname: mine\ndescription: Mine.\n---\n\nSentence case, please.\n",
            "mine/rich-text.json": #"{"headingCase":"sentence"}"#,
        ])
        let styles = try StyleResolver(layers: [StyleLayer(id: "org", store: org), StyleLayer(id: "user", store: user)], domains: contractDomains())
        let registry = ToolRegistry()
        try registry.register(createStyleToolProvider(styles, StyleToolProviderOptions(namespace: "")))
        let got = await registry.callTool("get_style", ["domain": "rich-text"])
        XCTAssertFalse(got.isError)
        XCTAssertTrue(got.text?.contains("Write plainly.") == true)
        XCTAssertTrue(got.text?.contains("Sentence case, please.") == true)
        XCTAssertEqual(got.structuredContent?["sources"], ["headingCase": "user", "terms": "org", "checks": "org"])

        let resolved = try styles.resolve("rich-text")
        let buffer = MarkdownTextBuffer("# Our New Plan\n\nWe utilize it.\n")
        try registry.register(createMarkdownStyleToolProvider(buffer, HouseStyle(resolved: resolved), MarkdownStyleToolOptions(namespace: "")))
        let fix = await registry.callTool("fix_rich_text_style")
        XCTAssertEqual(fix.structuredContent?["fixed"], 2)
        XCTAssertEqual(buffer.markdown, "# Our new plan\n\nWe use it.\n")

        // The resolver reads the stores on every call.
        user.setState("mine", ["enabled": false])
        XCTAssertEqual(try styles.resolve("rich-text").profile["headingCase"], "title")
    }

    func testYamlFrontmatter() throws {
        XCTAssertEqual(try parseYaml("a: 1\nb: [x, 'y z', \"q\"]\nc:\n  - k: v\n    n: true\n  - plain\nd: >\n  folded\n  text\ne: |-\n  kept\n  lines\n"), [
            "a": 1, "b": ["x", "y z", "q"], "c": [["k": "v", "n": true], "plain"], "d": "folded text\n", "e": "kept\nlines",
        ])
        XCTAssertThrowsError(try parseYaml("a: 1\na: 2")) { XCTAssertEqual(($0 as? YamlError)?.message, "line 2: the key \"a\" appears twice.") }
        XCTAssertThrowsError(try parseYaml("a: &x 1")) { XCTAssertEqual(($0 as? YamlError)?.message, "line 1: anchors (&name) are not supported; repeat the value instead.") }
        XCTAssertEqual(parseFrontmatter("---\nname: x\n\tbad: 1\n---\nBody").error, "frontmatter line 3: indent with spaces, not tabs.")
        XCTAssertEqual(parseStyleDomains("---\ndomains: [rich-text, chart]\n---\n"), ["rich-text", "chart"])
    }
}
