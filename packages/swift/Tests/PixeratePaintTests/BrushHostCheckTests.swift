import Foundation
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Host support against the brushes contracts: Swift's host profiles are the ones in
/// `profiles.json`, and Swift's `checkBrush` gives every preset on every host the verdict and
/// issues the TypeScript core records in `checks.json`. The contracts keep each issue's facet and
/// severity, not its wording, so those are what is compared.
final class BrushHostCheckTests: XCTestCase {
    /// The support fields a profile may leave out (missing means `none`).
    private func optionalSupport(_ p: BrushHostProfile) -> [(String, String?)] {
        [("tipGrain", p.tipGrain), ("dabCount", p.dabCount), ("livePatterns", p.livePatterns),
         ("iridescence", p.iridescence), ("ferro", p.ferro), ("culture", p.culture)]
    }

    /// A profile as `profiles.json` writes it: optional support fields are left out when unset.
    private func json(_ p: BrushHostProfile) -> JSONValue {
        var o: JSONObject = [
            "id": .string(p.id), "name": .string(p.name),
            "kinds": .array(p.kinds.map(JSONValue.string)), "tools": .array(p.tools.map(JSONValue.string)),
            "tipShapes": .array(p.tipShapes.map(JSONValue.string)), "marks": .array(p.marks.map(JSONValue.string)),
            "surfaces": .array(p.surfaces.map(JSONValue.string)),
            "exchange": .string(p.exchange), "reservoir": .string(p.reservoir), "grain": .string(p.grain),
            "light": .string(p.light), "motion": .string(p.motion),
            "colours": .array(p.colours.map(JSONValue.string)),
            "velocity": .string(p.velocity), "tilt": .string(p.tilt),
        ]
        for (key, value) in optionalSupport(p) {
            if let v = value { o[key] = .string(v) }
        }
        return .object(o)
    }

    /// A profile read from `profiles.json`, so the check runs on the contract's hosts, not Swift's copy.
    private func profile(_ v: JSONValue) throws -> BrushHostProfile {
        let o = try XCTUnwrap(v.objectValue)
        func s(_ k: String) throws -> String { try XCTUnwrap(o[k]?.stringValue, "profile field \(k)") }
        func a(_ k: String) throws -> [String] { try XCTUnwrap(o[k]?.arrayValue, "profile field \(k)").compactMap(\.stringValue) }
        let known = Set(["id", "name", "kinds", "tools", "tipShapes", "marks", "surfaces", "exchange", "reservoir", "grain", "light", "motion", "colours", "velocity", "tilt"] + optionalSupport(PAINT_PROFILE).map(\.0))
        XCTAssertEqual(Set(o.keys).subtracting(known), [], "profiles.json has a field BrushHostProfile doesn't: port it from profiles.ts")
        return BrushHostProfile(
            id: try s("id"), name: try s("name"), kinds: try a("kinds"), tools: try a("tools"),
            tipShapes: try a("tipShapes"), marks: try a("marks"), surfaces: try a("surfaces"),
            exchange: try s("exchange"), reservoir: try s("reservoir"), grain: try s("grain"),
            light: try s("light"), motion: try s("motion"), colours: try a("colours"),
            velocity: try s("velocity"), tilt: try s("tilt"),
            tipGrain: o["tipGrain"]?.stringValue, dabCount: o["dabCount"]?.stringValue,
            livePatterns: o["livePatterns"]?.stringValue, iridescence: o["iridescence"]?.stringValue,
            ferro: o["ferro"]?.stringValue, culture: o["culture"]?.stringValue
        )
    }

    private func contract(_ name: String) throws -> [JSONValue] {
        try XCTUnwrap(JSONValue.parse(ConformanceContracts.data("domains/brushes/\(name)")).arrayValue, name)
    }

    func testBuiltInProfilesMatchTheContracts() throws {
        let expected = try contract("profiles.json")
        XCTAssertEqual(BRUSH_HOST_PROFILES.map(\.id), expected.compactMap { $0["id"]?.stringValue })
        for (p, e) in zip(BRUSH_HOST_PROFILES, expected) {
            XCTAssertEqual(json(p), e, p.id)
        }
    }

    func testEveryPresetChecksOnEveryHostAsInTheContracts() throws {
        let profiles = try contract("profiles.json").map(profile)
        let presets = Dictionary(uniqueKeysWithValues: BRUSH_PRESETS.map { ($0["id"]?.stringValue ?? "", $0) })
        let checks = try contract("checks.json")
        XCTAssertEqual(checks.count, BRUSH_PRESETS.count, "checks.json has one entry per preset")
        for entry in checks {
            let id = try XCTUnwrap(entry["id"]?.stringValue)
            let brush = try XCTUnwrap(presets[id], "\(id) is in checks.json but not presets.json")
            let hosts = try XCTUnwrap(entry["hosts"]?.objectValue, id)
            XCTAssertEqual(Set(hosts.keys), Set(profiles.map(\.id)), id)
            for p in profiles {
                let expected = try XCTUnwrap(hosts[p.id], "\(id) on \(p.id)")
                let check = checkBrush(brush, p)
                let issues = JSONValue.array(check.issues.map { .object(["facet": .string($0.facet), "severity": .string($0.severity)]) })
                XCTAssertEqual(.bool(check.ok), expected["ok"], "\(id) on \(p.id): ok")
                XCTAssertEqual(issues, expected["issues"], "\(id) on \(p.id): issues")
            }
        }
    }

    /// `degrade` strips every refusal it can (all but an unsupported kind or tool, which stay in
    /// `issues`), as `degrade` in `profiles.ts` does; with `ignored`, the warnings too.
    func testDegradeStripsEveryRefusalOnEveryPreset() throws {
        let unstrippable: Set<String> = ["kind", "tool"]
        for p in BRUSH_HOST_PROFILES {
            for brush in BRUSH_PRESETS {
                let id = brush["id"]?.stringValue ?? ""
                let issues = checkBrush(brush, p).issues
                let errors = issues.filter { $0.severity == "error" }.map(\.facet)
                let result = degrade(brush, p)
                let dropped = (result["dropped"]?.arrayValue ?? []).compactMap { $0["facet"]?.stringValue }
                XCTAssertEqual(dropped, errors.filter { !unstrippable.contains($0) }, "\(id) on \(p.id): dropped")
                let left = (result["issues"]?.arrayValue ?? []).compactMap { $0["facet"]?.stringValue }
                XCTAssertEqual(left, errors.filter { unstrippable.contains($0) }, "\(id) on \(p.id): issues after degrade")

                let stripped = degrade(brush, p, ignored: true)
                let strippedBrush = try XCTUnwrap(stripped["brush"]?.objectValue)
                let rest = checkBrush(strippedBrush, p).issues.map(\.facet).filter { !unstrippable.contains($0) }
                XCTAssertEqual(rest, [], "\(id) on \(p.id): issues after degrade(ignored:)")
            }
        }
    }

    func testDegradeDropsAnEmptyColourAndForeignPaletteColours() throws {
        let effect: JSONValue = ["type": "effect", "effect": "holo"]
        let base: Brush = ["id": "fx", "name": "FX", "kind": "mark", "tip": ["shape": "round", "size": 10]]
        var onlyDefault = base
        onlyDefault["colour"] = ["default": effect]
        let degraded = degrade(onlyDefault, IMAGE_PROFILE)
        XCTAssertNil(degraded["brush"]?.objectValue?["colour"], "colour left empty is removed")
        XCTAssertEqual((degraded["dropped"]?.arrayValue ?? []).compactMap { $0["facet"]?.stringValue }, ["colour.default"])

        var palette = base
        palette["colour"] = ["palette": [effect, "#ff0000"]]
        XCTAssertEqual(degrade(palette, IMAGE_PROFILE)["brush"]?.objectValue?["colour"], palette["colour"], "warnings are kept without ignored")
        let stripped = degrade(palette, IMAGE_PROFILE, ignored: true)
        XCTAssertEqual(stripped["brush"]?.objectValue?["colour"], ["palette": ["#ff0000"]] as JSONValue)
        var onlyForeign = base
        onlyForeign["colour"] = ["palette": [effect]]
        XCTAssertNil(degrade(onlyForeign, IMAGE_PROFILE, ignored: true)["brush"]?.objectValue?["colour"])
    }
}
