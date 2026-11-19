import Foundation

// A port of the strict YAML reader for skill frontmatter (`tools/yaml.ts`) and the frontmatter
// helpers the style resolver uses (`parseSkillFrontmatter` in `tools/skills.ts`,
// `parseStyleDomains` and `frontmatterField` in `tools/style.ts`). Values come back as
// `JSONValue`; errors say the line, in the TS core's words.

// MARK: - JavaScript regular expressions

private let JS_SPACE = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"
private let JS_WORD = "A-Za-z0-9_"

/// A JavaScript regular expression run by ICU (see `JSRegExp` in PixerateMarkdown, which this
/// module cannot import): `$` becomes `\z`, `\d` / `\s` / `\w` / `\b` take JavaScript's sets,
/// and `[` inside a class is escaped.
struct JSRegex: @unchecked Sendable {
    let regex: NSRegularExpression

    init(_ pattern: String, ignoreCase: Bool = false) {
        var out = ""
        var inClass = false
        let chars = Array(pattern)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\" && i + 1 < chars.count {
                let n = chars[i + 1]
                i += 2
                switch n {
                case "d": out += inClass ? "0-9" : "[0-9]"
                case "D": out += "[^0-9]"
                case "s": out += inClass ? JS_SPACE : "[\(JS_SPACE)]"
                case "S": out += "[^\(JS_SPACE)]"
                case "w": out += inClass ? JS_WORD : "[\(JS_WORD)]"
                case "W": out += "[^\(JS_WORD)]"
                case "b": out += inClass ? "\\x{08}" : "(?:(?<=[\(JS_WORD)])(?![\(JS_WORD)])|(?<![\(JS_WORD)])(?=[\(JS_WORD)]))"
                default: out += "\\\(n)"
                }
                continue
            }
            if inClass {
                if c == "]" { inClass = false; out += "]" } else if c == "[" { out += "\\[" } else { out.append(c) }
            } else {
                if c == "[" { inClass = true; out += "[" } else if c == "$" { out += "\\z" } else { out.append(c) }
            }
            i += 1
        }
        regex = try! NSRegularExpression(pattern: out, options: ignoreCase ? [.caseInsensitive] : [])
    }

    func exec(_ text: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length))
    }

    func test(_ text: String) -> Bool { exec(text) != nil }

    static func group(_ m: NSTextCheckingResult, _ i: Int, in text: String) -> String? {
        let r = m.range(at: i)
        return r.location == NSNotFound ? nil : (text as NSString).substring(with: r)
    }
}

// MARK: - String helpers (UTF-16, as the TS indexes)

private func units16(_ s: String) -> [UInt16] { Array(s.utf16) }
private func str(_ u: some Collection<UInt16>) -> String { String(decoding: Array(u), as: UTF16.self) }
private func ch(_ s: String) -> UInt16 { s.utf16.first! }

private func isJSSpaceUnit(_ c: UInt16) -> Bool {
    switch c {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

extension String {
    /// `String.prototype.trimEnd`.
    var jsTrimmedEnd: String {
        var u = units16(self)
        while let last = u.last, isJSSpaceUnit(last) { u.removeLast() }
        return str(u)
    }

    /// `text.split(/\r?\n/)`.
    var jsLines: [String] {
        components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    }
}

// MARK: - YAML

/// A YAML problem, with the 1-based line (`YamlError`).
public struct YamlError: Error, Equatable, Sendable {
    public var line: Int
    /// `line <n>: <problem>`.
    public var message: String
    init(_ problem: String, _ line: Int) {
        self.line = line
        message = "line \(line): \(problem)"
    }
}

private struct YamlLine {
    var n: Int
    var indent: Int
    var text: String
}

private let NUMBER = JSRegex("^[-+]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?$")
private let QUOTE_BEFORE = JSRegex("[\\s[{,:-]")
private let SPACE = JSRegex("\\s")

/// Removes a ` #` comment outside quotes.
private func stripComment(_ text: String, _ n: Int) throws -> String {
    let u = units16(text)
    var quote: UInt16?
    var i = 0
    while i < u.count {
        let c = u[i]
        if let q = quote {
            if c == ch("\\") && q == ch("\"") { i += 1 }
            else if c == q {
                if q == ch("'") && i + 1 < u.count && u[i + 1] == ch("'") { i += 1 } else { quote = nil }
            }
            i += 1
            continue
        }
        if (c == ch("\"") || c == ch("'")) && (i == 0 || QUOTE_BEFORE.test(str([u[i - 1]]))) { quote = c }
        else if c == ch("#") && (i == 0 || isJSSpaceUnit(u[i - 1])) { return str(u[0 ..< i]).jsTrimmedEnd }
        i += 1
    }
    if let q = quote { throw YamlError("an unclosed \(q == ch("\"") ? "double" : "single") quote; quotes must close on the same line.", n) }
    return text
}

private let ANCHOR = JSRegex("^&\\S"), ALIAS = JSRegex("^\\*\\S"), TAG = JSRegex("^!")

private func refuse(_ text: String, _ n: Int) throws {
    let t = text.jsTrimmedStart
    if ANCHOR.test(t) { throw YamlError("anchors (&name) are not supported; repeat the value instead.", n) }
    if ALIAS.test(t) { throw YamlError("aliases (*name) are not supported; repeat the value instead.", n) }
    if TAG.test(t) { throw YamlError("tags (!tag) are not supported; write the plain value.", n) }
}

private func scalar(_ raw: String, _ n: Int) throws -> JSONValue {
    let text = raw.jsTrimmed
    if text.isEmpty { return .null }
    try refuse(text, n)
    let u = units16(text)
    if text.hasPrefix("\"") {
        if !text.hasSuffix("\"") || u.count < 2 { throw YamlError("a double-quoted value must end with \" on the same line.", n) }
        guard case .string(let s)? = try? JSONValue.parse(text.replacingOccurrences(of: "\\'", with: "'")) else {
            throw YamlError("\(text) is not a valid double-quoted string.", n)
        }
        return .string(s)
    }
    if text.hasPrefix("'") {
        if !text.hasSuffix("'") || u.count < 2 { throw YamlError("a single-quoted value must end with ' on the same line.", n) }
        return .string(str(u[1 ..< u.count - 1]).replacingOccurrences(of: "''", with: "'"))
    }
    if text.hasPrefix("[") || text.hasPrefix("{") { return try flow(text, n) }
    if text == "true" { return .bool(true) }
    if text == "false" { return .bool(false) }
    if text == "null" || text == "~" { return .null }
    if NUMBER.test(text) { return .number(text.jsToNumber) }
    return .string(text)
}

/// `String(value)` for a scalar used as a key.
private func keyString(_ v: JSONValue) -> String {
    switch v {
    case .string(let s): return s
    case .number(let d): return JSONValue.jsString(d)
    case .bool(let b): return b ? "true" : "false"
    case .null: return "null"
    default: return v.stringified()
    }
}

/// A one-line flow list or map.
private func flow(_ text: String, _ n: Int) throws -> JSONValue {
    let u = units16(text)
    var i = 0
    func at(_ k: Int) -> UInt16? { k < u.count ? u[k] : nil }
    func ws() { while i < u.count && isJSSpaceUnit(u[i]) { i += 1 } }
    /// A scalar up to a flow delimiter (or `stop`), keeping quoted text whole.
    func token(_ stop: UInt16? = nil) -> String {
        ws()
        let start = i
        if at(i) == ch("\"") || at(i) == ch("'") {
            let q = u[i]
            i += 1
            while i < u.count && u[i] != q { i += u[i] == ch("\\") && q == ch("\"") ? 2 : 1 }
            i += 1
            return str(u[start ..< min(i, u.count)])
        }
        while i < u.count && ![ch(","), ch("]"), ch("}")].contains(u[i]) && !(stop != nil && u[i] == stop && (at(i + 1).map(isJSSpaceUnit) ?? true)) { i += 1 }
        return str(u[start ..< i]).jsTrimmed
    }
    func value() throws -> JSONValue {
        ws()
        let c = at(i)
        if c == ch("[") {
            i += 1
            var out: [JSONValue] = []
            ws()
            if at(i) == ch("]") { i += 1; return .array(out) }
            while true {
                out.append(try value())
                ws()
                if at(i) == ch(",") { i += 1; continue }
                if at(i) == ch("]") { i += 1; return .array(out) }
                throw YamlError("expected , or ] in \(text).", n)
            }
        }
        if c == ch("{") {
            i += 1
            var out = JSONObject()
            ws()
            if at(i) == ch("}") { i += 1; return .object(out) }
            while true {
                ws()
                let key = token(ch(":"))
                if at(i) != ch(":") { throw YamlError("expected key: value in \(text).", n) }
                i += 1
                let k = keyString(try scalar(key, n))
                if out.contains(k) { throw YamlError("the key \"\(k)\" appears twice.", n) }
                out[k] = try value()
                ws()
                if at(i) == ch(",") { i += 1; continue }
                if at(i) == ch("}") { i += 1; return .object(out) }
                throw YamlError("expected , or } in \(text).", n)
            }
        }
        return try scalar(token(), n)
    }
    let out = try value()
    ws()
    if i < u.count { throw YamlError("unexpected text after \(str(u[0 ..< i])).", n) }
    return out
}

private let TAB_INDENT = JSRegex("^\\s*\\t")
private let DOC_MARKER = JSRegex("^(---|\\.\\.\\.)\\s*$")
private let BLOCK_STYLE = JSRegex("^[|>][-+]?$")
private let QUOTED_OR_FLOW_START = JSRegex("^[\"'\\[{]")
private let KEY_IN_WRAP = JSRegex(":\\s|:$")
private let MAP_KEY = JSRegex("^(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^']|'')*'|[^:#][^:]*?)\\s*:(\\s+|$)(.*)$")
private let ITEM_KEY = JSRegex("^(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^']|'')*'|[^:#\\s[{\"'][^:]*?)\\s*:(\\s+|$)")

/// Parses frontmatter-sized YAML into a value (`parseYaml`). Throws `YamlError` with the line.
public func parseYaml(_ source: String) throws -> JSONValue {
    var lines: [YamlLine] = []
    for (idx, raw) in source.jsLines.enumerated() {
        let n = idx + 1
        if TAB_INDENT.test(raw) { throw YamlError("indent with spaces, not tabs.", n) }
        if DOC_MARKER.test(raw) { throw YamlError("only one document is allowed.", n) }
        lines.append(YamlLine(n: n, indent: raw.utf16.count - raw.jsTrimmedStart.utf16.count, text: raw.jsTrimmedEnd))
    }
    var pos = 0
    func blank(_ l: YamlLine) -> Bool { l.text.jsTrimmed.isEmpty || l.text.jsTrimmedStart.hasPrefix("#") }
    func skip() { while pos < lines.count && blank(lines[pos]) { pos += 1 } }
    func startsItem(_ text: String) -> Bool { text.hasPrefix("- ") || text == "-" }

    func blockText(_ style: String, _ parent: Int) throws -> String {
        let s = Array(style)
        let fold = s[0] == ">"
        let chomp = s.count > 1 ? s[1] : nil
        var body: [String] = []
        var indent = -1
        while pos < lines.count {
            let l = lines[pos]
            if l.text.jsTrimmed.isEmpty {
                body.append("")
                pos += 1
                continue
            }
            if l.indent <= parent { break }
            if indent < 0 { indent = l.indent }
            if l.indent < indent { throw YamlError("block text lines must keep the indent of its first line.", l.n) }
            body.append(str(units16(l.text).dropFirst(indent)))
            pos += 1
        }
        var trailing = 0
        while body.last == "" {
            body.removeLast()
            trailing += 1
        }
        var text: String
        if fold {
            text = ""
            for (i, line) in body.enumerated() {
                if i == 0 { text = line }
                else if line.isEmpty { text += "\n" }
                else if text.hasSuffix("\n") || text.isEmpty { text += line }
                else { text += " " + line }
            }
        } else {
            text = body.joined(separator: "\n")
        }
        if chomp == "+" { text += String(repeating: "\n", count: trailing + 1) }
        else if chomp != "-" && !body.isEmpty { text += "\n" }
        return text
    }

    func value(_ indent: Int) throws -> JSONValue {
        skip()
        if pos >= lines.count || lines[pos].indent < indent { return .null }
        let first = lines[pos]
        let t = first.text.jsTrimmedStart
        return t.hasPrefix("- ") || first.text.jsTrimmed == "-" ? try list(first.indent) : try map(first.indent)
    }

    func after(_ rest: String, _ n: Int, _ indent: Int) throws -> JSONValue {
        let text = try stripComment(rest, n).jsTrimmed
        if text.isEmpty {
            skip()
            if pos < lines.count && lines[pos].indent > indent { return try value(lines[pos].indent) }
            if pos < lines.count && lines[pos].indent == indent && lines[pos].text.jsTrimmedStart.hasPrefix("- ") { return try list(indent) }
            return .null
        }
        if BLOCK_STYLE.test(text) { return .string(try blockText(text, indent)) }
        let v = try scalar(text, n)
        // A plain value may wrap onto more-indented lines.
        if case .string(var out) = v, !QUOTED_OR_FLOW_START.test(text) {
            while pos < lines.count && !blank(lines[pos]) && lines[pos].indent > indent {
                let cont = try stripComment(lines[pos].text.jsTrimmed, lines[pos].n)
                if KEY_IN_WRAP.test(cont) { throw YamlError("a wrapped value cannot contain \": \"; quote it or use > block text.", lines[pos].n) }
                out += " \(cont)"
                pos += 1
            }
            return .string(out)
        }
        return v
    }

    func map(_ indent: Int) throws -> JSONValue {
        var out = JSONObject()
        while pos < lines.count {
            skip()
            if pos >= lines.count { break }
            let l = lines[pos]
            if l.indent < indent { break }
            if l.indent > indent { throw YamlError("this line is indented more than the key before it expects.", l.n) }
            let text = l.text.jsTrimmed
            if text.hasPrefix("- ") { throw YamlError("a list item where a key was expected.", l.n) }
            if text.hasPrefix("? ") { throw YamlError("complex keys (?) are not supported.", l.n) }
            try refuse(text, l.n)
            guard let m = MAP_KEY.exec(text) else { throw YamlError("expected \"key: value\", got \"\(text)\".", l.n) }
            let key = keyString(try scalar(JSRegex.group(m, 1, in: text) ?? "", l.n))
            if out.contains(key) { throw YamlError("the key \"\(key)\" appears twice.", l.n) }
            pos += 1
            out[key] = try after(JSRegex.group(m, 3, in: text) ?? "", l.n, indent)
        }
        return .object(out)
    }

    func list(_ indent: Int) throws -> JSONValue {
        var out: [JSONValue] = []
        while pos < lines.count {
            skip()
            if pos >= lines.count { break }
            let l = lines[pos]
            if l.indent < indent { break }
            let text = l.text.jsTrimmedStart
            if l.indent > indent || !startsItem(text) {
                if l.indent == indent { break }
                throw YamlError("this line is indented more than the list expects.", l.n)
            }
            let rest = text == "-" ? "" : str(units16(text).dropFirst(2))
            let itemIndent = l.indent + 2
            if ITEM_KEY.test(rest) {
                // "- key: value" starts a map at the item's indent.
                lines[pos] = YamlLine(n: l.n, indent: itemIndent, text: String(repeating: " ", count: itemIndent) + rest)
                out.append(try map(itemIndent))
                continue
            }
            pos += 1
            out.append(try after(rest, l.n, l.indent))
        }
        return .array(out)
    }

    skip()
    if pos >= lines.count { return .null }
    let result = try value(lines[pos].indent)
    skip()
    if pos < lines.count { throw YamlError("unexpected text; check the indentation.", lines[pos].n) }
    return result
}

/// The frontmatter of a Markdown file (`parseFrontmatter`): its data, the body, and why it could not be read.
public struct Frontmatter: Sendable {
    public var data: JSONObject
    public var body: String
    public var error: String?
    public var present: Bool
}

private let FRONTMATTER = JSRegex("^---\\r?\\n(?:([\\s\\S]*?)\\r?\\n)?---(?:\\r?\\n|$)")

public func parseFrontmatter(_ markdown: String) -> Frontmatter {
    guard let m = FRONTMATTER.exec(markdown) else { return Frontmatter(data: JSONObject(), body: markdown, error: nil, present: false) }
    let ns = markdown as NSString
    let body = ns.substring(from: m.range.length)
    do {
        let data = try parseYaml(JSRegex.group(m, 1, in: markdown) ?? "")
        if data == .null { return Frontmatter(data: JSONObject(), body: body, error: nil, present: true) }
        guard case .object(let obj) = data else { return Frontmatter(data: JSONObject(), body: body, error: "frontmatter must be key: value lines.", present: true) }
        return Frontmatter(data: obj, body: body, error: nil, present: true)
    } catch let e as YamlError {
        // Frontmatter starts on the file's second line.
        let problem = e.message.replacingOccurrences(of: "^line \\d+: ", with: "", options: .regularExpression)
        return Frontmatter(data: JSONObject(), body: body, error: "frontmatter line \(e.line + 1): \(problem)", present: true)
    } catch {
        return Frontmatter(data: JSONObject(), body: body, error: "\(error)", present: true)
    }
}

private let SKILL_FRONTMATTER = JSRegex("^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?")
private let SKILL_FIELD = JSRegex("^([A-Za-z_-]+):\\s*(.*)$")
private let SKILL_NESTED = JSRegex("^\\s+([A-Za-z_-]+):\\s*(.*)$")
private let SURROUNDING_QUOTES = JSRegex("^(['\"])([\\s\\S]*)\\1$")

/// `value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')`.
private func unquote(_ value: String) -> String {
    let t = value.jsTrimmed
    guard let m = SURROUNDING_QUOTES.exec(t) else { return t }
    return JSRegex.group(m, 2, in: t) ?? t
}

/// The loose frontmatter reader agent skills use (`parseSkillFrontmatter`): name, description and body.
public func parseSkillFrontmatter(_ markdown: String) -> (name: String?, description: String?, body: String) {
    guard let m = SKILL_FRONTMATTER.exec(markdown) else { return (nil, nil, markdown) }
    var fields: [String: String] = [:]
    for line in (JSRegex.group(m, 1, in: markdown) ?? "").jsLines {
        if let kv = SKILL_FIELD.exec(line) {
            fields[JSRegex.group(kv, 1, in: line)!] = unquote(JSRegex.group(kv, 2, in: line) ?? "")
        }
        _ = SKILL_NESTED
    }
    return (fields["name"], fields["description"], (markdown as NSString).substring(from: m.range.length))
}

private let FRONTMATTER_BLOCK = JSRegex("^---\\r?\\n([\\s\\S]*?)\\r?\\n---")

/// A one-line frontmatter field (`group: look`), unquoted, or nil (`frontmatterField`).
func frontmatterField(_ markdown: String, _ key: String) -> String? {
    guard let m = FRONTMATTER_BLOCK.exec(markdown) else { return nil }
    guard let line = (JSRegex.group(m, 1, in: markdown) ?? "").jsLines.first(where: { $0.hasPrefix("\(key):") }) else { return nil }
    let value = unquote(str(units16(line).dropFirst(units16(key).count + 1)))
    return value.isEmpty ? nil : value
}

/// The `domains` frontmatter field (`parseStyleDomains`): `[chart, tokens]`, `chart, tokens` or one name.
public func parseStyleDomains(_ markdown: String) -> [String]? {
    let fm = parseFrontmatter(markdown)
    if fm.error == nil { return styleDomainsOf(fm.data["domains"]) }
    guard let m = FRONTMATTER_BLOCK.exec(markdown),
          let line = (JSRegex.group(m, 1, in: markdown) ?? "").jsLines.first(where: { $0.hasPrefix("domains:") }) else { return nil }
    var raw = str(units16(line).dropFirst("domains:".utf16.count)).jsTrimmed
    if raw.hasPrefix("[") { raw.removeFirst() }
    if raw.hasSuffix("]") { raw.removeLast() }
    return raw.components(separatedBy: ",").map { unquote($0) }.filter { !$0.isEmpty }
}

/// A frontmatter `domains` value: a list, or one comma-separated string (`domainsOf`).
func styleDomainsOf(_ value: JSONValue?) -> [String]? {
    guard let value, value != .null else { return nil }
    let list: [String]
    if case .array(let items) = value {
        list = items.map(keyString)
    } else {
        list = keyString(value).components(separatedBy: ",")
    }
    return list.map(\.jsTrimmed).filter { !$0.isEmpty }
}
