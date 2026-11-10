import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

final class StickerProviderTests: XCTestCase {
    func testProviderStickersAndAnimatedFrameModes() throws {
        let provider = try combineStickerProviders([
            editorStickers(),
            createFakeStickerProvider(),
        ])
        let c = try PaintEditorController(width: 96, height: 96, stickers: provider)

        let page = try c.stickersProvider.search("wind", StickerSearchOptions())
        XCTAssertEqual(page.items.map { $0.id }, ["fake:weather-wind"])
        XCTAssertEqual(page.items.first?.animated, true)
        XCTAssertEqual(page.items.first?.frameCount, 4)
        XCTAssertEqual(page.items.first?.frameDelay, 100)

        try c.prepareStickers(["fake:weather-wind"])
        let art = c.stickerArt.get("fake:weather-wind")
        XCTAssertNotNil(art)
        XCTAssertEqual(art?.frames?.count, 4)

        // Default frameMode ("perform") advances frame with stroke point time (frameDelay = 100ms).
        _ = try c.setBrushFacets([
            "tip": ["shape": "stamp", "size": 16, "spacing": 0.5, "stamps": ["fake:weather-wind"]],
            "marks": ["kind": "objects", "density": 1, "sizeJitter": 0, "rotationJitter": 0, "scatter": 0, "colourJitter": 0],
        ], id: "sticker-stars")
        _ = try c.paintStroke(
            PaintStrokeInit(seed: 10),
            points: [
                PenPoint(x: 16, y: 48, t: 0),
                PenPoint(x: 48, y: 48, t: 150),
                PenPoint(x: 80, y: 48, t: 350),
            ]
        )
        let placed = try c.listStickers()
        XCTAssertGreaterThanOrEqual(placed.count, 3)
        let frames: [Int?] = placed.map { $0.frame }
        XCTAssertNil(frames.first ?? nil) // frame 0 is omitted
        XCTAssertTrue(frames.contains(1) || frames.contains(2) || frames.contains(3))

        // "random" mode picks deterministic seeded frames even at time = 0.
        _ = try c.clearLayer(nil)
        _ = try c.setBrushFacets([
            "marks": ["kind": "objects", "frameMode": "random"],
        ])
        XCTAssertEqual(c.brush.sticker["frameMode"]?.stringValue, "random")
        _ = try c.paintStroke(
            PaintStrokeInit(seed: 42),
            points: [
                PenPoint(x: 10, y: 48, t: 0),
                PenPoint(x: 90, y: 48, t: 0),
            ]
        )
        let randomPlaced = try c.listStickers()
        let randomFrames = Set(randomPlaced.map { $0.frame ?? 0 })
        XCTAssertGreaterThan(randomFrames.count, 1)
    }

    func testAddAndUpdateStickerFrameThroughTools() async throws {
        let host = try PaintConformanceHost(setup: ["width": 96, "height": 96, "stickers": "fake"])
        let added = await host.callTool("add_stickers", [
            "stickers": [
                ["ref": "fake:weather-wind", "x": 48, "y": 48, "size": 32, "frame": 2],
            ],
        ])
        XCTAssertFalse(added.isError, "\(added.content)")
        let firstSticker = added.structuredContent?["stickers"]?.arrayValue?.first?.objectValue
        XCTAssertEqual(firstSticker?["frame"], 2)
        let id = firstSticker?["id"]?.stringValue ?? ""

        let updated = await host.callTool("update_sticker", [
            "id": .string(id),
            "frame": 0,
        ])
        XCTAssertFalse(updated.isError, "\(updated.content)")
        // update_sticker returns the sticker itself; frame 0 is left out, not saved as 0.
        XCTAssertEqual(updated.structuredContent?["id"]?.stringValue, id)
        XCTAssertNil(updated.structuredContent?["frame"])

        // A frame past the art's last is refused, naming how many it has, and nothing changes.
        let tooFar = await host.callTool("update_sticker", ["id": .string(id), "frame": 4])
        XCTAssertTrue(tooFar.isError)
        XCTAssertTrue("\(tooFar.content)".contains("has 4 frames, so frame is 0..3; got 4"), "\(tooFar.content)")
        let still = await host.callTool("list_stickers", [:])
        XCTAssertNil(still.structuredContent?["stickers"]?.arrayValue?.first?.objectValue?["frame"])

        // A static sticker has only frame 0.
        let star = await host.callTool("add_stickers", ["stickers": [["ref": "editor:star", "x": 10, "y": 10, "frame": 1]]])
        XCTAssertTrue(star.isError)
        XCTAssertTrue("\(star.content)".contains("is not animated, so its only frame is 0; got 1"), "\(star.content)")

        // Restamping without a frame starts the new sticker at its first frame.
        _ = await host.callTool("update_sticker", ["id": .string(id), "frame": 3])
        let restamped = await host.callTool("update_sticker", ["id": .string(id), "ref": "editor:heart"])
        XCTAssertFalse(restamped.isError, "\(restamped.content)")
        XCTAssertNil(restamped.structuredContent?["frame"])
    }

    func testSavedStickerFrameZeroIsLeftOut() throws {
        let zero = try XCTUnwrap(Sticker(json: ["id": "st1", "ref": "fake:weather-wind", "x": 1, "y": 2, "frame": 0]))
        XCTAssertNil(zero.frame)
        XCTAssertNil(zero.json["frame"])
        XCTAssertNil(Sticker(json: ["id": "st1", "ref": "editor:star", "x": 1, "y": 2, "frame": -1])?.frame)
        XCTAssertNil(Sticker(json: ["id": "st1", "ref": "editor:star", "x": 1, "y": 2, "frame": 1.5])?.frame)
        XCTAssertEqual(Sticker(json: ["id": "st1", "ref": "fake:weather-wind", "x": 1, "y": 2, "frame": 3])?.json["frame"], 3)
        var s = zero
        s.frame = 0
        XCTAssertNil(s.json["frame"])
        XCTAssertNil(s.applying(["frame": 0]).frame)
    }
}
