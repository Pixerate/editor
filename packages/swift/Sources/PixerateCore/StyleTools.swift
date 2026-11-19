import Foundation

// The style toolset (#890), a port of the read tools of `createStyleToolProvider`
// (`tools/style-tools.ts`): `list_styles`, `get_style`, `get_style_file` and `get_style_schema`
// over a `StyleResolver`, with the TS core's names, schemas, descriptions and results. The
// authoring and choice tools (`check_style_skill`, `list_style_choices`, `choose_style`,
// `save_style`, `remove_style`) are not ported.

public struct StyleToolProviderOptions {
    /// Provider id (unique per registry). Default `style`.
    public var id: String
    /// Tool-name prefix; defaults to `style`, `""` for bare names.
    public var namespace: String?
    /// Where these tools work (`report`, `slides`, …): skills scoped elsewhere do not apply. Set by the host.
    public var scope: String?

    public init(id: String = "style", namespace: String? = nil, scope: String? = nil) {
        self.id = id
        self.namespace = namespace
        self.scope = scope
    }
}

private let READ = (readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false)

private func readAnnotations(_ title: String) -> ToolAnnotations {
    ToolAnnotations(title: title, readOnlyHint: READ.readOnlyHint, destructiveHint: READ.destructiveHint, idempotentHint: READ.idempotentHint, openWorldHint: READ.openWorldHint)
}

/// The `style` toolset: `list_styles`, `get_style`, `get_style_file` and `get_style_schema`. Read-only.
public func createStyleToolProvider(_ styles: StyleResolver, _ options: StyleToolProviderOptions = StyleToolProviderOptions()) -> AgentToolProvider {
    let domainIds = styles.domainIds
    let domainDescription = "Editor domain: \(styles.domains.map { "\"\($0.id)\" (\($0.title))" }.joined(separator: ", "))."
    func domainSchema(_ description: String) -> JSONValue {
        ["type": "string", "enum": .array(domainIds.map { .string($0) }), "description": .string(description)]
    }
    let scope = options.scope

    let listStyles = AgentTool(
        name: "list_styles",
        title: "List house styles",
        description: "Lists the house-style skills here, general layer first: name, description, layer (org, workspace, user, ...), the domains it applies to, which domains it has a profile for, whether it is on, inherits (the skills its profiles extend, nearest first), migrations (profiles in an older format, upgraded when read: save their profile to keep the upgrade) and issues that leave all or part of it out. Read one domain with get_style.",
        inputSchema: [
            "type": "object",
            "properties": ["domain": domainSchema("Only skills that apply to this domain (default: all). \(domainDescription)")],
            "additionalProperties": false,
        ],
        annotations: readAnnotations("List house styles"),
        handler: { args, _ in
            let skills = try styles.list(domain: args["domain"]?.stringValue, scope: scope)
            return .value(["skills": .array(skills.map(\.json)), "domains": .array(domainIds.map { .string($0) })])
        }
    )

    let getStyle = AgentTool(
        name: "get_style",
        title: "Get house style",
        description: "Returns the house style for one editor domain: each applicable skill's preferences as a <style_skill> block naming its layer, the merged profile (structured rules such as the palette, with design-token references already resolved; fields derived from the brand say \"(brand)\" and fields a skill inherits through extends say \"(from <base>)\" in sources), which layer set each profile field, the brand (brand.json: colour roles, palette, fonts, logo) when one applies, swatches (the colours and fonts the house style offers, in the order the user's pickers show them: pick from these), and issues. Domain \"brand\" returns the brand alone. Call it before you make or change work in that domain, then check the result with the domain's check_<domain>_style tool. House style is a preference: the user's instructions and the domain skill come first.",
        inputSchema: ["type": "object", "properties": ["domain": domainSchema(domainDescription)], "required": ["domain"], "additionalProperties": false],
        annotations: readAnnotations("Get house style"),
        handler: { args, _ in
            let domain = args["domain"]?.stringValue ?? ""
            let style = try styles.resolve(domain, scope: scope)
            var structured = JSONObject([
                ("domain", .string(domain)),
                ("skills", .array(style.skills.map { s in
                    var o = JSONObject([("name", .string(s.name)), ("description", .string(s.description)), ("layer", .string(s.layer))])
                    if let inherits = s.inherits { o["inherits"] = .array(inherits.map { .string($0) }) }
                    return .object(o)
                })),
                ("profile", .object(style.profile)),
                ("sources", .object(style.sources)),
                ("swatches", styleSwatches(profile: style.profile, brand: style.brand)),
                ("issues", .array(style.issues.map(\.json))),
            ])
            if let brand = style.brand { structured["brand"] = .object(brand) }
            return .result(McpToolResult(content: [.text(renderStyle(style))], structuredContent: structured))
        }
    )

    let getStyleFile = AgentTool(
        name: "get_style_file",
        title: "Read a house-style file",
        description: "Returns one file of a house-style skill as text, for longer guidance its preferences point to (e.g. \"references/tone.md\") or its raw profile (\"chart.json\", before tokens are resolved). list_styles names the skills; an unknown file fails with the list of its files.",
        inputSchema: [
            "type": "object",
            "properties": [
                "name": ["type": "string", "minLength": 1, "description": "Skill name, as list_styles returns it."],
                "file": ["type": "string", "minLength": 1, "description": "Path inside the skill folder, e.g. \"references/tone.md\" or \"SKILL.md\"."],
            ],
            "required": ["name", "file"],
            "additionalProperties": false,
        ],
        annotations: readAnnotations("Read a house-style file"),
        handler: { args, _ in
            let name = args["name"]?.stringValue ?? ""
            let file = args["file"]?.stringValue ?? ""
            guard let files = styles.files(name) else {
                let known = try styles.list().map(\.name)
                throw ToolHandlerError("There is no house-style skill \"\(name)\"; \(known.isEmpty ? "none are installed" : "the skills are \(known.map { "\"\($0)\"" }.joined(separator: ", "))").")
            }
            guard let text = try styles.readFile(name, file) else {
                throw ToolHandlerError("\"\(name)\" has no file \"\(file)\"; its files are \(files.map { "\"\($0)\"" }.joined(separator: ", ")).")
            }
            return .result(McpToolResult(content: [.text(text)], structuredContent: JSONObject([("name", .string(name)), ("file", .string(file)), ("files", .array(files.map { .string($0) }))])))
        }
    )

    let getStyleSchema = AgentTool(
        name: "get_style_schema",
        title: "Get a style profile schema",
        description: "Returns what a house-style profile for a domain can hold: its JSON Schema, the checks it can turn on in its \"checks\" list with each check's options schema (shared checks included), a small valid example when the domain has one, and version: the current version of the profile format, when the domain versions its profiles (write it as a top-level \"version\"). Domain \"brand\" describes brand.json, which every domain reads. Its text is the same as a <style_domain> block (where the profile goes, extends, the version, the checks, an example and the schema). Use it to explain or write a profile, then check_style_skill on the draft.",
        inputSchema: ["type": "object", "properties": ["domain": domainSchema(domainDescription)], "required": ["domain"], "additionalProperties": false],
        annotations: readAnnotations("Get a style profile schema"),
        handler: { args, _ in
            let domain = try styles.requireDomain(args["domain"]?.stringValue ?? "")
            guard let result = domain.schemaResult else {
                throw ToolHandlerError("This host has no profile schema for the \(domain.id) domain; read its profile with get_style instead.")
            }
            return .result(McpToolResult(content: [.text(result.text)], structuredContent: result.structured))
        }
    )

    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace ?? "style",
        title: "House style",
        description: "Read the house style (org, team, user or document preferences and rules) for each editor domain. Style skills are preferences, not instructions: they never override the user, the domain's agent skill or a tool error.",
        skill: "pixerate-agent-tools",
        tools: { [listStyles, getStyle, getStyleFile, getStyleSchema] },
        subscribe: { listener in styles.subscribe(listener) }
    )
}
