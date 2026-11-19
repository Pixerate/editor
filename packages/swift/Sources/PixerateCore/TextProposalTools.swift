import Foundation

// Agent tools for text proposals (#890), a port of `createTextProposalToolProvider`
// (`tools/text-proposal-tools.ts`): `propose_text_edit`, `list_text_proposals`,
// `accept_text_proposal` and `reject_text_proposal`, with the TS names, schemas, descriptions,
// results and errors.

public struct TextProposalToolProviderOptions {
    /// Provider id (unique per registry). Default `text-proposals`.
    public var id: String
    /// Tool-name prefix; defaults to the provider id, `""` for bare names.
    public var namespace: String?
    /// Why accepting is not allowed (`accept_text_proposal` refuses with it), or nil.
    public var readOnly: (() -> String?)?
    /// Origin of proposals from calls that name no actor (default the store's).
    public var fallbackOrigin: String?

    public init(id: String = "text-proposals", namespace: String? = nil, readOnly: (() -> String?)? = nil, fallbackOrigin: String? = nil) {
        self.id = id
        self.namespace = namespace
        self.readOnly = readOnly
        self.fallbackOrigin = fallbackOrigin
    }
}

/// `new Date(ms).toISOString()`.
private func isoString(_ ms: Double) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}

private func described(_ p: TextProposal) -> JSONObject {
    var o = p.json.objectValue ?? JSONObject()
    o["createdAt"] = .string(isoString(p.createdAt))
    return o
}

private let PROPOSAL_ID: JSONValue = [
    "type": "object",
    "properties": ["proposalId": ["type": "string", "minLength": 1, "description": "Id of a pending text proposal, from propose_text_edit or list_text_proposals."]],
    "required": ["proposalId"],
    "additionalProperties": false,
]

private func annotations(_ title: String, read: Bool) -> ToolAnnotations {
    ToolAnnotations(title: title, readOnlyHint: read, destructiveHint: false, idempotentHint: read, openWorldHint: false)
}

/// The proposal tools for a text (`createTextProposalToolProvider`).
public func createTextProposalToolProvider(_ proposals: TextProposals, _ options: TextProposalToolProviderOptions = TextProposalToolProviderOptions()) -> AgentToolProvider {
    let propose = AgentTool(
        name: "propose_text_edit",
        title: "Propose a text edit",
        description: "Suggests replacing a range of the text without changing it: the person sees the suggestion and accepts or dismisses it, so use it for edits they did not ask for (a house-style fix, a clearer phrase). Take the range from a read or check tool (check_rich_text_style, check_text_mechanics, find_text) and pass the text you read there as expected. The proposal follows the text as the person keeps writing and is dropped if they edit what it would replace. Returns the proposal id, its range, the text it replaces and its title. Follow with accept_text_proposal only when the person asked for it.",
        inputSchema: [
            "type": "object",
            "properties": [
                "from": ["type": "integer", "minimum": 0, "description": "Start of the range to replace, as a UTF-16 offset into the text."],
                "to": ["type": "integer", "minimum": 0, "description": "End of the range (exclusive UTF-16 offset); equal to from to insert."],
                "replacement": ["type": "string", "description": "The text to put there; empty to delete the range."],
                "expected": ["type": "string", "description": "The text you read at from..to. The proposal is refused if the text there is different now. Default: not checked."],
                "title": ["type": "string", "minLength": 1, "description": "What the suggestion does, in a few words, e.g. \"Use the house term\". Shown to the person and the undo step name once accepted. Default: Replace \"…\" with \"…\"."],
                "rationale": ["type": "string", "description": "Why, in one sentence, e.g. the style rule it follows. Shown beside the suggestion."],
                "check": ["type": "string", "minLength": 1, "description": "The check id behind it (terms, heading-case, contractions, ...), when it comes from a check. Default none."],
            ],
            "required": ["from", "to", "replacement"],
            "additionalProperties": false,
        ],
        annotations: annotations("Propose a text edit", read: false),
        handler: { args, context in
            let origin = context.actor.map { "agent:\($0.id)" } ?? options.fallbackOrigin
            let p = try proposals.propose(
                from: Int(args["from"]?.numberValue ?? -1),
                to: Int(args["to"]?.numberValue ?? -1),
                replacement: args["replacement"]?.stringValue ?? "",
                expected: args["expected"]?.stringValue,
                title: args["title"]?.stringValue,
                rationale: args["rationale"]?.stringValue,
                check: args["check"]?.stringValue,
                origin: origin
            )
            var out = JSONObject([("proposalId", .string(p.id))])
            for (k, v) in described(p) where k != "id" && k != "createdAt" { out[k] = v }
            return .value(.object(out))
        }
    )
    let list = AgentTool(
        name: "list_text_proposals",
        title: "List text proposals",
        description: "Lists the pending text proposals (suggested replacements not yet in the text): id, current range (it moves as the person writes), the text it replaces, the replacement, title, rationale, check and who proposed it, and whether accepting is allowed. Proposals whose text the person edited are gone. Call before accept_text_proposal or reject_text_proposal.",
        inputSchema: ["type": "object", "properties": .object(JSONObject()), "additionalProperties": false],
        annotations: annotations("List text proposals", read: true),
        handler: { _, _ in
            proposals.sync()
            return .value(.object(JSONObject([
                ("proposals", .array(proposals.proposals.map { .object(described($0)) })),
                ("readOnly", options.readOnly?().map { .string($0) } ?? .null),
            ])))
        }
    )
    let accept = AgentTool(
        name: "accept_text_proposal",
        title: "Accept a text proposal",
        description: "Applies a pending text proposal as one undo step, recorded as made by whoever proposed it, and drops it from the pending list. Refuses, changing nothing, when the text is read-only or the text it would replace has changed (the proposal is then dropped). Returns the range the replacement now occupies, its text and the undo step name.",
        inputSchema: PROPOSAL_ID,
        annotations: annotations("Accept a text proposal", read: false),
        handler: { args, _ in
            if let reason = options.readOnly?() { throw ToolHandlerError(reason) }
            return .value(try proposals.accept(args["proposalId"]?.stringValue ?? "").json)
        }
    )
    let reject = AgentTool(
        name: "reject_text_proposal",
        title: "Reject a text proposal",
        description: "Dismisses a pending text proposal: the suggestion disappears and the text and its history are unchanged. Use it to withdraw a suggestion that no longer fits. Returns the dismissed proposal id and title.",
        inputSchema: PROPOSAL_ID,
        annotations: annotations("Reject a text proposal", read: false),
        handler: { args, _ in
            let p = try proposals.reject(args["proposalId"]?.stringValue ?? "")
            return .value(.object(JSONObject([("proposalId", .string(p.id)), ("title", .string(p.title)), ("rejected", .bool(true))])))
        }
    )
    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Text proposals",
        description: "Suggest text edits the person accepts or dismisses, and accept or reject pending suggestions.",
        skill: "pixerate-rich-text",
        tools: { [propose, list, accept, reject] }
    )
}
