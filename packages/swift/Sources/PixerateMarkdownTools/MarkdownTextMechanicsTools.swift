// `check_text_mechanics` and `fix_text_mechanics` for a Markdown text (#609), the Swift side of
// `createTextMechanicsToolProvider` in packages/core/src/tools/text-mechanics-tools.ts: the same
// names, schemas and results, on PixerateMarkdown's `TextMechanics.findings`.

import Foundation
import PixerateCore
import PixerateMarkdown

public struct MarkdownTextMechanicsToolOptions {
    /// Provider id (unique per registry). Default `text-mechanics`.
    public var id: String
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `""` for bare names.
    public var namespace: String?
    public var profile: TextMechanicsOptions.Profile
    /// The host's spell checker; without one, spelling isn't checked and the result says so.
    public var spelling: TextMechanicsSpelling?
    /// Word classes for `its`, `id` and `ill` (e.g. `TextMechanics.naturalLanguageTagger`).
    public var tagger: TextMechanicsTagger?
    /// Which checks run (default: all but the typography checks, which are off by default).
    public var enabled: ((TextMechanicsCheck) -> Bool)?

    public init(id: String = "text-mechanics", namespace: String? = nil, profile: TextMechanicsOptions.Profile = .prose,
                spelling: TextMechanicsSpelling? = nil, tagger: TextMechanicsTagger? = nil, enabled: ((TextMechanicsCheck) -> Bool)? = nil) {
        self.id = id
        self.namespace = namespace
        self.profile = profile
        self.spelling = spelling
        self.tagger = tagger
        self.enabled = enabled
    }
}

/// The finding's sentence, as the web's `describe`.
private func describe(_ ns: NSString, _ edit: TextMechanicsEdit) -> String {
    let was = ns.substring(with: edit.range)
    if was.isEmpty {
        let start = max(0, edit.range.location - 24)
        let tail = ns.substring(with: NSRange(location: start, length: edit.range.location - start))
        let line = tail.components(separatedBy: "\n").last ?? ""
        let before = String(line.drop { $0.isWhitespace })
        return "Add \"\(edit.replacement)\" after \"\(before)\"."
    }
    return "Write \"\(was)\" as \"\(edit.replacement)\"."
}

/// `check_text_mechanics` and, while the host can be edited, `fix_text_mechanics`.
public func createMarkdownTextMechanicsToolProvider(_ host: MarkdownTextHost, _ options: MarkdownTextMechanicsToolOptions = MarkdownTextMechanicsToolOptions()) -> AgentToolProvider {
    let checkIds = TextMechanicsCheck.allCases
    let checksSchema: JSONValue = [
        "type": "array",
        "items": ["type": "string", "enum": .array(checkIds.map { .string($0.rawValue) })],
        "minItems": 1,
        "uniqueItems": true,
        "description": .string("Only these checks (default: all): \(checkIds.map { "\($0.rawValue) (\($0.title))" }.joined(separator: ", ")).")
    ]
    let inputSchema: JSONValue = ["type": "object", "properties": ["checks": checksSchema], "additionalProperties": false]

    func run(_ args: JSONObject) -> (text: String, findings: [TextMechanicsEdit]) {
        let only = args["checks"]?.arrayValue?.compactMap { $0.stringValue.flatMap(TextMechanicsCheck.init(rawValue:)) }
        let text = host.markdown
        let enabled = options.enabled
        let mechanics = TextMechanicsOptions(
            profile: options.profile,
            enabled: { check in (only == nil || only!.contains(check)) && (enabled?(check) ?? !check.isOffByDefault) },
            spelling: options.spelling,
            tagger: options.tagger
        )
        return (text, TextMechanics.findings(in: text, options: mechanics))
    }

    let check = AgentTool(
        name: "check_text_mechanics",
        title: "Check punctuation and spelling",
        description:
            "Checks the Markdown text for the small, certain fixes a writer expects: capital I, missing apostrophes (dont → don't; its, id and ill only where they're contractions), capitals at the start of sentences, a full stop or question mark at the end of a finished line, OK, a comma before a \"but\" that starts a clause, and spelling. Code, math, HTML, tables, links' addresses and URLs are never changed. Returns each finding with its check id, the text it changes, the replacement, a {from, to} UTF-16 range and a sentence; fix_text_mechanics applies them all at once. This is not house style (terms, tone, formats): use the house-style tools for that.",
        inputSchema: inputSchema,
        annotations: ToolAnnotations(title: "Check punctuation and spelling", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { args, _ in
            let (text, findings) = run(args)
            let ns = text as NSString
            var out: [(String, JSONValue)] = [
                ("ok", .bool(findings.isEmpty)),
                ("count", .number(Double(findings.count))),
                ("findings", .array(findings.map { f in
                    [
                        "check": .string(f.checks.first?.rawValue ?? ""),
                        "checks": .array(f.checks.map { .string($0.rawValue) }),
                        "from": .number(Double(f.range.location)),
                        "to": .number(Double(NSMaxRange(f.range))),
                        "text": .string(ns.substring(with: f.range)),
                        "replacement": .string(f.replacement),
                        "message": .string(describe(ns, f)),
                    ]
                })),
            ]
            if options.spelling == nil { out.append(("note", "No spell checker is available here, so spelling was not checked.")) }
            return .value(.object(JSONObject(out)))
        }
    )

    let fix = AgentTool(
        name: "fix_text_mechanics",
        title: "Fix punctuation and spelling",
        description: "Applies every fix check_text_mechanics finds, as one undo step. Pass checks to limit it to some of them. Returns how many it fixed. Run check_text_mechanics first to see what will change.",
        inputSchema: inputSchema,
        annotations: ToolAnnotations(title: "Fix punctuation and spelling", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { args, _ in
            if let reason = host.readOnlyReason {
                throw MarkdownToolError(reason.isEmpty ? "This text is read-only, so its punctuation and spelling cannot be fixed." : reason)
            }
            let (_, findings) = run(args)
            if !findings.isEmpty {
                let edits = findings.map { MarkdownTextEdit(range: $0.range, replacement: $0.replacement) }
                try host.apply(MarkdownTextChange(edits: edits, selection: mapRange(host.selectedRange, through: edits), actionName: "Fix Punctuation and Spelling"))
            }
            let byCheck = checkIds.compactMap { id -> (String, JSONValue)? in
                let n = findings.filter { $0.checks.contains(id) }.count
                return n > 0 ? (id.rawValue, .number(Double(n))) : nil
            }
            return .value(["fixed": .number(Double(findings.count)), "byCheck": .object(JSONObject(byCheck))])
        }
    )

    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Punctuation and spelling",
        description: "Check a Markdown text for punctuation, casing, apostrophes and spelling, and apply the certain fixes.",
        skill: "pixerate-rich-text",
        tools: { host.readOnlyReason == nil ? [check, fix] : [check] },
        subscribe: { listener in host.observeEditability(listener) ?? Cancellable {} }
    )
}
