// Paint resolution before drawing to a canvas follows Ursula's src/react/export.ts `inlineSvgPaint`,
// and the longest-side bound its `canvasSnapshot`.
import Foundation
import PixerateCore
import PixerateRaster

/// Longest side, in pixels, of a rasterized chart unless `maxSize` says otherwise.
public let CHART_RASTER_MAX_SIZE: Double = 1024

public struct ChartPaintScope: Sendable {
    /// Looks up a custom property (`--name`). Return `""` when unset.
    public var lookup: (@Sendable (String) -> String)?
    /// Stand-in colour for `currentColor` (default `#000000`).
    public var color: String?
    /// Stand-in font family for `font-family="inherit"` (default `sans-serif`).
    public var fontFamily: String?

    public init(
        lookup: (@Sendable (String) -> String)? = nil,
        color: String? = nil,
        fontFamily: String? = nil
    ) {
        self.lookup = lookup
        self.color = color
        self.fontFamily = fontFamily
    }
}

public struct ChartRasterImage: Sendable, Equatable {
    /// Base64 PNG, without the `data:` prefix.
    public var data: String
    public var mimeType: String
    /// Size of the image in pixels.
    public var width: Int
    public var height: Int

    public init(data: String, mimeType: String = "image/png", width: Int, height: Int) {
        self.data = data
        self.mimeType = mimeType
        self.width = width
        self.height = height
    }
}

public struct ChartRasterSize: Sendable, Equatable {
    public var width: Int
    public var height: Int
    public var scale: Double

    public init(width: Int, height: Int, scale: Double) {
        self.width = width
        self.height = height
        self.scale = scale
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("width", .number(Double(width))),
            ("height", .number(Double(height))),
            ("scale", .number(scale)),
        ]))
    }
}

public struct ChartRasterError: Error, LocalizedError, Sendable, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Pixel size of the image for a chart of `width` × `height` CSS pixels: `scale` × the size, longest side ≤ `maxSize`.
public func chartRasterSize(
    _ width: Double,
    _ height: Double,
    scale: Double = 2,
    maxSize: Double = CHART_RASTER_MAX_SIZE
) throws -> ChartRasterSize {
    if !(width > 0) || !(height > 0) {
        throw ChartRasterError("A chart image needs a positive width and height; got \(JSONValue.jsNumber(width)) × \(JSONValue.jsNumber(height)).")
    }
    let factor = Swift.min(scale > 0 ? scale : 1, maxSize / Swift.max(width, height))
    let w = Swift.max(1, Int(JS.round(width * factor)))
    let h = Swift.max(1, Int(JS.round(height * factor)))
    return ChartRasterSize(width: w, height: h, scale: factor)
}

/// Index just past the `)` closing the parenthesis opened at `open`, or -1.
private func closingParen(_ chars: [Character], _ open: Int) -> Int {
    var depth = 0
    var i = open
    while i < chars.count {
        if chars[i] == "(" {
            depth += 1
        } else if chars[i] == ")" {
            depth -= 1
            if depth == 0 {
                return i + 1
            }
        }
        i += 1
    }
    return -1
}

/// Replaces every `var(--name, fallback)` in a CSS value; unset variables without a fallback become `""`.
private func substituteVars(_ value: String, lookup: (String) -> String, depth: Int = 0) -> String {
    let chars = Array(value)
    let target: [Character] = ["v", "a", "r", "("]
    var out = ""
    var i = 0

    func findVar(from start: Int) -> Int {
        guard start + 4 <= chars.count else { return -1 }
        var idx = start
        while idx + 4 <= chars.count {
            if chars[idx] == target[0] && chars[idx + 1] == target[1] && chars[idx + 2] == target[2] && chars[idx + 3] == target[3] {
                return idx
            }
            idx += 1
        }
        return -1
    }

    var at = findVar(from: i)
    while at != -1 {
        let end = closingParen(chars, at + 3)
        if end == -1 { break }
        let innerChars = Array(chars[(at + 4)..<(end - 1)])
        var comma = -1
        var d = 0
        for j in 0..<innerChars.count {
            if innerChars[j] == "(" {
                d += 1
            } else if innerChars[j] == ")" {
                d -= 1
            } else if innerChars[j] == "," && d == 0 {
                comma = j
                break
            }
        }
        let name: String
        let fallback: String
        if comma == -1 {
            name = String(innerChars).jsTrimmed
            fallback = ""
        } else {
            name = String(innerChars[0..<comma]).jsTrimmed
            fallback = String(innerChars[(comma + 1)...]).jsTrimmed
        }
        let found = lookup(name).jsTrimmed
        let resolved = !found.isEmpty ? found : fallback
        let prefix = String(chars[i..<at])
        let replacement = (depth < 8 && resolved.contains("var("))
            ? substituteVars(resolved, lookup: lookup, depth: depth + 1)
            : resolved
        out += prefix + replacement
        i = end
        at = findVar(from: i)
    }
    if i < chars.count {
        out += String(chars[i...])
    }
    return out
}

private let paintAttrRegex = try! NSRegularExpression(pattern: "(\\s)([\\w:-]+)=\"([^\"]*)\"")
private let currentColorRegex = try! NSRegularExpression(pattern: "currentcolor", options: [.caseInsensitive])
private let nonAlnumRegex = try! NSRegularExpression(pattern: "[^\\p{L}\\p{N}]+")

/// Makes a chart SVG drawable on its own: `var(--x, fallback)` becomes the variable's value
/// (or the fallback), `currentColor` becomes the scope's colour and `font-family="inherit"` its font.
/// An attribute left empty is dropped. Text content is left alone.
public func resolveChartSvgPaints(_ svg: String, _ options: ChartPaintScope = ChartPaintScope()) -> String {
    let lookup = options.lookup ?? { _ in "" }
    let ns = svg as NSString
    let matches = paintAttrRegex.matches(in: svg, range: NSRange(location: 0, length: ns.length))
    guard !matches.isEmpty else { return svg }

    var result = ""
    var lastEnd = 0
    for match in matches {
        let matchRange = match.range
        if matchRange.location > lastEnd {
            result += ns.substring(with: NSRange(location: lastEnd, length: matchRange.location - lastEnd))
        }
        let space = ns.substring(with: match.range(at: 1))
        let name = ns.substring(with: match.range(at: 2))
        let raw = ns.substring(with: match.range(at: 3))
        var value = raw

        if value.contains("var(") {
            let unescaped = value.replacingOccurrences(of: "&quot;", with: "\"")
            value = substituteVars(unescaped, lookup: lookup).replacingOccurrences(of: "\"", with: "&quot;")
        }
        if value.range(of: "currentcolor", options: .caseInsensitive) != nil {
            let col = (options.color?.isEmpty == false) ? options.color! : "#000000"
            let valNs = value as NSString
            let escapedTemplate = NSRegularExpression.escapedTemplate(for: col)
            value = currentColorRegex.stringByReplacingMatches(
                in: value,
                range: NSRange(location: 0, length: valNs.length),
                withTemplate: escapedTemplate
            )
        }
        if name == "font-family" {
            let trimmedLower = value.jsTrimmed.lowercased()
            if trimmedLower == "inherit" || trimmedLower == "unset" || trimmedLower == "initial" {
                let ff = (options.fontFamily?.isEmpty == false) ? options.fontFamily! : "sans-serif"
                value = ff.replacingOccurrences(of: "\"", with: "'")
            }
        }
        if value == raw {
            result += ns.substring(with: matchRange)
        } else if !value.jsTrimmed.isEmpty {
            result += "\(space)\(name)=\"\(value)\""
        }
        lastEnd = matchRange.location + matchRange.length
    }
    if lastEnd < ns.length {
        result += ns.substring(with: NSRange(location: lastEnd, length: ns.length - lastEnd))
    }
    return result
}

/// A file name for a chart: its title in lower case with dashes, else `chart`, plus the extension.
public func chartFileName(_ spec: ChartSpec, _ fileExtension: String) -> String {
    return chartFileName(title: spec.title, fileExtension)
}

/// Overload taking a title string directly.
public func chartFileName(title: String, _ fileExtension: String) -> String {
    let lower = title.jsLowercased
    let ns = lower as NSString
    var dashed = nonAlnumRegex.stringByReplacingMatches(
        in: lower,
        range: NSRange(location: 0, length: ns.length),
        withTemplate: "-"
    )
    while dashed.hasPrefix("-") { dashed.removeFirst() }
    while dashed.hasSuffix("-") { dashed.removeLast() }
    let base = dashed.jsSlice(0, 60)
    return "\(base.isEmpty ? "chart" : base).\(fileExtension)"
}
