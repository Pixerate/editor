import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// `sample(p)` in pixel expressions (#754): `packages/core/tests/pixel-effects.test.ts`
/// ("sample (filters)"), vectors recorded from the TS evaluator, and the Metal kernel against the CPU.
final class PixelSampleTests: XCTestCase {
    /// 5×4, a pattern with varied alpha (every fourth pixel transparent), as in the TS vectors.
    private static let source = EffectPixels(width: 5, height: 4, data: [
        0, 31, 7, 40, 53, 128, 158, 107, 106, 225, 53, 174, 159, 66, 204, 0, 212, 163, 99, 52, 9, 4, 250, 119, 62, 101, 145, 186, 115, 198, 40, 0,
        168, 39, 191, 64, 221, 136, 86, 131, 18, 233, 237, 198, 71, 74, 132, 0, 124, 171, 27, 76, 177, 12, 178, 143, 230, 109, 73, 210, 27, 206, 224, 0,
        80, 47, 119, 88, 133, 144, 14, 155, 186, 241, 165, 222, 239, 82, 60, 0,
    ])

    private static let filter = """
    control k: number = 1.5 // Reach in pixels.
    let c = sample(uv)
    let l = sample(uv - vec2(k, 0.25) / size)
    let r = sample(uv + vec2(k * 0.7, -0.5) / size)
    let far = sample(uv * 3 - 1)
    out = vec4(mix(c.rgb, (l.rgb + r.rgb) * 0.5, 0.6) + far.rgb * 0.1, max(c.a, far.a * 0.5))
    """

    /// 2×2: opaque red, opaque green / transparent, half-transparent blue.
    private static let small = EffectPixels(width: 2, height: 2, data: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 128])

    private func issuesOf(_ source: String) -> [String] {
        compilePixelSource(source).issues.map { "\($0.severity)@\($0.line.map(String.init) ?? "undefined"): \($0.message)" }
    }

    private func sampled(_ source: String, _ w: Int, _ h: Int, _ src: EffectPixels?, _ values: JSONObject = [:]) throws -> [Int] {
        let r = compilePixelSource(source)
        let program = try XCTUnwrap(r.program, "\(r.issues)")
        var out = [UInt8](repeating: 0, count: w * h * 4)
        createPixelEvaluator(program).render(width: w, height: h, timeMs: 0, values: values, into: &out, source: src)
        return out.map(Int.init)
    }

    private func at(_ src: EffectPixels?, _ x: Double, _ y: Double) -> [Double] {
        var v: [Double] = [0, 0, 0, 0]
        v.withUnsafeMutableBufferPointer { (b: inout UnsafeMutableBufferPointer<Double>) in pixelSample(src, x, y, into: b.baseAddress!) }
        return v
    }

    func testReadsTheSourceAtPixelCentresExactly() throws {
        XCTAssertEqual(try sampled("out = sample(uv)", 2, 2, Self.small), Self.small.data.map(Int.init))
        XCTAssertEqual(try sampled("out = sample(uv)", 1, 1, Self.small), [102, 102, 51, 160])
        XCTAssertEqual(try sampled("out = sample(uv)", 1, 1, nil), [0, 0, 0, 0])
    }

    func testBilinearWeightedByAlphaAndClampedToTheEdge() {
        XCTAssertEqual(at(Self.small, 0.5, 0.25), [0.5, 0.5, 0, 1])
        XCTAssertEqual(at(Self.small, 0.25, 0.5), [1, 0, 0, 0.5])
        XCTAssertEqual(at(Self.small, -3, -3), [1, 0, 0, 1])
        XCTAssertEqual(at(Self.small, 9, -1), [0, 1, 0, 1])
        XCTAssertEqual(at(Self.small, .nan, 0.25), [1, 0, 0, 1])
        XCTAssertEqual(at(Self.small, .infinity, .infinity), [0, 0, 1, 128.0 / 255])
        XCTAssertEqual(at(EffectPixels(width: 1, height: 1, data: [9, 9, 9, 0]), 0.5, 0.5), [0, 0, 0, 0])
        XCTAssertEqual(at(nil, 0.5, 0.5), [0, 0, 0, 0])
    }

    /// `pixelSample` at these points, as the TS evaluator gives them.
    func testSamplesMatchTheTSNumbers() {
        let expected: [(Double, Double, [Double])] = [
            (0.5, 0.5, [0.48627450980392156, 0.6705882352941176, 0.10588235294117647, 0.14901960784313725]),
            (0.13, 0.71, [0.08003045878545591, 0.8853988197220636, 0.9114410812868837, 0.45320000000000005]),
            (-0.2, 0.4, [0.04080100125156446, 0.15580586844666958, 0.9724377694340149, 0.49764705882352944]),
            (1.3, 1.1, [0, 0, 0, 0]),
            (0.31, 0.06, [0.2242295014970193, 0.5319509226436383, 0.5871442913368338, 0.4327450980392157]),
            (.nan, 0.5, [0.05733902393765077, 0.5766066679037546, 0.9485495144430012, 0.6215686274509804]),
            (0.77, 0.93, [0.7294117647058825, 0.9450980392156866, 0.6470588235294119, 0.5658823529411763]),
        ]
        for (x, y, want) in expected { XCTAssertEqual(at(Self.source, x, y), want, "\(x), \(y)") }
    }

    /// A filter at 7×5 over the 5×4 picture with `k` 2.25, byte for byte as the TS evaluator draws it.
    func testFilterDrawsTheTSPixels() throws {
        let expected: [Int] = [
            16, 63, 53, 40, 45, 116, 75, 78, 61, 146, 65, 126, 127, 189, 87, 174, 146, 198, 103, 50, 200, 194, 99, 26, 201, 198, 95, 52, 22, 44, 191, 95,
            47, 94, 151, 134, 62, 116, 132, 131, 119, 156, 123, 87, 163, 134, 141, 47, 195, 161, 111, 72, 211, 168, 101, 107, 30, 133, 238, 159, 40, 128,
            217, 121, 83, 104, 199, 79, 126, 132, 126, 38, 174, 95, 143, 85, 198, 121, 111, 132, 229, 115, 111, 170, 29, 199, 214, 139, 53, 197, 168, 74,
            95, 139, 130, 47, 126, 155, 128, 100, 167, 109, 104, 148, 186, 125, 83, 158, 209, 102, 89, 147, 29, 85, 107, 0, 74, 128, 129, 50, 94, 156,
            130, 107, 141, 158, 102, 155, 160, 149, 115, 203, 182, 170, 96, 127, 119, 91, 55, 0,
        ]
        XCTAssertEqual(try sampled(Self.filter, 7, 5, Self.source, ["k": 2.25]), expected)
    }

    func testChecksItsArgumentCountsFourStepsAndMakesAFilter() throws {
        XCTAssertEqual(issuesOf("out = sample(uv.x)"), ["error@1: sample takes a vec2 in uv (e.g. sample(uv) or sample(uv + vec2(1, 0) / size)), not a number"])
        XCTAssertEqual(issuesOf("out = sample(uv, uv)"), ["error@1: sample takes 1 argument, not 2"])
        XCTAssertEqual(issuesOf("out = sample()"), ["error@1: sample takes 1 argument, not 0"])
        XCTAssertEqual(issuesOf("out = sample"), ["error@1: sample is a function; call it, e.g. sample(…)"])
        XCTAssertEqual(
            issuesOf("out = vec3(toString(1))"),
            ["error@1: there is no function \"toString\"; the functions are sin, cos, tan, asin, acos, atan, sqrt, exp, log, abs, sign, floor, ceil, fract, pow, mod, min, max, clamp, mix, step, smoothstep, select, length, distance, dot, normalize, hash, noise, sample, vec2, vec3, vec4"]
        )
        let program = try XCTUnwrap(compilePixelSource("let c = sample(uv)\nout = c").program)
        XCTAssertEqual(program.cost, 4)
        XCTAssertTrue(pixelProgramSamples(program))
        XCTAssertFalse(pixelProgramSamples(try XCTUnwrap(compilePixelSource("out = vec3(uv, 0)").program)))
        let heavy = "out = " + Array(repeating: "sample(uv)", count: 257).joined(separator: " + ")
        XCTAssertTrue(compilePixelSource(heavy).issues.first?.message.hasPrefix("the program does 1284 steps per pixel; the limit is 1024") ?? false)
    }

    func testAnEffectThatSamplesIsAFilterWithASourceInput() throws {
        let t = try XCTUnwrap(pixelTemplate("pixel.blank"))
        let source = "control amount: number = 1 range 0 1 // How far to invert.\nlet c = sample(uv)\nout = vec4(mix(c.rgb, 1 - c.rgb, amount), c.a)"
        let r = describePixelSource(source, meta: t.meta)
        let d = try XCTUnwrap(r.description)
        XCTAssertEqual(d.uses, ["filter"])
        XCTAssertEqual(d.json["inputs"], .array([.object(PIXEL_SOURCE_INPUT)]))
        XCTAssertNil(d.json["paint"])
        let cpu = PixelCPURenderer(program: try XCTUnwrap(r.program), description: d, width: 2, height: 2)
        XCTAssertEqual(Array(try cpu.renderSync(EffectRenderRequest(inputs: ["source": Self.small])).data.prefix(4)), [0, 255, 255, 255])
        XCTAssertEqual(Array(try cpu.renderSync(EffectRenderRequest()).data.prefix(4)), [255, 255, 255, 0])
        // A generator keeps its paint hint and has no inputs.
        let g = try XCTUnwrap(describePixelSource(t.source, meta: t.meta).description)
        XCTAssertEqual(g.uses, ["generator"])
        XCTAssertEqual(g.json["inputs"], .array([]))
        XCTAssertNotNil(g.json["paint"])
    }

    func testMetalSampleMatchesCPU() throws {
        #if canImport(Metal)
        guard PixelGPU.isAvailable else { throw XCTSkip("No Metal device.") }
        let program = try XCTUnwrap(compilePixelSource(Self.filter).program)
        let msl = pixelMSL(program)
        XCTAssertNotNil(msl.sourceSizeOffset)
        XCTAssertTrue(msl.source.contains("px_sample(src,"))
        XCTAssertNil(pixelMSL(try XCTUnwrap(compilePixelSource("out = vec3(uv, 0)").program)).sourceSizeOffset)
        let d = pixelDescription(program: program, meta: PixelEffectMeta(id: "sample", name: "Sample"))
        // A picture with soft alpha edges, larger than the output and smaller, and none at all.
        func picture(_ w: Int, _ h: Int) -> EffectPixels {
            var data: [UInt8] = []
            for y in 0..<h {
                for x in 0..<w {
                    let i: Int = y * w + x
                    data += [UInt8((i * 53) % 256), UInt8((i * 97 + 31) % 256), UInt8((i * 151 + 7) % 256), i % 5 == 3 ? 0 : UInt8((i * 67 + 40) % 256)]
                }
            }
            return EffectPixels(width: w, height: h, data: data)
        }
        for src in [picture(53, 31), picture(9, 7), Self.source, nil] as [EffectPixels?] {
            let request = EffectRenderRequest(time: 0, values: ["k": 2.25], inputs: src.map { ["source": $0] } ?? [:])
            let cpu = try PixelCPURenderer(program: program, description: d, width: 37, height: 23).renderSync(request)
            let gpu = try PixelMetalRenderer(program: program, description: d, width: 37, height: 23, compileTimeoutMs: gpuParityCompileTimeoutMs).renderSync(request)
            var worst = 0, at = -1
            for i in 0..<cpu.data.count {
                let diff = abs(Int(cpu.data[i]) - Int(gpu.data[i]))
                if diff > worst { worst = diff; at = i }
            }
            XCTAssertLessThanOrEqual(worst, 2, "source \(src.map { "\($0.width)×\($0.height)" } ?? "none"): channel \(at) is \(at >= 0 ? gpu.data[at] : 0) on the GPU, \(at >= 0 ? cpu.data[at] : 0) on the CPU")
        }
        #else
        throw XCTSkip("No Metal here.")
        #endif
    }
}
