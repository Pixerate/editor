import Foundation
import PixerateCore

/**
 * Office Open XML package reader (`.xlsx`, `.pptx`, `.docx`) for finding and reading
 * embedded chart parts (`chart/office-files.ts`).
 */

public enum OfficeChartFileFormat: String, Sendable, Equatable {
    case xlsx
    case pptx
    case docx
}

public enum OfficeChartPartKind: String, Sendable, Equatable {
    case chart
    case chartex
}

public struct OfficeFileChart: Sendable, Equatable {
    public var id: String
    public var path: String
    public var partKind: OfficeChartPartKind
    public var sheet: String?
    public var slide: Int?
    public var anchor: String?
    public var range: String?
    public var name: String?
    public var title: String
    public var spec: ChartSpec
    public var issues: [String]
    public var unsupported: [String]
    public var lossless: Bool

    public init(
        id: String,
        path: String,
        partKind: OfficeChartPartKind,
        sheet: String? = nil,
        slide: Int? = nil,
        anchor: String? = nil,
        range: String? = nil,
        name: String? = nil,
        title: String,
        spec: ChartSpec,
        issues: [String],
        unsupported: [String],
        lossless: Bool
    ) {
        self.id = id
        self.path = path
        self.partKind = partKind
        self.sheet = sheet
        self.slide = slide
        self.anchor = anchor
        self.range = range
        self.name = name
        self.title = title
        self.spec = spec
        self.issues = issues
        self.unsupported = unsupported
        self.lossless = lossless
    }

    /// The chart as `JSON.stringify` writes the TS object (keys in the same order, absent fields left out).
    public func toJSON() -> JSONValue {
        var out = JSONObject([("id", .string(id)), ("path", .string(path)), ("partKind", .string(partKind.rawValue))])
        if let sheet { out["sheet"] = .string(sheet) }
        if let slide { out["slide"] = .number(Double(slide)) }
        if let anchor { out["anchor"] = .string(anchor) }
        if let range { out["range"] = .string(range) }
        if let name { out["name"] = .string(name) }
        out["title"] = .string(title)
        out["spec"] = spec.toJSON()
        out["issues"] = .array(issues.map(JSONValue.string))
        out["unsupported"] = .array(unsupported.map(JSONValue.string))
        out["lossless"] = .bool(lossless)
        return .object(out)
    }
}

public struct OfficeChartsResult: Sendable, Equatable {
    public var format: OfficeChartFileFormat
    public var charts: [OfficeFileChart]

    public init(format: OfficeChartFileFormat, charts: [OfficeFileChart]) {
        self.format = format
        self.charts = charts
    }

    public func toJSON() -> JSONValue {
        .object(JSONObject([("format", .string(format.rawValue)), ("charts", .array(charts.map { $0.toJSON() }))]))
    }
}

public struct OfficeChartsReadOptions: Sendable, Equatable {
    public var maxEntries: Int?
    public var maxTotalSize: Int?
    public var unsafePaths: ZipUnsafePaths?
    public var maxCharts: Int?

    public init(
        maxEntries: Int? = nil,
        maxTotalSize: Int? = nil,
        unsafePaths: ZipUnsafePaths? = nil,
        maxCharts: Int? = nil
    ) {
        self.maxEntries = maxEntries
        self.maxTotalSize = maxTotalSize
        self.unsafePaths = unsafePaths
        self.maxCharts = maxCharts
    }

    internal var zipOptions: ZipReadOptions {
        ZipReadOptions(maxEntries: maxEntries, maxTotalSize: maxTotalSize, unsafePaths: unsafePaths)
    }
}

public struct OfficeChartsError: Error, LocalizedError, CustomStringConvertible, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
    public var description: String { message }
}

private let STRICT_CHART_NS = "http://purl.oclc.org/ooxml/drawingml/chart"

private struct Relationship {
    var id: String
    var type: String
    var target: String
    var external: Bool
}

/// A JS `Map<string, Relationship>`: insertion order, a repeated id replaces the value in place, and
/// ids are compared by code units (not Unicode-normalised).
private struct RelsMap {
    private var byId: [JSKey: Int] = [:]
    private(set) var values: [Relationship] = []

    mutating func set(_ id: String, _ rel: Relationship) {
        if let idx = byId[JSKey(id)] {
            values[idx] = rel
        } else {
            byId[JSKey(id)] = values.count
            values.append(rel)
        }
    }

    func get(_ id: String) -> Relationship? {
        byId[JSKey(id)].map { values[$0] }
    }
}

private struct Reader {
    let zip: ZipArchive
    let max: Int
    var charts: [OfficeFileChart] = []
    var seen = Set<JSKey>()
}

// Paths are sliced and split by UTF-16 code units, as in JS: a `/` followed by a combining mark is
// one Swift `Character`, so `lastIndex(of: "/")` and `split(separator: "/")` would miss it.

/// `path.slice(0, path.lastIndexOf('/') + 1)`
private func dirname(_ path: String) -> String {
    let units = Array(path.utf16)
    guard let idx = units.lastIndex(of: 0x2F) else { return "" }
    return String(decoding: units[...idx], as: UTF16.self)
}

private func resolvePartPath(_ baseDir: String, _ target: String) -> String {
    let joined = target.jsStartsWith("/") ? Array(target.utf16.dropFirst()) : Array((baseDir + target).utf16)
    var out: [ArraySlice<UInt16>] = []
    for segment in joined.split(separator: 0x2F, omittingEmptySubsequences: false) {
        if segment.isEmpty || segment.elementsEqual([0x2E]) { continue }
        if segment.elementsEqual([0x2E, 0x2E]) {
            if !out.isEmpty { out.removeLast() }
        } else {
            out.append(segment)
        }
    }
    return String(decoding: Array(out.joined(separator: [0x2F])), as: UTF16.self)
}

private func relsPathFor(_ partPath: String) -> String {
    let dir = dirname(partPath)
    let rest = String(decoding: partPath.utf16.dropFirst(dir.utf16.count), as: UTF16.self)
    return "\(dir)_rels/\(rest).rels"
}

private func elements(_ doc: MiniXmlDocument, _ localName: String) -> [MiniXmlElement] {
    doc.getElementsByTagNameNS("*", localName)
}

private func elements(_ el: MiniXmlElement, _ localName: String) -> [MiniXmlElement] {
    el.getElementsByTagNameNS("*", localName)
}

private func relId(_ el: MiniXmlElement, _ localName: String = "id") -> String? {
    for a in el.attributes {
        if a.localName == localName && ((a.namespaceURI?.jsIncludes("relationships") ?? false) || a.prefix == "r") {
            return a.value
        }
    }
    return nil
}

private func firstChild(_ el: MiniXmlElement?, _ localName: String) -> MiniXmlElement? {
    el?.children.first { $0.localName == localName }
}

private func readEntryText(_ zip: ZipArchive, _ path: String) throws -> String? {
    let lower = JSKey(path.jsLowercased)
    guard let entry = zip.get(path) ?? zip.entries.first(where: { JSKey($0.name.jsLowercased) == lower }) else { return nil }
    return try zip.readText(entry)
}

private func readXml(_ r: Reader, _ path: String) throws -> MiniXmlDocument? {
    guard let text = try readEntryText(r.zip, path) else { return nil }
    let doc = try parseChartXml(text)
    return doc.getElementsByTagName("parsererror").isEmpty ? doc : nil
}

private func readRels(_ r: Reader, _ partPath: String) throws -> RelsMap {
    var rels = RelsMap()
    guard let doc = try readXml(r, relsPathFor(partPath)) else { return rels }
    let base = dirname(partPath)
    for rel in elements(doc, "Relationship") {
        guard let id = rel.getAttribute("Id"), !id.isEmpty else { continue }
        let target = rel.getAttribute("Target") ?? ""
        let external = rel.getAttribute("TargetMode").map { JSKey($0.jsLowercased) } == JSKey("external")
        let resolved = external ? target : resolvePartPath(base, target)
        rels.set(id, Relationship(id: id, type: rel.getAttribute("Type") ?? "", target: resolved, external: external))
    }
    return rels
}

private func isChartRef(_ el: MiniXmlElement) -> Bool {
    guard el.localName == "chart" else { return false }
    let ns = el.namespaceURI
    return ns == CHART_OOXML_NS || ns == STRICT_CHART_NS || ns == CHARTEX_NS
}

private func frameName(_ ref: MiniXmlElement) -> String? {
    var cur = ref.parentElement
    while let el = cur {
        if el.localName == "graphicFrame" {
            let nv = elements(el, "cNvPr").first
            let name = nv?.getAttribute("name") ?? ""
            return name.isEmpty ? nil : name
        }
        cur = el.parentElement
    }
    return nil
}

private struct ChartPlace {
    var sheet: String?
    var slide: Int?
    var anchor: String?
    var range: String?
}

private func chartsInPart(
    _ r: inout Reader,
    _ root: MiniXmlDocument,
    _ rels: RelsMap,
    _ place: (MiniXmlElement) -> ChartPlace
) throws {
    for ref in elements(root, "chart") {
        if r.charts.count >= r.max { return }
        if !isChartRef(ref) { continue }
        guard let rel = rels.get(relId(ref) ?? ""), !rel.external, !r.seen.contains(JSKey(rel.target)) else { continue }
        guard let entry = r.zip.get(rel.target) else { continue }
        r.seen.insert(JSKey(rel.target))
        let read = chartFromOoxml(try r.zip.readText(entry))
        let name = frameName(ref)
        let p = place(ref)
        r.charts.append(OfficeFileChart(
            id: "chart-\(r.charts.count + 1)",
            path: rel.target,
            partKind: ref.namespaceURI == CHARTEX_NS ? .chartex : .chart,
            sheet: p.sheet,
            slide: p.slide,
            anchor: p.anchor,
            range: p.range,
            name: name,
            title: read.spec.title,
            spec: read.spec,
            issues: read.issues.map { $0.message },
            unsupported: read.unsupported,
            lossless: read.lossless
        ))
    }
}

private func columnName(_ index: Double) -> String {
    // Double arithmetic as in TS, so huge columns cannot overflow.
    var name = ""
    var n = index + 1
    while n > 0 {
        let unit = (n - 1).truncatingRemainder(dividingBy: 26)
        name = String(UnicodeScalar(UInt8(65 + unit))) + name
        n = ((n - 1) / 26).rounded(.down)
    }
    return name
}

private func anchorCell(_ marker: MiniXmlElement?) -> String? {
    // `Number(textContent)`: a missing element is NaN, "" is 0.
    let col = firstChild(marker, "col").map { $0.textContent.jsToNumber } ?? .nan
    let row = firstChild(marker, "row").map { $0.textContent.jsToNumber } ?? .nan
    guard col.isFinite, row.isFinite, col == col.rounded(.towardZero), row == row.rounded(.towardZero),
          col >= 0, row >= 0 else { return nil }
    return "\(columnName(col))\(JSONValue.jsString(row + 1))"
}

private func drawingPlace(_ ref: MiniXmlElement, sheet: String) -> ChartPlace {
    var cur = ref.parentElement
    while let el = cur {
        if el.localName == "twoCellAnchor" || el.localName == "oneCellAnchor" {
            let anchor = anchorCell(firstChild(el, "from"))
            let to = el.localName == "twoCellAnchor" ? anchorCell(firstChild(el, "to")) : nil
            return ChartPlace(
                sheet: sheet,
                anchor: anchor,
                range: (anchor != nil && to != nil) ? "\(anchor!):\(to!)" : nil
            )
        }
        if el.localName == "absoluteAnchor" {
            return ChartPlace(sheet: sheet)
        }
        cur = el.parentElement
    }
    return ChartPlace(sheet: sheet)
}

private func readMainPart(_ r: Reader) throws -> (path: String, doc: MiniXmlDocument) {
    let rootRels = try readRels(r, "")
    let main = rootRels.values.first { $0.type.jsEndsWith("/officeDocument") && !$0.external }
    guard let main, let doc = try readXml(r, main.target) else {
        throw OfficeChartsError("This is not an Office file: _rels/.rels names no main part (expected an .xlsx, .pptx or .docx file).")
    }
    return (path: main.target, doc: doc)
}

private func readXlsx(_ r: inout Reader, _ main: (path: String, doc: MiniXmlDocument)) throws {
    let rels = try readRels(r, main.path)
    for sheet in elements(main.doc, "sheet") {
        guard let sid = relId(sheet), let rel = rels.get(sid), !rel.external else { continue }
        guard let doc = try readXml(r, rel.target) else { continue }
        let sheetName = sheet.getAttribute("name") ?? rel.target
        let sheetRels = try readRels(r, rel.target)
        for drawingRef in elements(doc, "drawing") {
            guard let did = relId(drawingRef),
                  let drawingRel = sheetRels.get(did),
                  !drawingRel.external,
                  let drawing = try readXml(r, drawingRel.target) else { continue }
            let drawingRels = try readRels(r, drawingRel.target)
            try chartsInPart(&r, drawing, drawingRels) { ref in
                drawingPlace(ref, sheet: sheetName)
            }
        }
    }
}

private func readPptx(_ r: inout Reader, _ main: (path: String, doc: MiniXmlDocument)) throws {
    let rels = try readRels(r, main.path)
    let slides = elements(main.doc, "sldId")
    for (i, slideEl) in slides.enumerated() {
        guard let sid = relId(slideEl),
              let rel = rels.get(sid),
              !rel.external,
              let doc = try readXml(r, rel.target) else { continue }
        let slideRels = try readRels(r, rel.target)
        try chartsInPart(&r, doc, slideRels) { _ in
            ChartPlace(slide: i + 1)
        }
    }
}

private func readDocx(_ r: inout Reader, _ main: (path: String, doc: MiniXmlDocument)) throws {
    let docRels = try readRels(r, main.path)
    try chartsInPart(&r, main.doc, docRels) { _ in ChartPlace() }
}

private func openOffice(_ bytes: [UInt8], _ options: OfficeChartsReadOptions) throws -> (r: Reader, main: (path: String, doc: MiniXmlDocument), format: OfficeChartFileFormat) {
    let zip: ZipArchive
    do {
        zip = try readZip(bytes, options: options.zipOptions)
    } catch {
        throw OfficeChartsError("This is not an Office file: \(error)")
    }
    let r = Reader(zip: zip, max: options.maxCharts ?? 500)
    let main = try readMainPart(r)
    let root = main.doc.documentElement?.localName ?? ""
    let format: OfficeChartFileFormat?
    switch root {
    case "workbook": format = .xlsx
    case "presentation": format = .pptx
    case "document": format = .docx
    default: format = nil
    }
    guard let format else {
        throw OfficeChartsError("The main part \(main.path) is a <\(root)>; expected an Excel workbook, PowerPoint presentation or Word document.")
    }
    return (r: r, main: main, format: format)
}

/**
 * Reads every chart in an Office file, detecting whether it is a workbook, presentation or Word document.
 */
public func extractOfficeCharts(_ bytes: [UInt8], options: OfficeChartsReadOptions = OfficeChartsReadOptions()) throws -> OfficeChartsResult {
    var (r, main, format) = try openOffice(bytes, options)
    switch format {
    case .xlsx: try readXlsx(&r, main)
    case .pptx: try readPptx(&r, main)
    case .docx: try readDocx(&r, main)
    }
    return OfficeChartsResult(format: format, charts: r.charts)
}

private func extractAs(_ format: OfficeChartFileFormat, _ bytes: [UInt8], _ options: OfficeChartsReadOptions) throws -> [OfficeFileChart] {
    let result = try extractOfficeCharts(bytes, options: options)
    if result.format != format {
        throw OfficeChartsError("This is a .\(result.format.rawValue) file, not a .\(format.rawValue) file.")
    }
    return result.charts
}

public func extractXlsxCharts(_ bytes: [UInt8], options: OfficeChartsReadOptions = OfficeChartsReadOptions()) throws -> [OfficeFileChart] {
    try extractAs(.xlsx, bytes, options)
}

public func extractPptxCharts(_ bytes: [UInt8], options: OfficeChartsReadOptions = OfficeChartsReadOptions()) throws -> [OfficeFileChart] {
    try extractAs(.pptx, bytes, options)
}

public func extractDocxCharts(_ bytes: [UInt8], options: OfficeChartsReadOptions = OfficeChartsReadOptions()) throws -> [OfficeFileChart] {
    try extractAs(.docx, bytes, options)
}

/**
 * Where a chart sits, for labels: `Sheet1!B2`, `Slide 3`, `Document`.
 */
public func describeOfficeChartPlace(_ chart: OfficeFileChart) -> String {
    if let sheet = chart.sheet {
        return chart.anchor.map { "\(sheet)!\($0)" } ?? sheet
    }
    if let slide = chart.slide {
        return "Slide \(slide)"
    }
    return "Document"
}
