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

    /// A sticker drag (`previewSticker`) redraws without an undo step; the drop commits one step from before the drag.
    func testPreviewStickerDragUndoesInOneStep() throws {
        let c = try PaintEditorController(width: 96, height: 96, stickers: try combineStickerProviders([editorStickers(), createFakeStickerProvider()]))
        try c.prepareStickers(["fake:weather-wind"])
        let added = try c.addStickers(nil, [["ref": "editor:star", "x": 20, "y": 20, "size": 24], ["ref": "fake:weather-wind", "x": 60, "y": 60, "size": 24, "frame": 1]])
        let id = added[1].id
        let before = c.compositePixels(paper: false).data
        let steps = c.undoLabel

        let shown = try c.previewSticker(nil, id, ["x": 40, "y": 30])
        XCTAssertEqual(shown.x, 40)
        XCTAssertEqual(shown.frame, 1)
        _ = try c.previewSticker(nil, id, ["x": 30, "y": 40, "frame": 2])
        XCTAssertEqual(try c.listStickers()[1].x, 30)
        XCTAssertEqual(c.undoLabel, steps, "a preview is not an undo step")
        XCTAssertNotEqual(c.compositePixels(paper: false).data, before)

        // The drop: one step, and undo goes back to before the first preview.
        let dropped = try c.updateSticker(nil, id, ["x": 32, "y": 40])
        XCTAssertEqual(dropped.frame, 2)
        XCTAssertEqual(c.undoLabel, "Edit sticker")
        let movedPixels = c.compositePixels(paper: false).data
        XCTAssertEqual(c.undo(), "Edit sticker")
        XCTAssertEqual(c.undoLabel, "Add stickers")
        XCTAssertEqual(try c.listStickers()[1].x, 60)
        XCTAssertEqual(try c.listStickers()[1].frame, 1)
        XCTAssertEqual(c.compositePixels(paper: false).data, before)
        _ = c.redo()
        XCTAssertEqual(c.compositePixels(paper: false).data, movedPixels)

        // Cancel restores the document from before the preview.
        _ = try c.previewSticker(nil, id, ["x": 70])
        c.cancelStickerPreview()
        XCTAssertEqual(try c.listStickers()[1].x, 32)
        XCTAssertEqual(c.compositePixels(paper: false).data, movedPixels)
        c.cancelStickerPreview() // nothing to cancel
        XCTAssertEqual(try c.listStickers()[1].x, 32)
    }

    func testPreviewStickerFailsUsefully() throws {
        let c = try PaintEditorController(width: 64, height: 64)
        XCTAssertThrowsError(try c.previewSticker(nil, "st1", ["x": 1])) { e in
            XCTAssertTrue((e as? PaintEditorError)?.message.contains("has no stickers") == true, "\(e)")
        }
        let added = try c.addStickers(nil, [["ref": "editor:star", "x": 20, "y": 20]])
        XCTAssertThrowsError(try c.previewSticker(nil, "st9", ["x": 1])) { e in
            XCTAssertTrue((e as? PaintEditorError)?.message.contains("has no sticker \"st9\". Call list_stickers for the ids.") == true, "\(e)")
        }
        XCTAssertThrowsError(try c.previewSticker(nil, added[0].id, ["frame": 1])) { e in
            XCTAssertTrue((e as? PaintEditorError)?.message.contains("is not animated") == true, "\(e)")
        }
        let layer = try XCTUnwrap(c.doc.activeLayerId)
        _ = try c.updateLayer(layer, ["locks": ["pixels": true]])
        XCTAssertThrowsError(try c.previewSticker(nil, added[0].id, ["x": 30])) { e in
            XCTAssertTrue((e as? PaintEditorError)?.message.contains("has its pixels locked") == true, "\(e)")
        }
        XCTAssertEqual(try c.listStickers()[0].x, 20)
    }

    /// Any other change after a preview ends it: the next sticker edit commits from the document as it is.
    func testPreviewStickerEndsWhenTheDocumentChanges() throws {
        let c = try PaintEditorController(width: 64, height: 64)
        let added = try c.addStickers(nil, [["ref": "editor:star", "x": 20, "y": 20]])
        let layer = c.doc.activeLayerId
        _ = try c.previewSticker(nil, added[0].id, ["x": 30])
        _ = try c.addLayer(name: "Other")
        let count = c.doc.layers.count
        c.cancelStickerPreview()
        XCTAssertEqual(c.doc.layers.count, count, "cancel after another change does nothing")
        XCTAssertEqual(try c.listStickers(layer).first?.x, 30)
    }
}
