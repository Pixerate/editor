// Types for the format-command manifest shared with the Pixerate editor
// (`@pixerate/markdown-conformance`). The data itself is generated into
// `FormatManifest.generated.swift` by `scripts/generate_format_manifest.mjs`; the Format menu,
// bubble menu and keyboard shortcuts read it from here. Foundation only.

import Foundation

/// Where a command is offered. The generator fails on a surface not listed here.
public enum FormatSurface: String, Hashable, Sendable {
    case bubble
    case menu
    case palette
    case keyboardBar
}

/// When a command is enabled. Each condition is implemented once, in
/// `MarkdownFormatting.satisfies(_:selection:)`; the generator fails on a condition not listed here.
public enum FormatCondition: String, Hashable, Sendable {
    case notInCode
    case inTable
    case hasSelection
}

/// A command parameter value from the manifest or a fixture.
public enum FormatParamValue: Hashable, CustomStringConvertible, Sendable {
    case int(Int)
    case string(String)
    case bool(Bool)
    case null

    public var description: String {
        switch self {
        case .int(let value): return String(value)
        case .string(let value): return value
        case .bool(let value): return String(value)
        case .null: return "null"
        }
    }

    /// The string value, or nil for `null` (and non-strings).
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

/// A keyboard chord from the manifest (`Mod+Shift+8`): `Mod` is ⌘ and `Alt` is ⌥.
public struct FormatShortcut: Hashable, Sendable {
    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let command = Modifiers(rawValue: 1 << 0)
        public static let shift = Modifiers(rawValue: 1 << 1)
        public static let option = Modifiers(rawValue: 1 << 2)
        public static let control = Modifiers(rawValue: 1 << 3)
    }

    /// The unshifted key, lowercased (`8`, `.`, `b`).
    public let key: Character
    public let modifiers: Modifiers
    /// The chord as written in the manifest.
    public let chord: String

    public init(key: Character, modifiers: Modifiers, chord: String) {
        self.key = key
        self.modifiers = modifiers
        self.chord = chord
    }

    /// Letters are matched by character, so they follow the keyboard layout; digits and
    /// punctuation are matched by key code, because Shift changes the character they type.
    public var keyCode: UInt16? { key.isLetter ? nil : Self.keyCodes[key] }

    /// ANSI virtual key codes (`kVK_ANSI_*`) for the digit and punctuation keys.
    public static let keyCodes: [Character: UInt16] = [
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
    ]

    /// The chord with macOS modifier symbols, in the standard order (⌃⌥⇧⌘).
    public var displayString: String {
        var result = ""
        if modifiers.contains(.control) { result += "⌃" }
        if modifiers.contains(.option) { result += "⌥" }
        if modifiers.contains(.shift) { result += "⇧" }
        if modifiers.contains(.command) { result += "⌘" }
        return result + String(key).uppercased()
    }

    /// Whether a key press matches: the same modifiers, and the same key (by character for
    /// letters, by key code for digits and punctuation).
    public func matches(charactersIgnoringModifiers characters: String?, keyCode: UInt16, modifiers pressed: Modifiers) -> Bool {
        guard pressed == modifiers else { return false }
        if let code = self.keyCode { return code == keyCode }
        return characters?.lowercased() == String(key)
    }
}

/// A parameterised form of a command with its own shortcut (`format.heading` with `level=1`).
public struct FormatCommandVariant: Sendable {
    public let params: [String: FormatParamValue]
    public let label: String
    public let shortcut: FormatShortcut

    public init(params: [String: FormatParamValue], label: String, shortcut: FormatShortcut) {
        self.params = params
        self.label = label
        self.shortcut = shortcut
    }
}

/// One command from the manifest.
public struct FormatCommandDefinition: Sendable {
    public let id: String
    public let label: String
    public let group: String
    public let surfaces: Set<FormatSurface>
    public let enabledWhen: [FormatCondition]
    public let shortcut: FormatShortcut?
    public let variants: [FormatCommandVariant]

    public init(id: String, label: String, group: String, surfaces: Set<FormatSurface>, enabledWhen: [FormatCondition], shortcut: FormatShortcut?, variants: [FormatCommandVariant]) {
        self.id = id
        self.label = label
        self.group = group
        self.surfaces = surfaces
        self.enabledWhen = enabledWhen
        self.shortcut = shortcut
        self.variants = variants
    }
}

/// A code-block language from the manifest.
public struct ManifestCodeLanguage: Hashable, Sendable {
    public let id: String
    public let label: String
    public let shortLabel: String?

    public init(id: String, label: String, shortLabel: String?) {
        self.id = id
        self.label = label
        self.shortLabel = shortLabel
    }

    /// The compact label for the bubble menu.
    public var compactLabel: String { shortLabel ?? label }
}

/// A command as offered on a surface: a concrete `FormatCommand` with its label and shortcut.
public struct FormatMenuEntry: Sendable {
    public let command: FormatCommand
    public let label: String
    public let group: String
    public let shortcut: FormatShortcut?

    public init(command: FormatCommand, label: String, group: String, shortcut: FormatShortcut?) {
        self.command = command
        self.label = label
        self.group = group
        self.shortcut = shortcut
    }
}

extension FormatManifest {
    public static func definition(_ id: String) -> FormatCommandDefinition? {
        commands.first { $0.id == id }
    }

    /// The commands offered on `surface`, in manifest order. Parameterised commands are listed
    /// once per variant (Heading 1–3), plus the plain command when it needs no parameters.
    public static func entries(for surface: FormatSurface) -> [FormatMenuEntry] {
        commands.filter { $0.surfaces.contains(surface) }.flatMap { definition -> [FormatMenuEntry] in
            var result = definition.variants.compactMap { variant -> FormatMenuEntry? in
                FormatCommand(manifestID: definition.id, params: variant.params).map {
                    FormatMenuEntry(command: $0, label: variant.label, group: definition.group, shortcut: variant.shortcut)
                }
            }
            if let command = FormatCommand(manifestID: definition.id) {
                result.append(FormatMenuEntry(command: command, label: definition.label, group: definition.group, shortcut: definition.shortcut))
            }
            return result
        }
    }

    /// Every command that has a keyboard shortcut.
    public static let shortcutBindings: [(command: FormatCommand, shortcut: FormatShortcut)] = commands.flatMap { definition in
        var result: [(FormatCommand, FormatShortcut)] = definition.variants.compactMap { variant in
            FormatCommand(manifestID: definition.id, params: variant.params).map { ($0, variant.shortcut) }
        }
        if let shortcut = definition.shortcut, let command = FormatCommand(manifestID: definition.id) {
            result.append((command, shortcut))
        }
        return result
    }

    /// The command bound to a key press, if any.
    public static func command(charactersIgnoringModifiers characters: String?, keyCode: UInt16, modifiers: FormatShortcut.Modifiers) -> FormatCommand? {
        shortcutBindings.first { $0.shortcut.matches(charactersIgnoringModifiers: characters, keyCode: keyCode, modifiers: modifiers) }?.command
    }
}

// MARK: - Conditions

extension MarkdownFormatting {
    /// Whether `condition` holds for the selection (raw-Markdown UTF-16 offsets).
    public func satisfies(_ condition: FormatCondition, selection: NSRange) -> Bool {
        switch condition {
        case .notInCode:
            return codeSpan(containing: selection) == nil && codeBlock(containing: selection) == nil
        case .inTable:
            return isInTable(selection)
        case .hasSelection:
            return selection.length > 0
        }
    }

    /// Whether every `enabledWhen` condition of the command holds. Swash-only commands are always enabled.
    public func isEnabled(_ command: FormatCommand, selection: NSRange) -> Bool {
        (command.definition?.enabledWhen ?? []).allSatisfy { satisfies($0, selection: selection) }
    }
}
