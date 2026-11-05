import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Multipage documents with master pages, built on frames (`vector/pages.ts`). The document's pages
// are its top-level frames in order, except master pages (top-level frames with `frame.master`).
// A page whose `frame.masterId` names a master draws the master's children under its own, laid out
// by each child's resizing constraints from the master's rectangle to the page's. Text on a master
// can show `{page}` and `{pages}`.
//
// The drawn master art (`masterArt`) is derived like a lens's backdrop and an instance's art: the
// controller's refresh brings it up to date after every edit (`resolveVectorMasterPages`) and saved
// documents leave it out (`stripVectorMasterArt`). Swift nodes are values, so it is kept as the
// nodes' JSON and replaced only when that JSON differs (the TS keeps node objects by identity).

/// Whether `node` is a master page (a frame with `master` set).
public func isVectorMasterPage(_ node: VectorNode?) -> Bool {
    guard let node, isVectorFrame(node) else { return false }
    return truthy(node.frame?["master"])
}

/// The document's pages: its top-level frames that are not master pages, in order.
public func vectorPages(_ nodes: [VectorNode]) -> [VectorNode] {
    nodes.filter { isVectorFrame($0) && !truthy($0.frame?["master"]) }
}

/// The document's master pages, in order.
public func vectorMasterPages(_ nodes: [VectorNode]) -> [VectorNode] { nodes.filter(isVectorMasterPage) }

/// `s` with every `{page}` and `{pages}` filled in.
private func fillPageTokens(_ s: String, _ page: Int, _ pages: Int) -> String {
    s.replacingOccurrences(of: "{page}", with: String(page)).replacingOccurrences(of: "{pages}", with: String(pages))
}

/// Text with `{page}` and `{pages}` filled in, its runs' lengths (UTF-16 units) kept in step.
private func fillTokens(_ node: VectorNode, _ page: Int, _ pages: Int) -> VectorNode {
    guard let text = node["text"]?.stringValue, text.contains("{page}") || text.contains("{pages}") else { return node }
    var out = node
    guard let runs = node["runs"]?.arrayValue, !runs.isEmpty else {
        out["text"] = .string(fillPageTokens(text, page, pages))
        return out
    }
    let units = Array(text.utf16)
    func slice(_ a: Int, _ b: Int) -> String {
        let lo = min(max(0, a), units.count)
        let hi = min(max(lo, b), units.count)
        return String(decoding: units[lo ..< hi], as: UTF16.self)
    }
    var at = 0
    var filled = ""
    var next: [JSONValue] = []
    for r in runs {
        let length = Int(r["length"]?.numberValue ?? 0)
        let part = fillPageTokens(slice(at, at + length), page, pages)
        at += length
        filled += part
        var run = r.objectValue ?? JSONObject()
        run["length"] = .number(Double(part.utf16.count))
        next.append(.object(run))
    }
    out["text"] = .string(filled + fillPageTokens(slice(at, units.count), page, pages))
    out["runs"] = .array(next)
    return out
}

/// A master's child on a page: ids made unique to the page, tokens filled in.
private func onPage(_ node: VectorNode, _ pageId: String, _ page: Int, _ pages: Int) -> VectorNode {
    var out = node.isText ? fillTokens(node, page, pages) : node
    out.id = "\(pageId)~master~\(node.id)"
    if node.isGroup {
        out.children = node.children.map { onPage($0, pageId, page, pages) }
        return out
    }
    out["locked"] = true
    return out
}

/// The master's art as drawn on a page (`vectorMasterArt`).
public func vectorMasterArt(_ master: VectorNode, _ page: VectorNode, _ number: Int, _ count: Int) throws -> [VectorNode] {
    guard let from = master.frame.map(vectorFrameRect), let to = page.frame.map(vectorFrameRect) else { return [] }
    return try master.children.filter(\.isVisible).map { c in
        let placed: VectorNode
        if let box = try vectorNodeBounds(c) {
            placed = try transformVectorNode(c, vectorFrameChildMatrix(c["resizing"], box, from, to))
        } else {
            placed = c
        }
        return onPage(placed, page.id, number, count)
    }
}

/// The document with every page's `masterArt` up to date (and gone from pages without a master).
/// A page whose master art cannot be drawn yet (text, which the port cannot transform) keeps what
/// it has.
public func resolveVectorMasterPages(_ doc: VectorDocument) -> VectorDocument {
    let masterList = vectorMasterPages(doc.nodes)
    let pages = vectorPages(doc.nodes)
    if masterList.isEmpty && !doc.nodes.contains(where: { $0.has("masterArt") }) { return doc }
    var masters: [String: VectorNode] = [:]
    for m in masterList where masters[m.id] == nil { masters[m.id] = m }
    var numbers: [String: Int] = [:]
    for (i, p) in pages.enumerated() where numbers[p.id] == nil { numbers[p.id] = i + 1 }
    var changed = false
    let nodes = doc.nodes.map { n -> VectorNode in
        guard isVectorFrame(n), let frame = n.frame else { return n }
        var master: VectorNode?
        if !truthy(frame["master"]), let mid = frame["masterId"]?.stringValue, !mid.isEmpty { master = masters[mid] }
        let art: JSONValue?
        if let master {
            guard let drawn = try? vectorMasterArt(master, n, numbers[n.id] ?? 0, pages.count) else { return n }
            art = .array(drawn.map { $0.toJSON() })
        } else {
            art = nil
        }
        if art == n["masterArt"] { return n }
        changed = true
        var next = n
        next["masterArt"] = art.map { Optional($0) } ?? Optional<JSONValue>.none
        return next
    }
    if !changed { return doc }
    var out = doc
    out.nodes = nodes
    return out
}

/// The document without pages' drawn master art (what is saved).
public func stripVectorMasterArt(_ doc: VectorDocument) -> VectorDocument {
    if !doc.nodes.contains(where: { $0.isGroup && $0.has("masterArt") }) { return doc }
    var out = doc
    out.nodes = doc.nodes.map { n in
        guard n.isGroup && n.has("masterArt") else { return n }
        var c = n
        c["masterArt"] = Optional<JSONValue>.none
        return c
    }
    return out
}
