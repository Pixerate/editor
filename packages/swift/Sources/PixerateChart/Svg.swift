// `<title>` and `<desc>` on exported SVG follow vectorcraft-main/crates/svg/src/export.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore

/// SVG `dominant-baseline` for a text mark's baseline (shared by every renderer).
public func chartTextBaseline(_ baseline: ChartTextBaseline) -> String {
    switch baseline {
    case .top: return "hanging"
    case .middle: return "central"
    case .bottom: return "text-after-edge"
    }
}

/// SVG `transform` for a rotated text mark, if any.
public func chartTextTransform(_ mark: ChartTextMark) -> String? {
    guard let rotate = mark.rotate, rotate != 0 else { return nil }
    return "rotate(\(JSONValue.jsNumber(rotate)) \(JSONValue.jsNumber(mark.x)) \(JSONValue.jsNumber(mark.y)))"
}

private func escapeSvg(_ text: String) -> String {
    var out = ""
    out.reserveCapacity(text.utf8.count)
    for ch in text {
        switch ch {
        case "&": out.append("&amp;")
        case "<": out.append("&lt;")
        case ">": out.append("&gt;")
        case "\"": out.append("&quot;")
        default: out.append(ch)
        }
    }
    return out
}

private struct MarkParts {
    var tag: String
    var orderedAttrs: [(String, String)]
    var text: String?

    var attrsDict: [String: String] {
        var d: [String: String] = [:]
        for (k, v) in orderedAttrs { d[k] = v }
        return d
    }

    var attrsJSON: JSONObject {
        var obj = JSONObject()
        for (k, v) in orderedAttrs {
            obj[k] = .string(v)
        }
        return obj
    }
}

private enum AttrVal {
    case str(String?)
    case num(Double?)
}

/// A mark as an SVG tag name, its attributes (unset ones dropped) and its text.
private func markParts(_ mark: ChartMark, _ fontFamily: String) -> MarkParts {
    func build(_ tag: String, _ pairs: [(String, AttrVal)], text: String? = nil) -> MarkParts {
        var ordered: [(String, String)] = []
        ordered.reserveCapacity(pairs.count + 2)
        for (k, val) in pairs {
            switch val {
            case .str(let s):
                if let s, !s.isEmpty {
                    ordered.append((k, s))
                }
            case .num(let n):
                if let n {
                    let s = JSONValue.jsNumber(n)
                    if !s.isEmpty {
                        ordered.append((k, s))
                    }
                }
            }
        }
        return MarkParts(tag: tag, orderedAttrs: ordered, text: text)
    }

    switch mark {
    case .rect(let m):
        return build("rect", [
            ("x", .num(m.x)),
            ("y", .num(m.y)),
            ("width", .num(m.width)),
            ("height", .num(m.height)),
            ("rx", .num(m.radius)),
            ("fill", .str(m.fill)),
            ("stroke", .str(m.stroke)),
            ("stroke-width", .num(m.strokeWidth)),
            ("opacity", .num(m.opacity)),
            ("data-role", .str(m.role.rawValue)),
        ])
    case .path(let m):
        return build("path", [
            ("d", .str(m.d)),
            ("fill", .str(m.fill ?? "none")),
            ("stroke", .str(m.stroke)),
            ("stroke-width", .num(m.strokeWidth)),
            ("stroke-dasharray", .str(m.dash)),
            ("stroke-linejoin", .str("round")),
            ("stroke-linecap", .str("round")),
            ("opacity", .num(m.opacity)),
            ("data-role", .str(m.role.rawValue)),
        ])
    case .circle(let m):
        return build("circle", [
            ("cx", .num(m.cx)),
            ("cy", .num(m.cy)),
            ("r", .num(m.r)),
            ("fill", .str(m.fill)),
            ("stroke", .str(m.stroke)),
            ("stroke-width", .num(m.strokeWidth)),
            ("opacity", .num(m.opacity)),
            ("data-role", .str(m.role.rawValue)),
        ])
    case .line(let m):
        return build("line", [
            ("x1", .num(m.x1)),
            ("y1", .num(m.y1)),
            ("x2", .num(m.x2)),
            ("y2", .num(m.y2)),
            ("stroke", .str(m.stroke)),
            ("stroke-width", .num(m.strokeWidth)),
            ("stroke-dasharray", .str(m.dash)),
            ("opacity", .num(m.opacity)),
            ("data-role", .str(m.role.rawValue)),
        ])
    case .text(let m):
        return build("text", [
            ("x", .num(m.x)),
            ("y", .num(m.y)),
            ("text-anchor", .str(m.anchor.rawValue)),
            ("dominant-baseline", .str(chartTextBaseline(m.baseline))),
            ("font-size", .num(m.size)),
            ("font-weight", .num(m.weight.map { Double($0) })),
            ("font-family", .str(fontFamily)),
            ("fill", .str(m.fill)),
            ("transform", .str(chartTextTransform(m))),
            ("opacity", .num(m.opacity)),
            ("data-role", .str(m.role.rawValue)),
        ], text: m.text)
    }
}

private func markToSvg(_ mark: ChartMark, _ fontFamily: String) -> String {
    let parts = markParts(mark, fontFamily)
    var attrText = ""
    for (k, v) in parts.orderedAttrs {
        attrText += " \(k)=\"\(escapeSvg(v))\""
    }
    if let text = parts.text {
        return "<\(parts.tag)\(attrText)>\(escapeSvg(text))</\(parts.tag)>"
    } else {
        return "<\(parts.tag)\(attrText)/>"
    }
}

public struct ChartSvgOptions: Sendable, Equatable {
    /// Leave out selection outlines (default `true`: exports show the chart only).
    public var hideSelection: Bool?
    /// Accessible title (default: the chart title).
    public var ariaLabel: String?
    /// A longer description written as `<desc>` (`chartToSvg` defaults to `describeChart`).
    public var description: String?

    public init(
        hideSelection: Bool? = nil,
        ariaLabel: String? = nil,
        description: String? = nil
    ) {
        self.hideSelection = hideSelection
        self.ariaLabel = ariaLabel
        self.description = description
    }
}

/// Writes a laid-out scene as a standalone SVG document string.
public func chartSceneToSvg(_ scene: ChartScene, _ options: ChartSvgOptions = ChartSvgOptions()) -> String {
    let hide = options.hideSelection ?? true
    let font = scene.theme.fontFamily
    let body = scene.marks
        .filter { !(hide && $0.role == .selection) }
        .map { markToSvg($0, font) }
        .joined()
    let label = (options.ariaLabel?.isEmpty == false) ? options.ariaLabel : nil
    let desc = (options.description?.isEmpty == false) ? options.description : nil
    var labelledParts: [String] = []
    if label != nil { labelledParts.append("chart-title") }
    if desc != nil { labelledParts.append("chart-desc") }
    let labelled = labelledParts.joined(separator: " ")
    let titleXml = label.map { "<title id=\"chart-title\">\(escapeSvg($0))</title>" } ?? ""
    let descXml = desc.map { "<desc id=\"chart-desc\">\(escapeSvg($0))</desc>" } ?? ""
    let head = "\(titleXml)\(descXml)"
    let wStr = JSONValue.jsNumber(scene.width)
    let hStr = JSONValue.jsNumber(scene.height)
    let ariaLabelAttr = label.map { " aria-label=\"\(escapeSvg($0))\"" } ?? ""
    let ariaLabelledByAttr = !labelled.isEmpty ? " aria-labelledby=\"\(labelled)\"" : ""
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(wStr)\" height=\"\(hStr)\" viewBox=\"0 0 \(wStr) \(hStr)\" role=\"img\"\(ariaLabelAttr)\(ariaLabelledByAttr)>\(head)\(body)</svg>"
}

/// Lays out and writes a chart as SVG, e.g. for export or server rendering.
public func chartToSvg(
    _ spec: ChartSpec,
    width: Double,
    height: Double,
    theme: ChartThemePatch? = nil,
    measureText: ChartTextMeasure? = nil,
    emptyMessage: String? = nil,
    valueDomain: ChartDomainBounds? = nil,
    valueDomain2: ChartDomainBounds? = nil,
    xDomain: ChartDomainBounds? = nil,
    readout: ChartPointReadout? = nil,
    raceFrame: Double? = nil,
    hideSelection: Bool? = nil,
    ariaLabel: String? = nil,
    description: String? = nil
) -> String {
    let layoutOpts = ChartLayoutOptions(
        width: width,
        height: height,
        theme: theme,
        selection: nil,
        measureText: measureText,
        emptyMessage: emptyMessage,
        valueDomain: valueDomain,
        valueDomain2: valueDomain2,
        xDomain: xDomain,
        readout: readout,
        raceFrame: raceFrame
    )
    let scene = layoutChart(spec, layoutOpts)
    let svgOpts = ChartSvgOptions(
        hideSelection: hideSelection,
        ariaLabel: ariaLabel ?? (spec.title.isEmpty ? nil : spec.title),
        description: description ?? describeChart(spec)
    )
    return chartSceneToSvg(scene, svgOpts)
}

private let svgNamespace = "http://www.w3.org/2000/svg"

public enum ChartDomChild: Sendable, Equatable {
    case element(ChartDomSpec)
    case text(String)

    public func toJSON() -> JSONValue {
        switch self {
        case .element(let spec):
            return spec.toJSON()
        case .text(let s):
            return .string(s)
        }
    }
}

/// A ProseMirror / TipTap `DOMOutputSpec` representation (`[tag, attrs, ...children]`).
public struct ChartDomSpec: Sendable, Equatable {
    public var tag: String
    public var attrs: [String: String]
    public var children: [ChartDomChild]
    internal var orderedAttrs: [(String, String)]

    public init(tag: String, attrs: [String: String] = [:], children: [ChartDomChild] = []) {
        self.tag = tag
        self.attrs = attrs
        self.children = children
        self.orderedAttrs = attrs.map { ($0.key, $0.value) }
    }

    internal init(tag: String, orderedAttrs: [(String, String)], children: [ChartDomChild] = []) {
        self.tag = tag
        var dict: [String: String] = [:]
        var deduped: [(String, String)] = []
        var indexByKey: [String: Int] = [:]
        for (k, v) in orderedAttrs {
            dict[k] = v
            if let existingIdx = indexByKey[k] {
                deduped[existingIdx] = (k, v)
            } else {
                indexByKey[k] = deduped.count
                deduped.append((k, v))
            }
        }
        self.attrs = dict
        self.orderedAttrs = deduped
        self.children = children
    }

    public static func == (lhs: ChartDomSpec, rhs: ChartDomSpec) -> Bool {
        lhs.tag == rhs.tag && lhs.attrs == rhs.attrs && lhs.children == rhs.children
    }

    public func toJSON() -> JSONValue {
        var attrObj = JSONObject()
        for (k, v) in orderedAttrs {
            attrObj[k] = .string(v)
        }
        for (k, v) in attrs where attrObj[k] == nil {
            attrObj[k] = .string(v)
        }
        var arr: [JSONValue] = [.string(tag), .object(attrObj)]
        arr.append(contentsOf: children.map { $0.toJSON() })
        return .array(arr)
    }
}

/// Writes a laid-out scene as a ProseMirror `DOMOutputSpec` (SVG-namespaced tags).
public func chartSceneToDomSpec(
    _ scene: ChartScene,
    _ options: ChartSvgOptions = ChartSvgOptions(),
    attrs extraAttrs: [(String, String)] = []
) -> ChartDomSpec {
    let hide = options.hideSelection ?? true
    let font = scene.theme.fontFamily
    func nsTag(_ name: String) -> String { "\(svgNamespace) \(name)" }
    var children: [ChartDomChild] = []
    if let ariaLabel = options.ariaLabel, !ariaLabel.isEmpty {
        children.append(.element(ChartDomSpec(tag: nsTag("title"), orderedAttrs: [], children: [.text(ariaLabel)])))
    }
    if let description = options.description, !description.isEmpty {
        children.append(.element(ChartDomSpec(tag: nsTag("desc"), orderedAttrs: [], children: [.text(description)])))
    }
    for mark in scene.marks {
        if hide && mark.role == .selection { continue }
        let parts = markParts(mark, font)
        let markChildren: [ChartDomChild] = parts.text.map { [.text($0)] } ?? []
        children.append(.element(ChartDomSpec(tag: nsTag(parts.tag), orderedAttrs: parts.orderedAttrs, children: markChildren)))
    }
    let wStr = JSONValue.jsNumber(scene.width)
    let hStr = JSONValue.jsNumber(scene.height)
    var rootAttrs: [(String, String)] = [
        ("width", wStr),
        ("height", hStr),
        ("viewBox", "0 0 \(wStr) \(hStr)"),
        ("role", "img"),
    ]
    if let ariaLabel = options.ariaLabel, !ariaLabel.isEmpty {
        rootAttrs.append(("aria-label", ariaLabel))
    }
    rootAttrs.append(contentsOf: extraAttrs)
    return ChartDomSpec(tag: nsTag("svg"), orderedAttrs: rootAttrs, children: children)
}
