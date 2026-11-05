import Foundation

/*
 Keyboard chords in a platform-neutral notation, a port of the parsing and formatting half of
 `commands/chords.ts` (keyboard event matching is not ported).

 | token | macOS | Windows / Linux |
 |---|---|---|
 | `Mod` | ⌘ Command | Ctrl |
 | `Ctrl` | ⌃ Control | Ctrl |
 | `Meta` / `Cmd` | ⌘ Command | Win / Super |
 | `Alt` / `Option` | ⌥ Option | Alt |
 | `Shift` | ⇧ Shift | Shift |

 Keys are stored as `KeyboardEvent.code` values (`KeyZ`, `Digit1`, `BracketRight`, `PageDown`).
 */

public enum ShortcutPlatform: String, CaseIterable, Sendable {
    case mac, windows, linux
}

/// A parsed chord. `mod` is the platform's primary modifier.
public struct Chord: Equatable, Sendable {
    /// `KeyboardEvent.code` of the key, e.g. `KeyZ`.
    public var key: String
    public var mod = false
    public var ctrl = false
    public var meta = false
    public var alt = false
    public var shift = false

    public init(key: String, mod: Bool = false, ctrl: Bool = false, meta: Bool = false, alt: Bool = false, shift: Bool = false) {
        self.key = key
        self.mod = mod
        self.ctrl = ctrl
        self.meta = meta
        self.alt = alt
        self.shift = shift
    }
}

/// Why chord text did not parse (the message `parseChord` throws in TS).
public struct ChordError: Error, LocalizedError, Equatable, Sendable {
    public var message: String
    public var errorDescription: String? { message }
}

// Characters and names → `KeyboardEvent.code`.
private let namedKeys: [String: String] = [
    "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "plus": "Equal", ",": "Comma", ".": "Period",
    "/": "Slash", "\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote",
    "enter": "Enter", "return": "Enter", "↩": "Enter", "escape": "Escape", "esc": "Escape", "⎋": "Escape",
    "space": "Space", "spacebar": "Space", " ": "Space", "tab": "Tab", "⇥": "Tab",
    "backspace": "Backspace", "⌫": "Backspace", "delete": "Delete", "del": "Delete", "⌦": "Delete",
    "insert": "Insert", "home": "Home", "end": "End", "pageup": "PageUp", "pgup": "PageUp", "pagedown": "PageDown", "pgdn": "PageDown",
    "up": "ArrowUp", "arrowup": "ArrowUp", "↑": "ArrowUp", "down": "ArrowDown", "arrowdown": "ArrowDown", "↓": "ArrowDown",
    "left": "ArrowLeft", "arrowleft": "ArrowLeft", "←": "ArrowLeft", "right": "ArrowRight", "arrowright": "ArrowRight", "→": "ArrowRight",
    "bracketleft": "BracketLeft", "bracketright": "BracketRight", "minus": "Minus", "equal": "Equal", "comma": "Comma",
    "period": "Period", "slash": "Slash", "backslash": "Backslash", "semicolon": "Semicolon", "quote": "Quote", "backquote": "Backquote",
]

private let codeText: [String: String] = [
    "BracketLeft": "[", "BracketRight": "]", "Minus": "-", "Equal": "=", "Comma": ",", "Period": ".", "Slash": "/",
    "Backslash": "\\", "Semicolon": ";", "Quote": "'", "Backquote": "`",
    "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right",
]

private let macKeyGlyphs: [String: String] = [
    "Backspace": "⌫", "Delete": "⌦", "Enter": "↩", "Escape": "⎋", "Tab": "⇥",
    "ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "PageUp": "Page Up", "PageDown": "Page Down", "Space": "Space",
]

private let knownCodes = Set(namedKeys.values).union(["Enter", "Escape", "Space", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown"])

private let glyphModifiers: [Unicode.Scalar: String] = ["⌘": "Meta+", "⌃": "Ctrl+", "⌥": "Alt+", "⇧": "Shift+"]

// Code-unit comparisons: JS compares strings unit by unit, Swift by canonical equivalence.
private func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
private func lookup(_ table: [String: String], _ key: String) -> String? {
    table.first(where: { same($0.key, key) })?.value
}
private func isASCIILetter(_ u: UInt8) -> Bool { (65 ... 90).contains(u) || (97 ... 122).contains(u) }
private func isASCIIDigit(_ u: UInt8) -> Bool { (48 ... 57).contains(u) }
private func isWordByte(_ u: UInt8) -> Bool { isASCIILetter(u) || isASCIIDigit(u) || u == 95 }

/// `KeyboardEvent.code` for a key token (`Z`, `1`, `]`, `PageDown`, `F5`, `KeyZ`), or `nil`.
public func keyToCode(_ token: String) -> String? {
    if token.isEmpty { return nil }
    let b = Array(token.utf8)
    if b.count == 1 && isASCIILetter(b[0]) { return "Key\(token.uppercased())" }
    if b.count == 1 && isASCIIDigit(b[0]) { return "Digit\(token)" }
    if (b[0] == 70 || b[0] == 102) && (b.count == 2 || b.count == 3) && b.dropFirst().allSatisfy(isASCIIDigit) {
        // /^f([1-9]|1[0-9]|2[0-4])$/i
        let d = Array(b.dropFirst())
        if d.count == 1 ? d[0] != 48 : d[0] == 49 || (d[0] == 50 && d[1] <= 52) { return token.uppercased() }
    }
    if b.count == 4 && token.hasPrefix("Key") && (65 ... 90).contains(b[3]) { return token }
    if b.count == 6 && token.hasPrefix("Digit") && isASCIIDigit(b[5]) { return token }
    if b.count > 6 && token.hasPrefix("Numpad") && b.dropFirst(6).allSatisfy(isWordByte) { return token }
    if knownCodes.contains(where: { same($0, token) }) { return token }
    if let v = lookup(namedKeys, token) { return v }
    let squeezed = String(String.UnicodeScalarView(token.jsLowercased.unicodeScalars.filter { !isJSWhitespace($0) && $0 != "_" }))
    return lookup(namedKeys, squeezed)
}

/// Neutral text for a code: `KeyZ` → `Z`, `BracketRight` → `]`, `ArrowUp` → `Up`.
public func codeToKeyText(_ code: String) -> String {
    let b = Array(code.utf8)
    if b.count == 4 && code.hasPrefix("Key") && (65 ... 90).contains(b[3]) { return String(code.dropFirst(3)) }
    if b.count == 6 && code.hasPrefix("Digit") && isASCIIDigit(b[5]) { return String(code.dropFirst(5)) }
    return lookup(codeText, code) ?? code
}

/**
 Parses chord text (`Mod+Shift+Z`, `Alt+]`, `⌥⇧⌘K`, `CmdOrCtrl+K`). Throws a `ChordError` on
 unknown modifiers or keys. The last `+`-separated token is the key (`Plus` names `+`).
 */
public func parseChord(_ text: String) throws -> Chord {
    let source = text.jsTrimmed
    if source.isEmpty { throw ChordError(message: "Empty shortcut.") }
    var expanded = ""
    for s in source.unicodeScalars { expanded += glyphModifiers[s] ?? String(s) }
    let parts = expanded.split(separator: "+", omittingEmptySubsequences: false).map { String($0).jsTrimmed }.filter { !$0.isEmpty }
    if parts.isEmpty { throw ChordError(message: "\"\(text)\" has no key.") }
    var chord = Chord(key: "")
    for (index, part) in parts.enumerated() {
        let low = part.jsLowercased
        switch low {
        case "mod", "cmdorctrl", "commandorcontrol", "primary": chord.mod = true
        case "ctrl", "control", "ctl": chord.ctrl = true
        case "meta", "cmd", "command", "super", "win": chord.meta = true
        case "alt", "option", "opt": chord.alt = true
        case "shift": chord.shift = true
        default:
            guard index == parts.count - 1 else { throw ChordError(message: "Unknown modifier \"\(part)\" in shortcut \"\(text)\".") }
            guard let code = keyToCode(part) else { throw ChordError(message: "Unknown key \"\(part)\" in shortcut \"\(text)\".") }
            chord.key = code
        }
    }
    if chord.key.isEmpty { throw ChordError(message: "\"\(text)\" has no key.") }
    return chord
}

/// Canonical platform-neutral text: `Mod+Ctrl+Meta+Alt+Shift+<key>`.
public func chordToString(_ chord: Chord) -> String {
    var parts: [String] = []
    if chord.mod { parts.append("Mod") }
    if chord.ctrl { parts.append("Ctrl") }
    if chord.meta { parts.append("Meta") }
    if chord.alt { parts.append("Alt") }
    if chord.shift { parts.append("Shift") }
    parts.append(codeToKeyText(chord.key))
    return parts.joined(separator: "+")
}

/// Canonical spelling of chord text (`shift+cmdorctrl+z` → `Mod+Shift+Z`). Throws when invalid.
public func normalizeChord(_ text: String) throws -> String { chordToString(try parseChord(text)) }

/**
 Display text: `⌥⇧⌘K` on macOS, `Ctrl+Alt+Shift+K` on Windows / Linux (`Meta` shows as `Win` /
 `Super`). Invalid text is returned unchanged.
 */
public func formatShortcut(_ text: String, platform: ShortcutPlatform = .mac) -> String {
    guard let c = try? parseChord(text) else { return text }
    return formatShortcut(c, platform: platform)
}

public func formatShortcut(_ c: Chord, platform: ShortcutPlatform = .mac) -> String {
    let mac = platform == .mac
    let ctrl = c.ctrl || (!mac && c.mod)
    let meta = c.meta || (mac && c.mod)
    if mac {
        let mods = (ctrl ? "⌃" : "") + (c.alt ? "⌥" : "") + (c.shift ? "⇧" : "") + (meta ? "⌘" : "")
        return mods + (macKeyGlyphs[c.key] ?? codeToKeyText(c.key))
    }
    var parts: [String] = []
    if ctrl { parts.append("Ctrl") }
    if meta { parts.append(platform == .windows ? "Win" : "Super") }
    if c.alt { parts.append("Alt") }
    if c.shift { parts.append("Shift") }
    parts.append(c.key == "PageUp" ? "Page Up" : c.key == "PageDown" ? "Page Down" : codeToKeyText(c.key))
    return parts.joined(separator: "+")
}

/// A command's shortcut declaration (`shortcut` in TS): chord text, optionally only on some
/// platforms or in its own scope. A string literal is a plain chord.
public struct CommandShortcut: Equatable, Sendable, ExpressibleByStringLiteral {
    /// Chord text, e.g. `Mod+Shift+Z`.
    public var chord: String
    /// Scope of the binding (default: the command's).
    public var scope: String?
    /// Platforms the binding exists on (default: all). E.g. `Mod+Y` redo only off macOS.
    public var platforms: [ShortcutPlatform]?

    public init(_ chord: String, scope: String? = nil, platforms: [ShortcutPlatform]? = nil) {
        self.chord = chord
        self.scope = scope
        self.platforms = platforms
    }

    public init(stringLiteral value: String) { self.init(value) }
}
