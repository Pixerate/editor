import Foundation

/// The fields `rankCommands` searches (a `CommandEntry` satisfies it).
public protocol RankableCommand {
    var id: String { get }
    var label: String { get }
    var group: String? { get }
    var keywords: [String]? { get }
    /// `nil` counts as enabled.
    var isEnabledForRanking: Bool? { get }
}

extension RankableCommand {
    public var group: String? { nil }
    public var keywords: [String]? { nil }
    public var isEnabledForRanking: Bool? { nil }
}

public struct FuzzyMatch: Equatable, Sendable {
    public var score: Int
    /// Indices of the matched characters in the lowercased text, in UTF-16 units (for highlighting).
    public var indices: [Int]
}

// ' ', '-', '_', '.', '/', ':', '›', '('
private let wordSeparators: Set<UInt16> = [0x20, 0x2D, 0x5F, 0x2E, 0x2F, 0x3A, 0x203A, 0x28]

/**
 Subsequence fuzzy match: every query character must appear in order. Consecutive matches score
 8, others 1; a match at a word start adds 5; longer texts lose `length / 8`. Case-insensitive.
 Returns `nil` when the query does not match. As in TS, the query is read by code point and the
 text by UTF-16 unit, so an astral query character never matches.
 */
public func fuzzyMatch(_ query: String, _ text: String) -> FuzzyMatch? {
    let q = query.jsTrimmed.jsLowercased
    if q.isEmpty { return FuzzyMatch(score: 0, indices: []) }
    let t = Array(text.jsLowercased.utf16)
    var score = 0
    var ti = 0
    var last = -2
    var indices: [Int] = []
    for qc in q.unicodeScalars {
        if qc == " " { continue }
        let unit: UInt16? = qc.value <= 0xFFFF ? UInt16(qc.value) : nil
        var found = false
        while ti < t.count {
            if let unit, t[ti] == unit {
                score += last == ti - 1 ? 8 : 1
                if ti == 0 || wordSeparators.contains(t[ti - 1]) { score += 5 }
                last = ti
                indices.append(ti)
                ti += 1
                found = true
                break
            }
            ti += 1
        }
        if !found { return nil }
    }
    // Math.floor of a non-negative quotient.
    return FuzzyMatch(score: score - t.count / 8, indices: indices)
}

/// `fuzzyMatch(query, text)?.score`.
public func fuzzyScore(_ query: String, _ text: String) -> Int? { fuzzyMatch(query, text)?.score }

/**
 Bonus that puts a command whose name is exactly the query ahead of every fuzzy match ("undo"
 finds Undo before "Undo Selection Change"). Trailing ellipses are ignored.
 */
public func exactBonus(_ query: String, _ names: [String]) -> Int {
    let q = query.jsTrimmed.jsLowercased
    if q.isEmpty { return 0 }
    return names.contains { stripEllipsis($0).jsTrimmed.jsLowercased.utf16.elementsEqual(q.utf16) } ? 1000 : 0
}

/// `name.replace(/(…|\.\.\.)$/, '')`.
private func stripEllipsis(_ name: String) -> String {
    let units = Array(name.utf16)
    if units.last == 0x2026 { return String(decoding: units.dropLast(), as: UTF16.self) }
    if units.count >= 3 && units.suffix(3).allSatisfy({ $0 == 0x2E }) { return String(decoding: units.dropLast(3), as: UTF16.self) }
    return name
}

/// Default number of recently run commands a palette remembers.
public let defaultRecentLimit = 8

/// `Array.prototype.slice(0, end)`: a negative end counts from the back.
private func jsSlicePrefix<T>(_ a: [T], _ end: Int) -> [T] {
    let e = end < 0 ? max(0, a.count + end) : min(end, a.count)
    return Array(a.prefix(e))
}

/// Moves `id` to the front of `list` (deduplicated, newest first, at most `cap`).
public func pushRecent(_ list: [String], _ id: String, cap: Int = defaultRecentLimit) -> [String] {
    Array(([id] + list.filter { $0 != id }).prefix(max(0, cap)))
}

public struct RankedCommand<T: RankableCommand> {
    public var entry: T
    public var score: Int
    /// Matched character indices in `entry.label` (empty when another field matched).
    public var labelIndices: [Int]
    /// The entry was shown because it was run recently (empty query).
    public var recent: Bool
}

public struct RankCommandsOptions: Sendable {
    public enum EmptyQuery: Sendable { case all, recents }
    /// Recently run ids, newest first. Shown first for an empty query and boosted slightly otherwise.
    public var recents: [String]
    /// Maximum number of recents shown for an empty query (default 8).
    public var recentLimit: Int
    /// Maximum number of results.
    public var limit: Int?
    /// Sort disabled commands after enabled ones (default `true`).
    public var disabledLast: Bool
    /// With an empty query: `all` (default) lists recents then every other command; `recents` lists only recents.
    public var emptyQuery: EmptyQuery

    public init(recents: [String] = [], recentLimit: Int = defaultRecentLimit, limit: Int? = nil, disabledLast: Bool = true, emptyQuery: EmptyQuery = .all) {
        self.recents = recents
        self.recentLimit = recentLimit
        self.limit = limit
        self.disabledLast = disabledLast
        self.emptyQuery = emptyQuery
    }
}

/**
 Ranks commands for a palette query. Searches the label, `group label`, keywords and id; an exact
 label or keyword match always wins. An empty query lists recent commands first (deduplicated and
 capped), then the rest in their original order.
 */
public func rankCommands<T: RankableCommand>(_ query: String, _ entries: [T], _ options: RankCommandsOptions = RankCommandsOptions()) -> [RankedCommand<T>] {
    let recents = options.recents
    let q = query.jsTrimmed
    var ranked: [(RankedCommand<T>, order: Int)] = []

    if q.isEmpty {
        // `new Map(entries.map(e => [e.id, e]))`: the last entry with an id wins.
        var byId: [String: T] = [:]
        for e in entries { byId[e.id] = e }
        var seen = Set<String>()
        let unique = recents.filter { seen.insert($0).inserted }
        let recentIds = jsSlicePrefix(unique.filter { byId[$0] != nil }, options.recentLimit)
        let recentSet = Set(recentIds)
        for (i, id) in recentIds.enumerated() {
            ranked.append((RankedCommand(entry: byId[id]!, score: 1000 - i, labelIndices: [], recent: true), i))
        }
        if options.emptyQuery == .all {
            for (i, entry) in entries.enumerated() where !recentSet.contains(entry.id) {
                ranked.append((RankedCommand(entry: entry, score: 0, labelIndices: [], recent: false), recentIds.count + i))
            }
        }
    } else {
        for (order, entry) in entries.enumerated() {
            let label = fuzzyMatch(q, entry.label)
            var candidates: [Int] = []
            if let label { candidates.append(label.score) }
            if let group = entry.group, !group.isEmpty, let grouped = fuzzyScore(q, "\(group) \(entry.label)") {
                candidates.append(grouped - 1)
            }
            for keyword in entry.keywords ?? [] {
                if let s = fuzzyScore(q, keyword) { candidates.append(s - 2) }
            }
            if let byId = fuzzyScore(q, entry.id) { candidates.append(byId - 3) }
            if candidates.isEmpty { continue }
            let recentIndex = recents.firstIndex(of: entry.id)
            let score = candidates.max()! + exactBonus(q, [entry.label] + (entry.keywords ?? [])) + (recentIndex.map { max(1, 4 - $0) } ?? 0)
            ranked.append((RankedCommand(entry: entry, score: score, labelIndices: label?.indices ?? [], recent: false), order))
        }
        // The comparator is total (order breaks every tie), so any sort gives JS's result.
        ranked.sort { a, b in
            if a.0.score != b.0.score { return a.0.score > b.0.score }
            let la = a.0.entry.label.utf16.count, lb = b.0.entry.label.utf16.count
            if la != lb { return la < lb }
            return a.order < b.order
        }
    }

    var out = ranked.map(\.0)
    if options.disabledLast {
        // Stable partition: enabled first, keeping the ranking within each half.
        out = out.filter { $0.entry.isEnabledForRanking != false } + out.filter { $0.entry.isEnabledForRanking == false }
    }
    if let limit = options.limit { out = jsSlicePrefix(out, limit) }
    return out
}
