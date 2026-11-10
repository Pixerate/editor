import Foundation

public struct NumberFormatPreset: Sendable, Equatable {
    public var id: String
    public var label: String
    public var code: String

    public init(id: String, label: String, code: String) {
        self.id = id
        self.label = label
        self.code = code
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("id", .string(id)),
            ("label", .string(label)),
            ("code", .string(code))
        ]))
    }
}

/// Presets of the "Format cells" menu (en-US).
public let NUMBER_FORMAT_PRESETS: [NumberFormatPreset] = [
    NumberFormatPreset(id: "general", label: "General", code: "General"),
    NumberFormatPreset(id: "number", label: "Number (0.00)", code: "0.00"),
    NumberFormatPreset(id: "currency", label: "Currency ($1,234.50)", code: "\"$\"#,##0.00"),
    NumberFormatPreset(id: "percent", label: "Percent (12.5%)", code: "0.0%"),
    NumberFormatPreset(id: "date", label: "Date (3/14/2026)", code: "m/d/yyyy"),
    NumberFormatPreset(id: "time", label: "Time (1:30 PM)", code: "h:mm AM/PM")
]

/// Format code for a `CellFormat` kind, used to display numbers in cells that
/// have a kind but no format code: `currency` → `"$"#,##0.00`, `percentage` →
/// `0%`, `date` → `m/d/yyyy`. Other kinds (`number`, `text` — the default of
/// new columns —, `badge`, `status`, `assignee`) display as General (nil).
public func numberFormatForCellFormat(_ format: String?) -> String? {
    switch format {
    case "currency":
        return "\"$\"#,##0.00"
    case "percentage":
        return "0%"
    case "date":
        return "m/d/yyyy"
    default:
        return nil
    }
}

/// `CellFormat` kind matching a format code (`"$"#,##0.00` → `currency`,
/// `0%` → `percentage`, `m/d/yyyy` → `date`, `0.00` → `number`, `@` → `text`);
/// nil for General, times and custom codes.
public func cellFormatForNumberFormat(_ code: String) -> String? {
    switch NumberFormat.parseCached(code).kind() {
    case .number, .fraction, .scientific, .special:
        return "number"
    case .currency, .accounting:
        return "currency"
    case .percentage:
        return "percentage"
    case .date:
        return "date"
    case .text:
        return "text"
    default:
        return nil
    }
}

/// True for an empty or `General` code.
public func isGeneralNumberFormat(_ code: String?) -> Bool {
    guard let code else { return true }
    return NumberFormat.parseCached(code).isGeneral()
}
