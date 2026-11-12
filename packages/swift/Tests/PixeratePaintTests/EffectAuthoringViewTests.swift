import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// `effect_authoring_view` in the paint editor (`effects/authoring-tools.ts` `viewTool` with the paint provider's capture): a preview frame as an image block.
final class EffectAuthoringViewTests: XCTestCase {
    private func setup(width: Double = 48, height: Double = 32) throws -> (c: PaintEditorController, registry: ToolRegistry) {
        let c = try PaintEditorController(width: width, height: height, authoredEffects: .author)
        c.authoredEffectsGPU = false
        c.setEffectsProvider(FakeEffectProvider())
        let r = ToolRegistry(validateArguments: true)
        _ = try r.register(createPaintEffectAuthoringToolProvider(c))
        return (c, r)
    }

    private func image(_ r: McpToolResult) -> (data: String, mimeType: String)? {
        for case .image(let data, let mimeType) in r.content { return (data, mimeType) }
        return nil
    }

    func testIsListedFromTheContract() throws {
        let t = try setup()
        let tool = t.registry.listTools().first { $0.name.hasSuffix("effect_authoring_view") }
        XCTAssertNotNil(tool, "the paint authoring provider captures previews")
        XCTAssertEqual(tool?.annotations?.readOnlyHint, true)
        XCTAssertEqual(tool?.title, "View effect preview image")
        XCTAssertTrue(effectAuthoringToolNames(EffectAuthoringToolHost(session: { nil }, capture: { "" })).contains("effect_authoring_view"))
        XCTAssertFalse(effectAuthoringToolNames(EffectAuthoringToolHost(session: { nil })).contains("effect_authoring_view"), "no capture, no view tool")
    }

    func testRefusesWithoutASession() async throws {
        let t = try setup()
        let r = await t.registry.callTool("effect_authoring_view", [:])
        XCTAssertTrue(r.isError)
        XCTAssertEqual(r.text, PAINT_NO_AUTHORING_SESSION)
    }

    func testCapturesAPNGAtThePlayheadOrAtTime() async throws {
        let t = try setup()
        _ = try await t.c.openEffectAuthoring("pixel.rings")
        let r = await t.registry.callTool("effect_authoring_view", ["time": 750])
        XCTAssertFalse(r.isError, r.text ?? "")
        XCTAssertEqual(r.text, "Captured effect preview at 750ms.")
        XCTAssertEqual(t.c.authoringSession?.getState().time, 750, "time moves the playhead first")
        let png = try XCTUnwrap(image(r))
        XCTAssertEqual(png.mimeType, "image/png")
        let bytes = try XCTUnwrap(Data(base64Encoded: png.data))
        let decoded = try decodePng([UInt8](bytes))
        XCTAssertEqual(decoded.width, 48)
        XCTAssertEqual(decoded.height, 32)
        XCTAssertTrue(stride(from: 3, to: decoded.data.count, by: 4).contains { decoded.data[$0] > 0 }, "the rings draw something")

        t.c.authoringSession?.seek(250)
        let again = await t.registry.callTool("effect_authoring_view", [:])
        XCTAssertEqual(again.text, "Captured effect preview at 250ms.")
    }

    func testRefusesABadTime() async throws {
        let t = try setup()
        _ = try await t.c.openEffectAuthoring("pixel.blank")
        let negative = await t.registry.callTool("effect_authoring_view", ["time": -1])
        XCTAssertTrue(negative.isError)
        let handler = effectAuthoringViewHandler(host: EffectAuthoringToolHost(session: { t.c.authoringSession }, capture: { "data:image/png;base64,AAAA" }))
        do {
            _ = try await handler(["time": .string("soon")])
            XCTFail("a time that is not a number is refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, "time must be a finite non-negative number.")
        }
    }

    func testRefusesAHostThatCannotCapture() async throws {
        let t = try setup()
        _ = try await t.c.openEffectAuthoring("pixel.blank")
        let handler = effectAuthoringViewHandler(host: EffectAuthoringToolHost(session: { t.c.authoringSession }))
        do {
            _ = try await handler([:])
            XCTFail("no capture")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Capturing a preview image is not supported by this host.")
        }
    }

    func testRefusesWithThePreviewErrorOfAVectorEffect() async throws {
        let t = try setup()
        _ = try await t.c.openEffectAuthoring("fake.badge")
        let first = await t.registry.callTool("effect_authoring_view", [:])
        XCTAssertTrue(first.isError, "a vector effect draws no pixels")
        let previewError = try XCTUnwrap(t.c.authoringSession?.getState().previewError)
        XCTAssertTrue(previewError.hasPrefix("No pixel preview for this vector effect"), previewError)
        let second = await t.registry.callTool("effect_authoring_view", [:])
        XCTAssertEqual(second.text, "\(previewError) The other effect authoring tools still work; check values with effect_authoring_describe.")
    }

    func testCapturesAtThePaintingsAspect() {
        XCTAssertTrue(paintAuthoringViewSize(width: 48, height: 32) == (48, 32), "never larger than the painting")
        XCTAssertTrue(paintAuthoringViewSize(width: 1024, height: 768) == (256, 192))
        XCTAssertTrue(paintAuthoringViewSize(width: 300, height: 1000) == (77, 256), "rounded as Math.round")
        XCTAssertTrue(paintAuthoringViewSize(width: 4000, height: 2) == (256, 1), "at least a pixel")
    }

    func testSplitsDataUrlsAsTheTSToolDoes() {
        XCTAssertTrue(splitImageDataUrl("data:image/png;base64,QUJD") == ("QUJD", "image/png"))
        XCTAssertTrue(splitImageDataUrl("data:image/webp;base64,QUJD") == ("QUJD", "image/webp"))
        XCTAssertTrue(splitImageDataUrl("data:text/plain;base64,QUJD") == ("QUJD", "image/png"))
        XCTAssertTrue(splitImageDataUrl("QUJD") == ("QUJD", "image/png"))
    }

    func testSamplePicturesMatchTheTSCore() {
        let p = effectSamplePicture(width: 4, height: 2)
        // effectSamplePicture(4, 2) in the TS core: the first row.
        XCTAssertEqual(Array(p.data[0..<16]), [40, 80, 200, 255, 107, 80, 190, 255, 173, 80, 120, 255, 240, 80, 80, 255])
        let to = effectSamplePicture(width: 4, height: 2, variant: 1)
        XCTAssertEqual(Array(to.data[0..<4]), [230, 190, 60, 255])
        let crossfade = EffectDescription(["inputs": [["name": "from", "kind": "image"], ["name": "to", "kind": "image"], ["name": "mask", "kind": "number"]]])
        XCTAssertEqual(Set(effectSampleInputs(crossfade, width: 4, height: 2).keys), ["from", "to"])
    }
}
