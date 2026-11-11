import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// `packages/core/tests/pixel-effects.test.ts` ("compiling" and "evaluating"), the description and
/// provider, and the Metal renderer against the CPU one.
final class PixelLanguageTests: XCTestCase {
    private func issuesOf(_ source: String) -> (ok: Bool, issues: [String]) {
        let r = compilePixelSource(source)
        return (r.ok, r.issues.map { "\($0.severity)@\($0.line.map(String.init) ?? "undefined"): \($0.message)" })
    }

    private func px(_ source: String, _ w: Int = 2, _ h: Int = 2, _ time: Double = 0, _ values: JSONObject = [:]) -> [Int] {
        let r = compilePixelSource(source)
        guard let program = r.program else {
            XCTFail("\(r.issues)")
            return []
        }
        var out = [UInt8](repeating: 0, count: w * h * 4)
        createPixelEvaluator(program).render(width: w, height: h, timeMs: time, values: values, into: &out)
        return out.map(Int.init)
    }

    // MARK: compiling

    func testCompilesEveryTemplateWithNoIssues() {
        for t in PIXEL_TEMPLATES {
            let r = compilePixelSource(t.source)
            XCTAssertTrue(r.ok, t.id)
            XCTAssertEqual(r.issues, [], t.id)
        }
    }

    func testReadsControls() throws {
        let r = compilePixelSource("control speed: number = 1 range 0 4 // Turns a second.\ncontrol ink: color = #FF8800\ncontrol on: bool = true\ncontrol at: vec2 = vec2(0.5, -1) range -2 2\nout = vec4(ink * speed * on, at.x + at.y)")
        let p = try XCTUnwrap(r.program)
        XCTAssertEqual(p.controls.map(\.name), ["speed", "ink", "on", "at"])
        XCTAssertEqual(p.controls.map(\.type), [.number, .color, .bool, .vec2])
        XCTAssertEqual(p.controls.map(\.defaultValue), [1, "#ff8800", true, [0.5, -1]])
        XCTAssertEqual(p.controls.map(\.min), [0, nil, nil, -2])
        XCTAssertEqual(p.controls.map(\.max), [4, nil, nil, 2])
        XCTAssertEqual(p.controls.map(\.description), ["Turns a second.", "The ink control.", "The on control.", "The at control."])
    }

    func testReportsProblemsWithLinesAndWhatToDo() {
        func eq(_ src: String, _ ok: Bool, _ issues: [String], file: StaticString = #filePath, line: UInt = #line) {
            let r = issuesOf(src)
            XCTAssertEqual(r.ok, ok, src, file: file, line: line)
            XCTAssertEqual(r.issues, issues, src, file: file, line: line)
        }
        eq("let a = 1\nout = vec3(b)", false, ["error@2: there is no \"b\"; defined so far: a; built in: uv, pos, size, time, PI, TAU"])
        eq("out = uv + vec3(1)", false, ["error@1: can't use \"+\" on a vec2 and a vec3; make them the same size (e.g. with .xy or vec3(…))"])
        eq("let a = 1", false, ["error@1: nothing is drawn: end with a line such as out = vec3(uv, 0.5)"])
        eq("out = uv", false, ["error@1: out is a number (grey), a vec3 (colour) or a vec4 (colour and alpha), not a vec2"])
        XCTAssertEqual(issuesOf("out = vec3(uv.z)").issues, ["error@1: a vec2 has no \".z\"; it has .x .y"])
        XCTAssertEqual(issuesOf("control c: color = 3\nout = c").issues, ["error@1: a colour control's default is #rrggbb, not the number 3"])
        XCTAssertEqual(issuesOf("control n: number = 5 range 0 1\nout = vec3(n)").issues, ["error@1: the default 5 is outside range 0 1"])
        XCTAssertEqual(issuesOf("out = vec3(1)\nlet x = 2").issues, ["error@2: \"out = …\" must be the last line; move this line above line 1"])
        XCTAssertEqual(issuesOf("let sin = 1\nout = vec3(sin)").issues.first, "error@1: \"sin\" is a function; pick another name")
        XCTAssertEqual(issuesOf("out = vec3(1, 2)").issues, ["error@1: vec3 needs 3 parts in all (or one number for all), and these make 2"])
        XCTAssertEqual(issuesOf("out = noise(1)").issues, ["error@1: noise takes a vec2 (e.g. noise(uv * 8)), not a number"])
        XCTAssertEqual(issuesOf("out = vec3(1) $").issues, ["error@1: unexpected character \"$\""])
        eq("let a = (1 +\n 2)\nout = vec3(a)", true, [])
    }

    func testKeepsGoingAfterAnError() {
        XCTAssertEqual(issuesOf("let a = foo\nlet b = uv.q\nout = vec3(1)").issues, [
            "error@1: there is no \"foo\"; built in: uv, pos, size, time, PI, TAU",
            "error@2: \".q\" isn't a part of a vector; use up to four of x y z w (or r g b a)",
        ])
        // A later line using a name whose own line failed adds nothing more.
        XCTAssertEqual(issuesOf("let a = foo\nlet b = a\nout = vec3(b)").issues, ["error@1: there is no \"foo\"; built in: uv, pos, size, time, PI, TAU"])
    }

    func testWarnsAboutUnusedControlsAndLets() {
        let r = issuesOf("control a: number = 1\nlet b = 2\nout = vec3(0)")
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.issues, ["warning@1: control \"a\" isn't used", "warning@2: \"b\" isn't used"])
    }

    func testRefusesProgramsOverTheCostOrLengthLimit() {
        let heavy = "out = vec3(\(Array(repeating: "noise(uv)", count: 300).joined(separator: " + ")))"
        let r = compilePixelSource(heavy)
        XCTAssertFalse(r.ok)
        let m = r.issues.first?.message ?? ""
        XCTAssertNotNil(m.range(of: "^the program does \\d+ steps per pixel; the limit is 1024", options: .regularExpression), m)
        XCTAssertEqual(m, "the program does 1500 steps per pixel; the limit is 1024. Share work with let, or simplify")
        XCTAssertEqual(compilePixelSource("out = vec3(1)", limits: PixelLimits(maxSourceLength: 5)).issues.first?.message, "the source is 13 characters; the limit is 5")
        // UTF-16 code units, as JS `.length` counts them.
        XCTAssertEqual(compilePixelSource("// 🎨\nout = 1", limits: PixelLimits(maxSourceLength: 5)).issues.first?.message, "the source is 13 characters; the limit is 5")
    }

    func testIssueJSONAndText() {
        let r = compilePixelSource("out = vec3(q)")
        XCTAssertEqual(r.issues.map(\.json), [["severity": "error", "line": 1, "message": "there is no \"q\"; built in: uv, pos, size, time, PI, TAU"]])
        XCTAssertEqual(pixelIssueText(r.issues), "line 1: there is no \"q\"; built in: uv, pos, size, time, PI, TAU")
        XCTAssertEqual(pixelIssueText(compilePixelSource("out = 1", limits: PixelLimits(maxSourceLength: 2)).issues), "the source is 7 characters; the limit is 2")
    }

    // MARK: evaluating

    func testDrawsUVAsColourAtPixelCentres() {
        XCTAssertEqual(px("out = vec3(uv, 0)"), [64, 64, 0, 255, 191, 64, 0, 255, 64, 191, 0, 255, 191, 191, 0, 255])
    }

    func testGreyAlphaClampingAndNaN() {
        XCTAssertEqual(px("out = 0.5", 1, 1), [128, 128, 128, 255])
        XCTAssertEqual(px("out = vec4(2, -1, sqrt(-1), 0.25)", 1, 1), [255, 0, 0, 64])
        XCTAssertEqual(px("out = vec3(log(-1), 0, 0)", 1, 1), [0, 0, 0, 255])
    }

    func testUsesControlsTimeAndFunctions() {
        let src = "control c: color = #ff0000\ncontrol k: number = 1\nout = vec3(c.r * k, step(1, time), mod(-1, 3) / 4)"
        XCTAssertEqual(px(src, 1, 1, 0), [255, 0, 128, 255])
        XCTAssertEqual(px(src, 1, 1, 1000, ["k": 0.5, "c": "#808080"]), [64, 255, 128, 255])
        XCTAssertEqual(px("out = vec3(select(uv.x > 0.5, 1, 0), smoothstep(0, 1, 0.5), clamp(3, 0, 0.25))", 2, 1), [0, 128, 64, 255, 255, 128, 64, 255])
        XCTAssertEqual(px("out = vec3(length(vec2(3, 4)) / 10, dot(vec2(1), vec2(0.25)), normalize(vec2(0, 2)).y)", 1, 1), [128, 128, 255, 255])
        XCTAssertEqual(px("out = vec3(atan(1, 1) / PI * 4 - 0.5, pow(0.5, 2), -vec2(-0.5).x)", 1, 1), [128, 64, 128, 255])
    }

    func testHashAndNoiseAreFixedNumbers() {
        XCTAssertEqual(pixelHash(0, 0), 0)
        XCTAssertEqual(pixelHash(1, 0), 0.2367340091150254)
        XCTAssertEqual(pixelHash(-2, 5), 0.1857259776443243)
        XCTAssertEqual(pixelHash(-3.5, 7.25), pixelHash(-4, 7), accuracy: 1e-12)
        XCTAssertEqual(pixelNoise(0.5, 0.5), (pixelHash(0, 0) + pixelHash(1, 0) + pixelHash(0, 1) + pixelHash(1, 1)) / 4, accuracy: 1e-12)
        XCTAssertEqual(pixelHash(1e12, -1e12), pixelHash(1e9, -1e9))
        XCTAssertEqual(pixelHash(.nan, .nan), 0)
    }

    /// The templates at 5×3, 1234 ms, as the TS evaluator draws them.
    func testTemplatesDrawTheTSPixels() throws {
        let expected: [String: [Int]] = [
            "pixel.blank": [67, 56, 97, 255, 67, 56, 97, 255, 67, 56, 97, 255, 67, 56, 97, 255, 67, 56, 97, 255, 142, 81, 126, 255, 142, 81, 126, 255, 142, 81, 126, 255, 142, 81, 126, 255, 142, 81, 126, 255, 217, 106, 154, 255, 217, 106, 154, 255, 217, 106, 154, 255, 217, 106, 154, 255, 217, 106, 154, 255],
            "pixel.rings": [29, 43, 83, 0, 29, 43, 83, 255, 29, 43, 83, 255, 29, 43, 83, 255, 29, 43, 83, 0, 29, 43, 83, 255, 29, 43, 83, 0, 29, 43, 83, 255, 29, 43, 83, 0, 29, 43, 83, 255, 29, 43, 83, 0, 29, 43, 83, 255, 29, 43, 83, 255, 29, 43, 83, 255, 29, 43, 83, 0],
            "pixel.clouds": [58, 110, 165, 255, 58, 110, 165, 255, 58, 110, 165, 255, 61, 112, 166, 255, 58, 110, 165, 255, 241, 241, 243, 255, 58, 110, 165, 255, 61, 112, 166, 255, 58, 110, 165, 255, 58, 110, 165, 255, 84, 129, 176, 255, 99, 139, 182, 255, 58, 110, 165, 255, 121, 155, 192, 255, 87, 131, 177, 255],
        ]
        for t in PIXEL_TEMPLATES {
            XCTAssertEqual(px(t.source, 5, 3, 1234), expected[t.id], t.id)
        }
    }

    // MARK: description and provider

    func testRingsDescriptionMatchesTS() async throws {
        let expected = try JSONValue.parse(##"{"id":"pixel.rings","name":"Rings","kind":"shader","category":"authored","uses":["generator"],"description":"Rings that spread from a point, over a transparent background.","tags":["authored","pixel"],"transparent":true,"loop":true,"duration":2000,"controls":{"type":"object","properties":{"ink":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Colour of the rings. (#rrggbb)"},"count":{"type":"number","description":"How many rings across the picture.","minimum":1,"maximum":64},"center":{"type":"array","description":"Where they spread from (0..1). ([x, y])","minItems":2,"maxItems":2,"items":{"type":"number","description":"x or y.","minimum":0,"maximum":1}}},"additionalProperties":false},"defaults":{"ink":"#1d2b53","count":12,"center":[0.5,0.5]},"presets":[],"inputs":[]}"##)
        let provider = PixelEffectProvider()
        let d = try await provider.describe("pixel.rings")
        XCTAssertEqual(JSONValue.object(d.json), expected)
        XCTAssertEqual(JSONValue.object(d.json).stringified(), expected.stringified())
        let t = try XCTUnwrap(pixelTemplate("pixel.rings"))
        XCTAssertEqual(describePixelSource(t.source, meta: t.meta).description?.json, d.json)
    }

    func testProviderCatalog() async throws {
        let provider = PixelEffectProvider()
        XCTAssertEqual(provider.id, "pixel")
        XCTAssertEqual(provider.name, "Pixel expressions")
        XCTAssertEqual(JSONValue.object(provider.capabilities).stringified(), #"{"supportsWorker":false,"supportsFloat":false,"supportsMask":false,"supportsHostImages":false,"supportsVector":false,"supportsAuthoring":true,"maxSize":8192}"#)
        let list = try await provider.list()
        XCTAssertEqual(JSONValue.array(list.map { .object($0.json) }).stringified(), #"[{"id":"pixel.blank","name":"Blank","kind":"shader","category":"authored","uses":["generator"],"description":"A starting point: a soft gradient between two colours, top to bottom.","tags":["authored","pixel"],"transparent":false,"loop":false},{"id":"pixel.rings","name":"Rings","kind":"shader","category":"authored","uses":["generator"],"description":"Rings that spread from a point, over a transparent background.","tags":["authored","pixel"],"transparent":true,"loop":true,"duration":2000},{"id":"pixel.clouds","name":"Clouds","kind":"shader","category":"authored","uses":["generator"],"description":"Soft value-noise clouds drifting sideways.","tags":["authored","pixel"],"transparent":false,"loop":false,"duration":4000}]"#)
        let found = try await provider.search("cloud", EffectSearchOptions())
        XCTAssertEqual(found.map(\.id), ["pixel.clouds"])
        do {
            _ = try await provider.describe("pixel.nope")
            XCTFail("expected unknown_effect")
        } catch let e as EffectError {
            XCTAssertEqual(e.code, "unknown_effect")
            XCTAssertEqual(e.message, "Unknown effect \"pixel.nope\" in Pixel expressions. Call search_effects or list() for valid ids.")
        }
        let r = try provider.createRenderer("pixel.blank", width: 1, height: 3) as! PixelCPURenderer
        XCTAssertEqual(try r.renderSync(EffectRenderRequest(values: ["top": "#000000", "bottom": "#ffffff"])).data, [43, 43, 43, 255, 128, 128, 128, 255, 213, 213, 213, 255])
        XCTAssertThrowsError(try r.renderSync(EffectRenderRequest(values: ["top": 3]))) { XCTAssertEqual(($0 as? EffectError)?.code, "invalid_values") }
        r.dispose()
        XCTAssertThrowsError(try r.renderSync(EffectRenderRequest())) { XCTAssertEqual(($0 as? EffectError)?.code, "disposed") }
    }

    // MARK: Metal

    /// A program calling every function (inputs kept away from integer and branch edges, where float and double could disagree).
    static let everyFunction = """
    control tint: color = #3366cc // Tint.
    control k: number = 0.7 range 0 1 // Amount.
    control on: bool = true // On.
    control at: vec2 = vec2(0.3, 0.6) // A point.
    let q = uv * 0.9 + 0.05
    let a = sin(q.x * 3) * 0.25 + cos(q.y * 2) * 0.25 + tan(q.x * 0.5) * 0.1 + asin(q.y * 0.5) * 0.2 + acos(q.x * 0.5) * 0.1
    let b = atan(q.y) * 0.3 + atan(q.y, q.x + 0.1) * 0.1 + sqrt(q.x) * 0.2 + sqrt(-q.x) + exp(-q.y) * 0.2 + log(q.x + 1) * 0.3
    let c = abs(q.x - 0.5) + sign(q.y - 0.53) * 0.1 + floor(q.x * 3 + 0.01) * 0.1 + ceil(q.y * 2 + 0.01) * 0.1 + fract(q.x * 2.5 + 0.01) * 0.2
    let e = pow(q.x, 2) + pow(-0.5, 2) + mod(q.y * 7 + 0.01, 2) * 0.1 + (q.x * 5 + 0.01) % 1.5 * 0.1 + min(q.x, q.y) + max(q.x, q.y) * 0.5
    let f = clamp(q.x * 2 - 0.5, 0, 1) * 0.3 + mix(0.1, 0.9, q.y) * 0.3 + step(0.47, q.x) * 0.1 + smoothstep(0.2, 0.8, q.y) * 0.3
    let g = select(q.x > 0.47, 0.2, 0.8) + select(on, 0.1, 0.0) + length(q - at) + distance(q, at) * 0.5 + dot(q, at)
    let n = normalize(vec3(q, 0.5)) + normalize(vec3(0)) + vec3(hash(pos * 0.25), noise(uv * 5.3), hash(vec2(3.5, -2.5)))
    let cmp = (q.x < 0.47) * 0.1 + (q.x <= 0.47) * 0.1 + (q.y > 0.53) * 0.1 + (q.y >= 0.53) * 0.1 + (on == 1) * 0.1 + (on != 1) * 0.1
    let v = vec4(vec2(a, b).yx, vec2(c + e * 0.1, f)) * k + vec4(-g * 0.1 + cmp, n.zyx) * 0.5
    out = vec4(tint * 0.2 + v.xyz * 0.8 + size.x * 0 + time * 0 + PI * 0 + TAU * 0, v.w + 0.3)
    """

    private func assertGPUMatchesCPU(_ source: String, _ name: String, width: Int = 37, height: Int = 23, time: Double = 1234) throws {
        #if canImport(Metal)
        let r = compilePixelSource(source)
        let program = try XCTUnwrap(r.program, "\(name): \(r.issues)")
        let d = pixelDescription(program: program, meta: PixelEffectMeta(id: name, name: name))
        let cpu = try PixelCPURenderer(program: program, description: d, width: width, height: height).renderSync(EffectRenderRequest(time: time))
        let gpuRenderer: PixelMetalRenderer
        do {
            gpuRenderer = try PixelMetalRenderer(program: program, description: d, width: width, height: height)
        } catch {
            XCTFail("\(name): \(error)\n\(pixelMSL(program).source)")
            return
        }
        let gpu = try gpuRenderer.renderSync(EffectRenderRequest(time: time))
        XCTAssertEqual(gpu.data.count, cpu.data.count)
        var worst = 0, at = -1
        for i in 0..<cpu.data.count {
            let diff = abs(Int(cpu.data[i]) - Int(gpu.data[i]))
            if diff > worst { worst = diff; at = i }
        }
        XCTAssertLessThanOrEqual(worst, 2, "\(name): channel \(at) is \(at >= 0 ? gpu.data[at] : 0) on the GPU, \(at >= 0 ? cpu.data[at] : 0) on the CPU")
        #else
        throw XCTSkip("No Metal here.")
        #endif
    }

    func testMetalMatchesCPU() throws {
        guard PixelGPU.isAvailable else { throw XCTSkip("No Metal device.") }
        for t in PIXEL_TEMPLATES { try assertGPUMatchesCPU(t.source, t.id) }
        XCTAssertEqual(compilePixelSource(Self.everyFunction).issues, [])
        try assertGPUMatchesCPU(Self.everyFunction, "every-function")
        // The program really reaches every function.
        let msl = pixelMSL(try XCTUnwrap(compilePixelSource(Self.everyFunction).program)).source
        let body = msl.components(separatedBy: "kernel void")[1]
        for f in ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "exp", "log", "abs", "sign", "floor", "ceil", "fract", "pow", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "hash", "noise"] {
            XCTAssertTrue(body.contains("px_\(f)("), f)
        }
    }

    func testMetalRendererUsesControlsAndRefusesBadValues() throws {
        #if canImport(Metal)
        guard PixelGPU.isAvailable else { throw XCTSkip("No Metal device.") }
        let t = try XCTUnwrap(pixelTemplate("pixel.blank"))
        let r = describePixelSource(t.source, meta: t.meta)
        let gpu = try PixelMetalRenderer(program: r.program!, description: r.description!, width: 1, height: 3)
        XCTAssertEqual(try gpu.renderSync(EffectRenderRequest(values: ["top": "#000000", "bottom": "#ffffff"])).data, [43, 43, 43, 255, 128, 128, 128, 255, 213, 213, 213, 255])
        XCTAssertThrowsError(try gpu.renderSync(EffectRenderRequest(values: ["top": 3]))) { XCTAssertEqual(($0 as? EffectError)?.code, "invalid_values") }
        // A budget of 0 ms can't compile a new kernel. The source differs on every run: Metal keeps
        // compiled libraries in an on-disk cache across processes and returns a cached one at once.
        let fresh = compilePixelSource("out = vec3(uv.x * \(UInt32.random(in: 1...UInt32.max)) / 4294967296, 0, 0)").program!
        XCTAssertThrowsError(try PixelMetalRenderer(program: fresh, description: pixelDescription(program: fresh, meta: PixelEffectMeta(id: "x", name: "x")), width: 1, height: 1, compileTimeoutMs: 0)) {
            XCTAssertTrue((($0 as? EffectError)?.message ?? "").contains("took longer than 0 ms to compile"), "\($0)")
        }
        #else
        throw XCTSkip("No Metal here.")
        #endif
    }
}
