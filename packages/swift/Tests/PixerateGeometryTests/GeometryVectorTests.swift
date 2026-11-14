import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixerateGeometry

/// The TS geometry's own outputs (`packages/core/tests/swift-geometry-vectors.test.ts` writes
/// `Fixtures/geometry-vectors.json`): the Swift port must reproduce every one. Entries marked
/// `trig: false` compare exactly; `trig: true` ones went through `sin` / `cos` / `atan2` / `tan`
/// / `acos`, which differ in the last bits between machines, and compare within the
/// conformance tolerance (relative 1e-9). Strings compare exactly.
final class GeometryVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "geometry-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    private func entries(_ group: String) -> [JSONValue] { Self.vectors.get(group).a }

    /// Runs every entry of a group through `body`, which returns the Swift output in the
    /// fixture's encoding (or throws where the TS threw).
    private func run(_ group: String, file: StaticString = #filePath, line: UInt = #line, _ body: (String, JSONValue) throws -> JSONValue?) {
        var checked = 0
        var failures: [String] = []
        for (index, e) in entries(group).enumerated() {
            let fn = e.get("fn").s
            let label = "\(group)[\(index)] \(fn)\(e["name"]?.stringValue.map { " (\($0))" } ?? "")"
            let trig = e.get("trig").boolValue ?? false
            do {
                guard let got = try body(fn, e) else { continue }
                checked += 1
                if let thrown = e["throws"] {
                    failures.append("\(label): expected a throw (\(thrown.s)), got \(got.stringified())")
                    continue
                }
                var path: [String] = []
                if let diff = mismatch(got, e.get("out"), trig, &path) { failures.append("\(label) at \(path.joined()): \(diff)") }
            } catch {
                checked += 1
                if e["throws"] == nil { failures.append("\(label): threw \(error)") }
            }
        }
        XCTAssertGreaterThan(checked, 0, "no \(group) entries ran", file: file, line: line)
        for f in failures.prefix(25) { XCTFail(f, file: file, line: line) }
        if failures.count > 25 { XCTFail("… and \(failures.count - 25) more \(group) failures", file: file, line: line) }
    }

    /// The first difference between `got` and `want`, or nil.
    private func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: inout [String]) -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w { return nil }
            if trig && abs(g - w) <= 1e-9 * max(1, abs(g), abs(w)) { return nil }
            return "\(g) != \(w)"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(g.count) items != \(w.count): \(JSONValue.array(g).stringified().prefix(300)) vs \(JSONValue.array(w).stringified().prefix(300))" }
            for i in 0..<g.count {
                path.append("[\(i)]")
                if let d = mismatch(g[i], w[i], trig, &path) { return d }
                path.removeLast()
            }
            return nil
        case let (.object(g), .object(w)):
            let gk = Set(g.keys), wk = Set(w.keys)
            if gk != wk { return "keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys {
                path.append(".\(k)")
                if let d = mismatch(g[k]!, w[k]!, trig, &path) { return d }
                path.removeLast()
            }
            return nil
        default:
            return got == want ? nil : "\(got.stringified().prefix(300)) != \(want.stringified().prefix(300))"
        }
    }

    // MARK: Segments

    func testSegments() {
        run("segment") { fn, e in
            let seg = e["seg"]?.segment ?? []
            switch fn {
            case "segmentPoint": return .array(e.get("ts").a.map { enc(segmentPoint(seg, $0.n)) })
            case "segmentDerivative": return .array(e.get("ts").a.map { enc(segmentDerivative(seg, $0.n)) })
            case "segmentSecondDerivative": return .array(e.get("ts").a.map { enc(segmentSecondDerivative(seg, $0.n)) })
            case "segmentTangent": return .array(e.get("ts").a.map { enc(segmentTangent(seg, $0.n)) })
            case "segmentCurvature": return .array(e.get("ts").a.map { num(segmentCurvature(seg, $0.n)) })
            case "splitSegment":
                return .array(e.get("ts").a.map { t in let (l, r) = splitSegment(seg, t.n); return [enc(l), enc(r)] })
            case "subSegment": return .array(e.get("ranges").a.map { r in enc(subSegment(seg, r.a[0].n, r.a[1].n)) })
            case "segmentExtrema": return [nums(segmentExtrema(seg, 0)), nums(segmentExtrema(seg, 1))]
            case "segmentBounds": return enc(segmentBounds(seg))
            case "monotoneParams": return nums(monotoneParams(seg))
            case "segmentAreaTerm": return num(segmentAreaTerm(seg))
            case "segmentLength":
                let tol = e["tolerance"]?.numberValue ?? 1e-9
                return .array(e.get("ranges").a.map { r in num(segmentLength(seg, r.a[0].n, r.a[1].n, tol)) })
            case "segmentParamAtLength": return .array(e.get("lengths").a.map { num(segmentParamAtLength(seg, $0.n)) })
            case "segmentNearest":
                return .array(e.get("points").a.map { p in let r = segmentNearest(seg, p.point); return ["t": num(r.t), "distance": num(r.distance)] })
            case "isStraightSegment": return .array(e.get("tolerances").a.map { .bool(isStraightSegment(seg, $0.n)) })
            case "solveMonotone":
                return .array(e.get("cases").a.map { c in num(solveMonotone(c.get("piece").segment, Int(c.get("axis").n), c.get("value").n)) })
            default: return unknown(fn)
            }
        }
    }

    // MARK: Paths

    func testPaths() {
        run("path") { fn, e in
            let input = BezierPathInput.svg(e["path"]?.stringValue ?? "")
            switch fn {
            case "toBezierPath": return enc(toBezierPath(input))
            case "pathToContours": return .array(pathToContours(input).map(enc))
            case "contoursToPath": return enc(contoursToPath(pathToContours(input)))
            case "closeContour": return .array(pathToContours(input).map { c in [encSegs(closeContour(c)), encSegs(closeContour(c, true))] })
            case "bezierPathToSvg":
                return .array(e.get("options").a.map { o in
                    let offset = o["offset"].flatMap { $0.objectValue == nil ? nil : PathPoint($0.get("x").n, $0.get("y").n) }
                    return .string(bezierPathToSvg(input, BezierPathToSvgOptions(precision: o["precision"]?.numberValue.map { Int($0) }, offset: offset)))
                })
            case "transformBezierPath":
                let m = e.get("matrix").a.map(\.n)
                return enc(transformBezierPath(input, (m[0], m[1], m[2], m[3], m[4], m[5])))
            case "countPathSegments":
                let c = countPathSegments(input)
                return ["lines": num(Double(c.lines)), "quads": num(Double(c.quads)), "cubics": num(Double(c.cubics))]
            case "bezierPathBounds": return enc(bezierPathBounds(input))
            case "bezierPathSignedArea": return num(bezierPathSignedArea(input))
            case "bezierPathLength": return num(bezierPathLength(input))
            case "bezierPathPointAtLength":
                return .array(e.get("lengths").a.map { l in
                    guard let r = bezierPathPointAtLength(input, l.n) else { return .null }
                    return [
                        "point": enc(r.point), "tangent": enc(r.tangent), "angle": num(r.angle),
                        "contour": num(Double(r.contour)), "segment": num(Double(r.segment)), "t": num(r.t),
                    ]
                })
            case "windingNumber":
                let chains = pathToContours(input).map { closeContour($0, true) }
                return .array(e.get("points").a.map { num(Double(windingNumber(chains, $0.point))) })
            case "pointInBezierPath":
                let rule = PolygonFillRule(rawValue: e.get("fillRule").s)!
                return .array(e.get("points").a.map { .bool(pointInBezierPath(input, $0.point, rule)) })
            case "distanceToBezierPath": return .array(e.get("points").a.map { num(distanceToBezierPath(input, $0.point)) })
            case "flattenChain":
                let tol = e.get("tolerance").n
                return .array(e.get("chains").a.map { c in .array(flattenChain(c.segments, tol).map(enc)) })
            case "trimSegments":
                return .array(e.get("chains").a.map { c in
                    .array(e.get("ranges").a.map { r in encSegs(trimSegments(c.segments, r.a[0].n, r.a[1].n)) })
                })
            case "arcToCubics":
                let c = e.get("cmd")
                return encSegs(arcToCubics(
                    e.get("from").point, rx: c.get("rx").n, ry: c.get("ry").n, rotation: c.get("rotation").n,
                    largeArc: c.get("largeArc").boolValue!, sweep: c.get("sweep").boolValue!, x: c.get("x").n, y: c.get("y").n
                ))
            default: return unknown(fn)
            }
        }
    }

    func testIntersections() {
        run("intersection") { fn, e in
            guard fn == "segmentIntersections" else { return unknown(fn) }
            let o = e["options"]
            let hits = segmentIntersections(e.get("a").segment, e.get("b").segment, epsilon: o?["epsilon"]?.numberValue, budget: o?["budget"]?.numberValue)
            return .array(hits.map { ["ta": num($0.ta), "tb": num($0.tb), "point": enc($0.point)] })
        }
    }

    // MARK: Booleans

    func testBooleans() {
        run("boolean") { fn, e in
            let operands = e["operands"]?.a.map(\.operand) ?? []
            switch fn {
            case "pathBoolean":
                let r = try pathBoolean(op(e), operands)
                return report(["path": enc(r.path)], r.report)
            case "pathBooleanRings":
                return .array(try pathBooleanRings(op(e), operands).map {
                    ["segments": encSegs($0.segments), "area": num($0.area), "parent": num(Double($0.parent))]
                })
            case "dividePaths":
                let r = try dividePaths(operands)
                return report(["pieces": .array(r.pieces.map { ["path": enc($0.path), "operands": ints($0.operands)] })], r.report)
            case "pathBooleanSelect":
                let selectors = e.get("selectors").a.map(selector)
                let r = try pathBooleanSelect(operands, selectors)
                return report(["parts": .array(r.parts.map { .array($0.map(enc)) })], r.report)
            case "normalizeBezierPath":
                return enc(try normalizeBezierPath(.svg(e.get("path").s), PolygonFillRule(rawValue: e.get("fillRule").s)!))
            case "bezierPathArea":
                return num(try bezierPathArea(.svg(e.get("path").s), PolygonFillRule(rawValue: e.get("fillRule").s)!))
            case "planarSplit":
                let inputs = e.get("inputs").a.map { $0.a.map(\.segments) }
                let r = try planarSplit(inputs)
                return [
                    "vertices": .array(r.vertices.map(enc)),
                    "edges": .array(r.edges.map {
                        ["a": num(Double($0.a)), "b": num(Double($0.b)), "pts": enc($0.pts), "operands": ints($0.operands),
                         "src": num(Double($0.src)), "sa": num($0.sa), "sb": num($0.sb)]
                    }),
                    "sources": encSegs(r.sources), "eps": num(r.eps), "scale": num(r.scale),
                ]
            default: return unknown(fn)
            }
        }
    }

    func testPolygons() {
        run("polygon") { fn, e in
            switch fn {
            case "polygonBoolean":
                let result = polygonBoolean(op(e), e.get("operands").a.map(\.polygonInput))
                return ["result": encMulti(result), "area": num(multiPolygonArea(result)), "bounds": enc(multiPolygonBounds(result))]
            case "dividePolygons":
                return .array(dividePolygons(e.get("operands").a.map(\.polygonInput)).map { ["polygon": encRings($0.polygon), "operands": ints($0.operands)] })
            case "ringSignedArea": return num(ringSignedArea(e.get("ring").ring))
            case "pointInRings":
                let rings = e.get("rings").a.map(\.ring)
                let rule = PolygonFillRule(rawValue: e.get("fillRule").s)!
                return .array(e.get("points").a.map { .bool(pointInRings($0.point, rings, rule)) })
            case "multiPolygonBounds":
                let input = e.get("input").a
                let isMulti = input.first?.a.first?.a.first?.arrayValue != nil
                return enc(isMulti ? multiPolygonBounds(input.map { $0.a.map(\.ring) }) : multiPolygonBounds(input.map(\.ring)))
            default: return unknown(fn)
            }
        }
    }

    // MARK: Strokes

    func testStrokes() {
        run("stroke") { fn, e in
            let input = BezierPathInput.svg(e.get("path").s)
            let o = e["options"] ?? .null
            switch fn {
            case "outlineStroke": return enc(try outlineStroke(input, strokeOptions(o)))
            case "strokeOutlineRings": return enc(strokeOutlineRings(input, strokeOptions(o)))
            case "dashContours":
                guard let r = dashContours(pathToContours(input), e.get("pattern").a.map(\.n), e["offset"]?.numberValue ?? 0) else { return .null }
                return ["contours": .array(r.contours.map(enc)), "dots": .array(r.dots.map { ["point": enc($0.point), "tangent": enc($0.tangent)] })]
            case "offsetPath":
                let options = OffsetPathOptions(
                    join: o["join"]?.stringValue.flatMap(StrokeJoin.init), miterLimit: o["miterLimit"]?.numberValue,
                    fillRule: o["fillRule"]?.stringValue.flatMap(PolygonFillRule.init)
                )
                return enc(try offsetPath(input, e.get("distance").n, options))
            default: return unknown(fn)
            }
        }
    }

    private func strokeOptions(_ o: JSONValue) -> OutlineStrokeOptions {
        OutlineStrokeOptions(
            width: o.get("width").n, join: o["join"]?.stringValue.flatMap(StrokeJoin.init), cap: o["cap"]?.stringValue.flatMap(StrokeCap.init),
            miterLimit: o["miterLimit"]?.numberValue, dash: o["dash"]?.a.map(\.n), dashOffset: o["dashOffset"]?.numberValue,
            tolerance: o["tolerance"]?.numberValue
        )
    }

    func testHatch() {
        run("hatch") { fn, e in
            guard fn == "hatchPath" else { return unknown(fn) }
            let o = e["options"] ?? .null
            return enc(hatchPath(.svg(e.get("path").s), HatchOptions(gap: o["gap"]?.numberValue, maxLines: o["maxLines"]?.numberValue)))
        }
    }

    // MARK: Curve fitting

    func testCurveFit() {
        run("curveFit") { fn, e in
            let points = e["points"]?.a.map(\.point) ?? []
            let o = e["options"] ?? .null
            switch fn {
            case "fitCubics":
                return .array(fitCubics(points, e.get("tolerance").n, FitCubicsOptions(cornerAngleDeg: o["cornerAngleDeg"]?.numberValue, closed: o["closed"]?.boolValue)).map(enc))
            case "fitCubicRun":
                return .array(fitCubicRun(points, e.get("tolerance").n, e["t0"]?.point, e["t1"]?.point).map(enc))
            case "fitCubicWithTangents":
                let r = fitCubicWithTangents(points, e.get("params").a.map(\.n), e.get("t0").point, e.get("t1").point)
                return ["curve": enc(r.curve), "error": num(r.error)]
            case "fitPathData": return .string(fitPathData(points, fitOptions(o)))
            case "fitFreehandPath": return .string(fitFreehandPath(points, fitOptions(o)))
            case "cubicPointAt":
                let c = e.get("cubic").cubic
                return .array(e.get("ts").a.map { enc(cubicPointAt(c, $0.n)) })
            case "isStraightCubic":
                let c = e.get("cubic").cubic
                return .array(e.get("tolerances").a.map { .bool(isStraightCubic(c, $0.n)) })
            case "cubicsToPathData":
                let options = CubicsToPathDataOptions(
                    precision: o["precision"]?.numberValue, offset: o["offset"].map { ($0.get("x").n, $0.get("y").n) },
                    closed: o["closed"]?.boolValue, straightTolerance: o["straightTolerance"]?.numberValue
                )
                return .string(cubicsToPathData(e.get("cubics").a.map(\.cubic), options))
            default: return unknown(fn)
            }
        }
    }

    private func fitOptions(_ o: JSONValue) -> FitPathDataOptions {
        FitPathDataOptions(
            cornerAngleDeg: o["cornerAngleDeg"]?.numberValue, closed: o["closed"]?.boolValue, tolerance: o["tolerance"]?.numberValue,
            precision: o["precision"]?.numberValue, offset: o["offset"].map { ($0.get("x").n, $0.get("y").n) }, noWorse: o["noWorse"]?.boolValue
        )
    }

    // MARK: Shapes

    func testShapes() {
        run("shape") { fn, e in
            let o = e["options"] ?? .null
            switch fn {
            case "parseSvgPath": return .array(parseSvgPath(e.get("d").s).map(encCommand))
            case "flattenSvgPath":
                return .array(flattenSvgPath(e.get("d").s, FlattenOptions(tolerance: o["tolerance"]?.numberValue, maxSegments: o["maxSegments"]?.numberValue)).map(encRing))
            case "shapeToPolygon":
                let s = e.get("shape")
                let radius: ShapeCornerRadius? = s["cornerRadius"].map { r in
                    if let a = r.arrayValue { return .corners(a[0].n, a[1].n, a[2].n, a[3].n) }
                    return .uniform(r.n)
                }
                let shape = ShapeDescription(
                    kind: ShapeKind(rawValue: s.get("kind").s)!, rotation: s["rotation"]?.numberValue, cornerRadius: radius,
                    sides: s["sides"]?.numberValue, points: s["points"]?.numberValue, innerRadius: s["innerRadius"]?.numberValue,
                    d: s["d"]?.stringValue ?? "", viewBox: s["viewBox"]?.a.map(\.n), fillRule: s["fillRule"]?.stringValue.flatMap(PolygonFillRule.init)
                )
                let size = e.get("size")
                let r = shapeToPolygon(shape, ShapeSize(width: size.get("width").n, height: size.get("height").n),
                                       FlattenOptions(tolerance: o["tolerance"]?.numberValue, maxSegments: o["maxSegments"]?.numberValue))
                return ["rings": .array(r.rings.map(encRing)), "fillRule": .string(r.fillRule.rawValue)]
            case "formatNumber":
                let p = e.get("precision").n
                return .array(e.get("values").a.map { .string(formatNumber($0.n, p)) })
            case "simplifyRing": return encRing(simplifyRing(e.get("ring").ring, e.get("tolerance").n))
            case "polygonToSvgPath":
                let options = PolygonToPathOptions(
                    precision: o["precision"]?.numberValue, simplify: o["simplify"]?.numberValue,
                    offset: o["offset"].map { ($0.get("x").n, $0.get("y").n) }, curves: o["curves"]?.stringValue.flatMap(PolygonToPathOptions.Curves.init),
                    curveTolerance: o["curveTolerance"]?.numberValue, cornerAngleDeg: o["cornerAngleDeg"]?.numberValue
                )
                let input = e.get("input").a
                let isMulti = input.first?.a.first?.a.first?.arrayValue != nil
                return .string(isMulti ? polygonToSvgPath(input.map { $0.a.map(\.ring) }, options) : polygonToSvgPath(input.map(\.ring), options))
            default: return unknown(fn)
            }
        }
    }

    // MARK: Connectors, helices and fitting text (#811, #813)

    private func vec2(_ v: JSONValue) -> Vec2 { Vec2(x: v.a[0].n, y: v.a[1].n) }
    private func encV(_ p: Vec2) -> JSONValue { [num(p.x), num(p.y)] }
    private func encConnector(_ c: Connector, level: Double? = nil) -> JSONValue {
        var o: JSONObject = [
            "d": .string(c.d), "length": num(c.length),
            "segments": .array(c.segments.map { s in
                s.kind == .line
                    ? ["kind": "line", "from": encV(s.from), "to": encV(s.to), "length": num(s.length)]
                    : ["kind": "arc", "from": encV(s.from), "to": encV(s.to), "center": encV(s.center!), "radius": num(s.radius), "sweep": num(Double(s.sweep)), "length": num(s.length)]
            })
        ]
        if let level { o["level"] = num(level) }
        return .object(o)
    }
    private func encRuns(_ runs: [HelixRun]) -> JSONValue {
        .array(runs.map { ["front": .bool($0.front), "points": .array($0.points.map(encV)), "d": .string($0.d), "from": num($0.from), "to": num($0.to), "length": num($0.length)] })
    }
    private func fixedMeasure(_ advance: Double) -> MeasureText {
        { word, size, spacing in Double(word.count) * size * advance + max(0, Double(word.count) - 1) * spacing }
    }

    func testConnectors() {
        run("connectors") { fn, e in
            let o = e["options"] ?? .null
            switch fn {
            case "roundedPolyline":
                return encConnector(roundedPolyline(e.get("points").a.map(vec2), e.get("radius").n))
            case "elbow":
                let el = elbow(vec2(e.get("from")), vec2(e.get("to")), level: o["level"]?.numberValue, radius: o["radius"]?.numberValue ?? 8,
                               axis: o["axis"]?.stringValue.flatMap(ElbowAxis.init) ?? .vertical)
                return encConnector(el.connector, level: el.level)
            case "fanElbows":
                let fan = fanElbows(vec2(e.get("root")), e.get("targets").a.map(vec2), gap: o["gap"]?.numberValue ?? 0, step: o["step"]?.numberValue ?? 12,
                                    radius: o["radius"]?.numberValue ?? 8, lead: o["lead"]?.numberValue ?? 16, axis: o["axis"]?.stringValue.flatMap(ElbowAxis.init) ?? .vertical)
                return ["elbows": .array(fan.elbows.map { encConnector($0.connector, level: $0.level) }), "levels": nums(fan.levels),
                        "starts": .array(fan.starts.map(encV)), "step": num(fan.step), "radius": num(fan.radius)]
            default: return unknown(fn)
            }
        }
    }

    func testHelix() {
        run("helix") { fn, e in
            switch fn {
            case "helix":
                let o = e.get("options")
                let axis = e.get("axis").a
                let h = helix((vec2(axis[0]), vec2(axis[1])), amplitude: o["amplitude"]?.numberValue ?? 12, turns: o["turns"]?.numberValue ?? 2,
                              phase: o["phase"]?.numberValue ?? 0, envelope: o["envelope"]?.stringValue.flatMap { HelixEnvelope(name: $0) } ?? .none,
                              samples: o["samples"]?.numberValue)
                return ["points": .array(h.points.map(encV)), "depth": nums(h.depth), "d": .string(h.d), "length": num(h.length), "runs": encRuns(splitByDepth(h.points, h.depth))]
            case "splitByDepth":
                return encRuns(splitByDepth(e.get("points").a.map(vec2), e.get("depth").a.map(\.n)))
            default: return unknown(fn)
            }
        }
    }

    func testFitText() {
        run("fitText") { fn, e in
            let o = e["options"] ?? .null
            let measure = fixedMeasure(e.get("advance").n)
            switch fn {
            case "fitText":
                let tracking = o["tracking"].map { (floor: $0.get("floor").n, step: $0["step"]?.numberValue ?? 0.01) }
                let r = try fitText(e.get("words").a.map(\.s), e.get("width").n, measure: measure, min: o["min"]?.numberValue ?? 8,
                                    max: o["max"]?.numberValue ?? 32, step: o["step"]?.numberValue ?? 0.5, tracking: tracking)
                return ["size": num(r.size), "letterSpacing": num(r.letterSpacing), "fits": .bool(r.fits), "word": r.word.map { .string($0) } ?? .null]
            case "staggerRows":
                let r = staggerRows(e.get("words").a.map(\.s), e.get("positions").a.map(\.n), measure: measure, size: o.get("size").n,
                                    letterSpacing: o["letterSpacing"]?.numberValue ?? 0, gap: o["gap"]?.numberValue ?? 4)
                return ["rows": .array(r.rows.map { num(Double($0)) }), "count": num(Double(r.count)), "fits": .bool(r.fits)]
            default: return unknown(fn)
            }
        }
    }

    #if canImport(CoreText)
    func testCoreTextMeasureFits() throws {
        let measure = coreTextMeasure(fontName: "Helvetica")
        let wide = measure("Category", 20, 0)
        XCTAssertGreaterThan(wide, measure("Category", 10, 0))
        XCTAssertLessThan(measure("Category", 20, -1), wide)
        let r = try fitText(["Tag", "Category"], 72, measure: measure)
        XCTAssertTrue(r.fits)
        XCTAssertEqual(r.word, "Category")
        XCTAssertLessThanOrEqual(measure("Category", r.size, 0), 72)
        XCTAssertGreaterThan(measure("Category", r.size + 0.5, 0), 72)
    }
    #endif

    // MARK: Planar map and Pathfinder

    func testPlanar() {
        run("planar") { fn, e in
            switch fn {
            case "PlanarMap":
                let inputs = e.get("inputs").a.map {
                    PlanarInput(path: .svg($0.get("path").s), fillRule: $0["fillRule"]?.stringValue.flatMap(PolygonFillRule.init), fills: $0["fills"]?.boolValue)
                }
                let o = e["options"] ?? .null
                guard let map = PlanarMap.build(inputs, PlanarMapOptions(gap: o["gap"]?.numberValue)) else { return .null }
                let faces = map.faces
                let points = e.get("points").a.map(\.point)
                return [
                    "vertices": .array(map.vertices.map(enc)), "eps": num(map.eps), "inputCount": num(Double(map.inputCount)),
                    "faces": .array(faces.map { ["path": enc($0.path), "area": num($0.area), "bounds": enc($0.bounds)] }),
                    "faceSources": .array(faces.indices.map { ints(map.faceSources($0)) }),
                    "faceInterior": .array(faces.indices.map { map.faceInterior($0).map(enc) ?? .null }),
                    "faceAt": .array(points.map { num(Double(map.faceAt($0))) }),
                    "mergeAll": enc(map.merge(Array(faces.indices))),
                    "mergeFirstTwo": enc(map.merge([0, 1])),
                    "chains": .array(map.chains().map { ["segments": encSegs($0.segments), "closed": .bool($0.closed), "source": num(Double($0.source))] }),
                    "regionAt": .array(points.map { map.regionAt($0).map(enc) ?? .null }),
                ]
            case "interiorPoint": return interiorPoint(.svg(e.get("path").s)).map(enc) ?? .null
            case "contourEnclosesArea": return .array(pathToContours(.svg(e.get("path").s)).map { .bool(contourEnclosesArea($0)) })
            case "cutOutPiece":
                let piece = e.get("piece")
                let r = cutOutPiece(.svg(e.get("path").s), segments: piece.get("segments").segments, closed: piece["closed"]?.boolValue ?? false,
                                    fillCloses: e.get("fillCloses").boolValue!, tol: e.get("tolerance").n)
                return r.map(enc) ?? .null
            default: return unknown(fn)
            }
        }
    }

    func testPathfinder() {
        run("pathfinder") { fn, e in
            guard fn == "pathfinder" else { return unknown(fn) }
            let shapes = e.get("shapes").a.map { s in
                PathfinderShape(
                    path: .svg(s.get("path").s), fillRule: s["fillRule"]?.stringValue.flatMap(PolygonFillRule.init),
                    key: s["key"].map { k in k.stringValue.map(PathfinderKey.string) ?? .number(k.n) }, line: s["line"]?.boolValue
                )
            }
            let r = try pathfinder(PathfinderOperation(rawValue: e.get("op").s)!, shapes)
            return report(["pieces": .array(r.pieces.map { p in
                var o: JSONObject = ["path": enc(p.path), "source": num(Double(p.source))]
                if let open = p.open { o["open"] = .bool(open) }
                return .object(o)
            })], r.report)
        }
    }

    // MARK: Helpers

    private func op(_ e: JSONValue) -> PolygonBooleanOperation { PolygonBooleanOperation(rawValue: e.get("op").s)! }

    private func unknown(_ fn: String) -> JSONValue? {
        XCTFail("no Swift check for \(fn)")
        return nil
    }

    /// A `pathBooleanSelect` selector spec: every given condition must hold.
    private func selector(_ spec: JSONValue) -> ([Int]) -> Bool {
        let includes = spec["includes"]?.a.map { Int($0.n) } ?? []
        let excludes = spec["excludes"]?.a.map { Int($0.n) } ?? []
        let minCount = spec["minCount"]?.numberValue.map { Int($0) } ?? 1
        let maxCount = spec["maxCount"]?.numberValue.map { Int($0) } ?? Int.max
        let top = spec["top"]?.numberValue.map { Int($0) }
        return { cov in
            includes.allSatisfy(cov.contains) && !excludes.contains(where: cov.contains) && cov.count >= minCount && cov.count <= maxCount
                && (top == nil || cov.last == top)
        }
    }

    private func report(_ fields: JSONObject, _ r: PathOpsReport) -> JSONValue {
        var o = fields
        o["engine"] = .string(r.engine.rawValue)
        if let f = r.fallbackReason { o["fallbackReason"] = .string(f) }
        if let err = r.error { o["error"] = .string(err) }
        return .object(o)
    }
}

// MARK: - Encoding (the fixture's shapes)

func num(_ n: Double) -> JSONValue {
    if n.isNaN { return "NaN" }
    if n.isInfinite { return n > 0 ? "Infinity" : "-Infinity" }
    return .number(n)
}
func nums(_ ns: [Double]) -> JSONValue { .array(ns.map(num)) }
func ints(_ ns: [Int]) -> JSONValue { .array(ns.map { num(Double($0)) }) }
func enc(_ p: PathPoint) -> JSONValue { [num(p[0]), num(p[1])] }
func enc(_ s: [PathPoint]) -> JSONValue { .array(s.map(enc)) }
func encRing(_ r: [PathPoint]) -> JSONValue { enc(r) }
func encSegs(_ s: [BezierSegment]) -> JSONValue { .array(s.map(enc)) }
func encRings(_ r: [[PathPoint]]) -> JSONValue { .array(r.map(enc)) }
func encMulti(_ m: MultiPolygon) -> JSONValue { .array(m.map(encRings)) }
func enc(_ c: BezierContour) -> JSONValue { ["segments": encSegs(c.segments), "closed": .bool(c.closed)] }
func enc(_ c: CubicSegment) -> JSONValue { [enc(c.p0), enc(c.p1), enc(c.p2), enc(c.p3)] }
func enc(_ b: PathBounds?) -> JSONValue {
    guard let b else { return .null }
    return ["minX": num(b.minX), "minY": num(b.minY), "maxX": num(b.maxX), "maxY": num(b.maxY)]
}
func enc(_ path: BezierPath) -> JSONValue {
    .array(path.map { c in
        switch c {
        case let .M(x, y): return ["M", num(x), num(y)]
        case let .L(x, y): return ["L", num(x), num(y)]
        case let .Q(x1, y1, x, y): return ["Q", num(x1), num(y1), num(x), num(y)]
        case let .C(x1, y1, x2, y2, x, y): return ["C", num(x1), num(y1), num(x2), num(y2), num(x), num(y)]
        case let .A(rx, ry, rot, l, s, x, y): return ["A", num(rx), num(ry), num(rot), .bool(l), .bool(s), num(x), num(y)]
        case .Z: return ["Z"]
        }
    })
}
func encCommand(_ c: PathCommand) -> JSONValue {
    switch c {
    case let .M(x, y): return ["type": "M", "x": num(x), "y": num(y)]
    case let .L(x, y): return ["type": "L", "x": num(x), "y": num(y)]
    case let .Q(x1, y1, x, y): return ["type": "Q", "x1": num(x1), "y1": num(y1), "x": num(x), "y": num(y)]
    case let .C(x1, y1, x2, y2, x, y): return ["type": "C", "x1": num(x1), "y1": num(y1), "x2": num(x2), "y2": num(y2), "x": num(x), "y": num(y)]
    case let .A(rx, ry, rot, l, s, x, y):
        return ["type": "A", "rx": num(rx), "ry": num(ry), "rotation": num(rot), "largeArc": .bool(l), "sweep": .bool(s), "x": num(x), "y": num(y)]
    case .Z: return ["type": "Z"]
    }
}

// MARK: - Decoding

extension JSONValue {
    func get(_ key: String) -> JSONValue { self[key] ?? .null }
    var n: Double {
        switch self {
        case .number(let v): return v
        case .string("NaN"): return .nan
        case .string("Infinity"): return .infinity
        case .string("-Infinity"): return -.infinity
        default: return .nan
        }
    }
    var s: String { stringValue! }
    var a: [JSONValue] { arrayValue! }
    var point: PathPoint { PathPoint(a[0].n, a[1].n) }
    var segment: BezierSegment { a.map(\.point) }
    var ring: [PathPoint] { a.map(\.point) }
    var segments: [BezierSegment] { a.map(\.segment) }
    var cubic: CubicSegment { CubicSegment(p0: a[0].point, p1: a[1].point, p2: a[2].point, p3: a[3].point) }
    var operand: PathOperand { PathOperand(.svg(get("path").s), fillRule: self["fillRule"]?.stringValue.flatMap(PolygonFillRule.init)) }
    var polygonInput: PolygonInput {
        if let rings = self["rings"] {
            return .operand(rings: rings.a.map(\.ring), fillRule: self["fillRule"]?.stringValue.flatMap(PolygonFillRule.init))
        }
        return .multi(a.map { $0.a.map(\.ring) })
    }
}
