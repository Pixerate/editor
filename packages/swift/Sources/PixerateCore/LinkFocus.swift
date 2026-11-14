// Focus across linked marks (#812), ported line for line from
// packages/core/src/interaction/linkFocus.ts: a mark is lit when all its keys are the focused key
// or linked to it; arrow keys walk the keys, Escape clears.
import Foundation

private func linkAdjacency(_ links: [(String, [String])]) -> (order: [String], map: [String: [String]]) {
    var order: [String] = []
    var map: [String: [String]] = [:]
    func ensure(_ k: String) { if map[k] == nil { map[k] = []; order.append(k) } }
    func add(_ a: String, _ b: String) {
        ensure(a)
        if !map[a]!.contains(b) { map[a]!.append(b) }
    }
    for (from, tos) in links {
        ensure(from)
        for to in tos where to != from {
            add(from, to)
            add(to, from)
        }
    }
    return (order, map)
}

/// Which marks are lit when `focus` is focused (`linkFocusLit` in the TS core). `links` keeps
/// the TS object's key order.
public func linkFocusLit(_ marks: [[String]], _ links: [(String, [String])], _ focus: String?) -> [Bool] {
    guard let focus else { return marks.map { _ in true } }
    let inFocus = Set([focus] + (linkAdjacency(links).map[focus] ?? []))
    return marks.map { keys in !keys.isEmpty && keys.allSatisfy { inFocus.contains($0) } }
}

public enum LinkFocusError: Error, CustomStringConvertible, Equatable {
    case invalid(String)
    public var description: String { switch self { case .invalid(let m): return m } }
}

/// A headless linked-focus model for one picture (`createLinkFocus` in the TS core).
public final class LinkFocusModel {
    public let marks: [[String]]
    public let order: [String]
    public let dim: Double
    public private(set) var focus: String?
    public private(set) var lit: [Bool]
    private let links: [(String, [String])]
    private let adjacency: [String: [String]]
    private let known: [String]
    private let labels: [String: String]

    public init(marks: [[String]], links: [(String, [String])], order orderOption: [String]? = nil, labels: [String: String] = [:], dim: Double = 0.25) throws {
        self.marks = marks
        self.links = links
        let adj = linkAdjacency(links)
        self.adjacency = adj.map
        var known: [String] = []
        for keys in marks { for k in keys where !known.contains(k) { known.append(k) } }
        for from in adj.order {
            if !known.contains(from) { known.append(from) }
            for to in adj.map[from]! where !known.contains(to) { known.append(to) }
        }
        self.known = known
        var own: [String] = []
        for keys in marks where keys.count == 1 && !own.contains(keys[0]) { own.append(keys[0]) }
        var order: [String] = []
        for k in orderOption ?? own where !order.contains(k) { order.append(k) }
        for k in order where !known.contains(k) {
            throw LinkFocusError.invalid("order names \"\(k)\", which no mark or link has. Known keys: \(known.joined(separator: ", ")).")
        }
        self.order = order
        self.labels = labels
        self.dim = min(1, max(0, dim))
        self.lit = marks.map { _ in true }
    }

    /// The keys in focus: the focused key and the keys linked to it.
    public var inFocus: [String] { focus.map { [$0] + (adjacency[$0] ?? []) } ?? [] }

    private func set(_ key: String?) {
        if key == focus { return }
        focus = key
        lit = linkFocusLit(marks, links, key)
    }

    /// Focuses a key (or clears with nil). Unknown keys throw, naming the known ones.
    public func focus(_ key: String?) throws {
        if let key, !known.contains(key) { throw LinkFocusError.invalid("Unknown key \"\(key)\". Known keys: \(known.joined(separator: ", ")).") }
        set(key)
    }

    public func clear() { set(nil) }

    public func related(_ key: String) -> [String] { adjacency[key] ?? [] }

    public func opacity() -> [Double] { lit.map { $0 ? 1 : dim } }

    /// Arrow keys walk `order` (wrapping), Home / End jump, Escape clears. True when handled.
    @discardableResult
    public func handleKey(_ key: String) -> Bool {
        if key == "Escape" {
            if focus == nil { return false }
            set(nil)
            return true
        }
        if order.isEmpty { return false }
        let i = focus.flatMap { order.firstIndex(of: $0) } ?? -1
        let next: Int
        switch key {
        case "ArrowRight", "ArrowDown": next = i < 0 ? 0 : (i + 1) % order.count
        case "ArrowLeft", "ArrowUp": next = i < 0 ? order.count - 1 : (i - 1 + order.count) % order.count
        case "Home": next = 0
        case "End": next = order.count - 1
        default: return false
        }
        set(order[next])
        return true
    }

    /// A sentence for screen readers about a key (default the focused one) and what it links to.
    public func describe(_ keyOption: String?? = nil) -> String {
        let key: String? = keyOption ?? focus
        guard let key else { return "Nothing focused." }
        let label = { (k: String) in self.labels[k] ?? k }
        let rel = adjacency[key] ?? []
        let where_ = order.firstIndex(of: key).map { ", \($0 + 1) of \(order.count)" } ?? ""
        if rel.isEmpty { return "\(label(key))\(where_): no links." }
        return "\(label(key))\(where_): linked to \(rel.count == 1 ? "1 other" : "\(rel.count) others"), \(rel.map(label).joined(separator: ", "))."
    }
}
