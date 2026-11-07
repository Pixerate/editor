import Foundation
import PixerateCore

/// One region of a map: an id (ISO 3166-1 alpha-3 for countries), a name and its outline.
public struct ChartMapRegion: Sendable, Equatable {
    public var id: String
    public var name: String
    /// SVG path data in the map's box (absolute M / L / Z commands).
    public var d: String
    /// Where a label or a marker goes, in the map's box.
    public var center: (Double, Double)
    /// Area in square box units (0 for a region too small to outline, drawn as a marker).
    public var area: Double

    public init(id: String, name: String, d: String, center: (Double, Double), area: Double) {
        self.id = id
        self.name = name
        self.d = d
        self.center = center
        self.area = area
    }

    public static func == (lhs: ChartMapRegion, rhs: ChartMapRegion) -> Bool {
        lhs.id == rhs.id &&
            lhs.name == rhs.name &&
            lhs.d == rhs.d &&
            lhs.center.0 == rhs.center.0 &&
            lhs.center.1 == rhs.center.1 &&
            lhs.area == rhs.area
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("id", .string(id)),
            ("name", .string(name)),
            ("d", .string(d)),
            ("center", .array([.number(center.0), .number(center.1)])),
            ("area", .number(area))
        ]))
    }
}

public struct ChartMapGeometry: Sendable, Equatable {
    public var id: String
    public var name: String
    public var width: Double
    public var height: Double
    public var regions: [ChartMapRegion]
    public var land: String?
    public var attribution: String?

    public init(
        id: String,
        name: String,
        width: Double,
        height: Double,
        regions: [ChartMapRegion],
        land: String? = nil,
        attribution: String? = nil
    ) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.regions = regions
        self.land = land
        self.attribution = attribution
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("id", .string(id)),
            ("name", .string(name)),
            ("width", .number(width)),
            ("height", .number(height)),
            ("regions", .array(regions.map { $0.toJSON() }))
        ])
        if let land { obj["land"] = .string(land) }
        if let attribution { obj["attribution"] = .string(attribution) }
        return .object(obj)
    }
}

private final class MapRegistryStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var maps: [String: ChartMapGeometry] = [:]
    private var order: [String] = []

    func register(_ map: ChartMapGeometry) {
        lock.lock()
        defer { lock.unlock() }
        if maps[map.id] == nil {
            order.append(map.id)
        }
        maps[map.id] = map
    }

    func get(_ id: String) -> ChartMapGeometry? {
        lock.lock()
        defer { lock.unlock() }
        return maps[id]
    }

    func list() -> [ChartMapGeometry] {
        lock.lock()
        defer { lock.unlock() }
        return order.compactMap { maps[$0] }
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        maps.removeAll()
        order.removeAll()
    }
}

private let mapRegistry = MapRegistryStorage()

/// Clears all registered maps.
public func clearChartMaps() {
    mapRegistry.clear()
}

/// Makes a map available to choropleth charts (`spec.map` = its id). Registering an id again replaces it.
public func registerChartMap(_ map: ChartMapGeometry) {
    mapRegistry.register(map)
}

/// A registered map by id, or nil.
public func getChartMap(_ id: String) -> ChartMapGeometry? {
    mapRegistry.get(id)
}

/// Every registered map.
public func listChartMaps() -> [ChartMapGeometry] {
    mapRegistry.list()
}

private func fold(_ text: String) -> String {
    let decomposed = text.decomposedStringWithCompatibilityMapping
    let stripped = String(decomposed.unicodeScalars.filter { scalar in
        !(scalar.value >= 0x0300 && scalar.value <= 0x036F)
    })
    return stripped.jsTrimmed.lowercased()
}

/// The region each category names, matched by id (any case) or by name (ignoring case and
/// accents), or nil. Several categories may not name the same region: the first wins.
public func matchChartMapRegions(_ map: ChartMapGeometry, _ categories: [String]) -> [ChartMapRegion?] {
    var byKey: [String: ChartMapRegion] = [:]
    for r in map.regions {
        byKey[fold(r.id)] = r
        byKey[fold(r.name)] = r
    }
    var taken = Set<String>()
    return categories.map { c in
        guard let r = byKey[fold(c)], !taken.contains(r.id) else { return nil }
        taken.insert(r.id)
        return r
    }
}

/// Class breaks for a choropleth: `thresholds` when given (ascending), else `steps` equal
/// intervals between the smallest and largest value. Returns the inner breaks (one fewer than the classes).
public func chartMapBreaks(_ values: [Double], _ steps: Int, _ thresholds: [Double]) -> [Double] {
    if !thresholds.isEmpty { return thresholds }
    if values.isEmpty { return [] }
    guard let lo = values.min(), let hi = values.max(), hi > lo, steps > 1 else { return [] }
    let exact: [Double] = (0..<(steps - 1)).map { k in
        lo + ((hi - lo) * Double(k + 1)) / Double(steps)
    }
    for digits in 2...6 {
        let rounded = exact.map { b in Double(jsToPrecision(b, digits)) ?? b }
        let strictlyIncreasing = rounded.enumerated().allSatisfy { i, b in
            i == 0 || b > rounded[i - 1]
        }
        if strictlyIncreasing { return rounded }
    }
    return exact
}

/// The class (0-based) a value falls in: the number of breaks at or below it.
public func chartMapClass(_ value: Double, _ breaks: [Double]) -> Int {
    breaks.filter { value >= $0 }.count
}

/// A light-to-dark ramp of `count` shades of `base`, one per class.
public func chartMapRamp(_ base: String, _ count: Int) -> [String] {
    if count <= 1 { return [base] }
    return (0..<count).map { k in
        shadeChartColor(base, 0.82 - (1.17 * Double(k)) / Double(count - 1))
    }
}
