import Foundation

public struct CsvParseOptions: Sendable, Equatable {
    /// Field separator. Default `","`.
    public var delimiter: String
    /// Only treat a leading `"` as a quote when the quoted field is closed and
    /// followed by a delimiter or line break; otherwise keep it as text. Used for
    /// clipboard TSV, where plain text may legitimately start with a quote.
    public var requireWellFormedQuotes: Bool

    public init(delimiter: String = ",", requireWellFormedQuotes: Bool = false) {
        self.delimiter = delimiter
        self.requireWellFormedQuotes = requireWellFormedQuotes
    }
}

public typealias CsvOptions = CsvParseOptions

public struct CsvSerializeOptions: Sendable, Equatable {
    /// Field separator. Default `","`.
    public var delimiter: String
    /// Record separator. Default `"\r\n"` (RFC 4180).
    public var lineEnding: String
    /// Prefix the output with a UTF-8 byte order mark (helps Excel detect UTF-8).
    public var bom: Bool
    /// Quote every field, not only those that need it.
    public var quoteAll: Bool

    public init(
        delimiter: String = ",",
        lineEnding: String = "\r\n",
        bom: Bool = false,
        quoteAll: Bool = false
    ) {
        self.delimiter = delimiter
        self.lineEnding = lineEnding
        self.bom = bom
        self.quoteAll = quoteAll
    }
}

private let BOM_UNIT: UInt16 = 0xFEFF
private let BOM_STR = "\u{FEFF}"

/// Reads the quoted field opening at `start`. `end` is the index after the
/// closing quote (or the input length when unterminated); `wellFormed` means
/// it was closed and followed by a delimiter, line break or the end of input.
private func readQuoted(
    _ input: [UInt16],
    _ start: Int,
    _ delimiter: UInt16
) -> (value: [UInt16], end: Int, wellFormed: Bool) {
    var value: [UInt16] = []
    var i = start + 1
    let len = input.count
    while i < len {
        if input[i] == 0x0022 { // '"'
            if i + 1 < len && input[i + 1] == 0x0022 {
                value.append(0x0022)
                i += 2
                continue
            }
            let next: UInt16? = (i + 1 < len) ? input[i + 1] : nil
            let wellFormed = next == nil || next == delimiter || next == 0x000D || next == 0x000A
            return (value: value, end: i + 1, wellFormed: wellFormed)
        }
        value.append(input[i])
        i += 1
    }
    return (value: value, end: i, wellFormed: false)
}

public func parseCsv(_ text: String, options: CsvParseOptions = CsvParseOptions()) -> [[String]] {
    let delimiterUnits = Array(options.delimiter.utf16)
    let delimiter: UInt16 = delimiterUnits.first ?? 0x002C
    var input = Array(text.utf16)
    if input.first == BOM_UNIT {
        input.removeFirst()
    }

    var records: [[String]] = []
    var record: [String] = []
    var field: [UInt16] = []
    var i = 0
    let len = input.count
    var recordStarted = false

    func endField() {
        record.append(String(utf16CodeUnits: field, count: field.count))
        field.removeAll(keepingCapacity: true)
    }

    func endRecord() {
        endField()
        records.append(record)
        record = []
        recordStarted = false
    }

    var atFieldStart = true

    while i < len {
        let char = input[i]

        if char == 0x0022 && atFieldStart {
            let quoted = readQuoted(input, i, delimiter)
            if quoted.wellFormed || !options.requireWellFormedQuotes {
                recordStarted = true
                atFieldStart = false
                field.append(contentsOf: quoted.value)
                i = quoted.end
                continue
            }
        }

        if char == delimiter {
            recordStarted = true
            endField()
            atFieldStart = true
            i += 1
            continue
        }

        if char == 0x000D || char == 0x000A {
            endRecord()
            atFieldStart = true
            if char == 0x000D && i + 1 < len && input[i + 1] == 0x000A {
                i += 2
            } else {
                i += 1
            }
            continue
        }

        recordStarted = true
        atFieldStart = false
        field.append(char)
        i += 1
    }

    if recordStarted || !field.isEmpty || !record.isEmpty {
        endRecord()
    }
    return records
}

/// Quotes `value` when it contains the delimiter, a quote or a line break.
public func escapeCsvField(_ value: String, delimiter: String = ",", quoteAll: Bool = false) -> String {
    if quoteAll || value.jsIncludes(delimiter) || value.jsIncludes("\"") || value.jsIncludes("\r") || value.jsIncludes("\n") {
        return "\"\(value.jsReplacingAll("\"", with: "\"\""))\""
    }
    return value
}

public func serializeCsv(_ rows: [[String?]], options: CsvSerializeOptions = CsvSerializeOptions()) -> String {
    let delimiter = options.delimiter
    let lineEnding = options.lineEnding
    let body = rows
        .map { row in
            row.map { value in
                escapeCsvField(value ?? "", delimiter: delimiter, quoteAll: options.quoteAll)
            }.joined(separator: delimiter)
        }
        .joined(separator: lineEnding)
    return options.bom ? BOM_STR + body : body
}

public func serializeCsv(_ rows: [[String]], options: CsvSerializeOptions = CsvSerializeOptions()) -> String {
    let delimiter = options.delimiter
    let lineEnding = options.lineEnding
    let body = rows
        .map { row in
            row.map { value in
                escapeCsvField(value, delimiter: delimiter, quoteAll: options.quoteAll)
            }.joined(separator: delimiter)
        }
        .joined(separator: lineEnding)
    return options.bom ? BOM_STR + body : body
}

public func serializeCsv(_ rows: [[String?]], delimiter: String) -> String {
    serializeCsv(rows, options: CsvSerializeOptions(delimiter: delimiter))
}

public func serializeCsv(_ rows: [[String]], delimiter: String) -> String {
    serializeCsv(rows, options: CsvSerializeOptions(delimiter: delimiter))
}

public func parseTsv(_ text: String) -> [[String]] {
    let normalized = text.hasPrefix(BOM_STR) ? String(text.dropFirst()) : text
    if !normalized.contains("\"") {
        var body = normalized
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        if body.hasSuffix("\n") {
            body.removeLast()
        }
        if body.isEmpty { return [] }
        return body.components(separatedBy: "\n").map { $0.components(separatedBy: "\t") }
    }
    return parseCsv(normalized, options: CsvParseOptions(delimiter: "\t", requireWellFormedQuotes: true))
}

public func serializeTsv(_ rows: [[String?]]) -> String {
    rows
        .map { row in
            row.map { value in
                let text = value ?? ""
                if text.jsIncludes("\t") || text.jsIncludes("\r") || text.jsIncludes("\n") || text.jsStartsWith("\"") {
                    return "\"\(text.jsReplacingAll("\"", with: "\"\""))\""
                }
                return text
            }.joined(separator: "\t")
        }
        .joined(separator: "\n")
}

public func serializeTsv(_ rows: [[String]]) -> String {
    rows
        .map { row in
            row.map { text in
                if text.jsIncludes("\t") || text.jsIncludes("\r") || text.jsIncludes("\n") || text.jsStartsWith("\"") {
                    return "\"\(text.jsReplacingAll("\"", with: "\"\""))\""
                }
                return text
            }.joined(separator: "\t")
        }
        .joined(separator: "\n")
}
