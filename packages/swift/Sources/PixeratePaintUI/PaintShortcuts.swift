import Foundation
import PixerateCore
import PixeratePaint

/**
 * The keyboard command a key press runs, if any (`paintShortcutFor` in `paint-editor/ui.ts`), from
 * the contract's commands (`PaintContracts.commands()`). `Mod` is Command on Apple platforms;
 * letters match case-insensitively and named keys are written as `Escape`.
 */
public func paintShortcutFor(_ commands: [ShortcutCommand], key: String, mod: Bool = false, shift: Bool = false) -> ShortcutCommand? {
    if key.isEmpty { return nil }
    var parts: [String] = mod ? ["Mod"] : []
    if shift && mod { parts.append("Shift") }
    let name = key.count == 1 ? key.uppercased() : key.prefix(1).uppercased() + key.dropFirst().lowercased()
    let combo = (parts + [name]).joined(separator: "+")
    return commands.first { $0.keys.contains(combo) }
}
