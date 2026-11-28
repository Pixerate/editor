import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// A save in two steps (`saveSnapshot`): read on the controller's thread, PNGs encoded anywhere,
/// with exactly the document `toJSON` saves.
final class PaintSaveSnapshotTests: XCTestCase {
    private func wave(_ y: Double) -> [PenPoint] {
        (0..<24).map { i in PenPoint(x: 20 + Double(i) * 12, y: y + 20 * sin(Double(i) / 4), pressure: 0.7) }
    }

    private func paint(_ c: PaintEditorController, _ brushId: String, _ y: Double) throws {
        _ = try c.setBrushFacets([:], id: brushId)
        let s = try c.beginStroke()
        s.push(wave(y))
        _ = try s.end()
    }

    /// Layers, thick paint, light and wet paint: each saves PNGs of its own.
    private func painting() throws -> PaintEditorController {
        let c = try PaintEditorController(width: 320, height: 200)
        try paint(c, "soft-pastel", 30)
        try paint(c, "glow-gel", 70)
        _ = try c.addLayer(name: "Second")
        try paint(c, "impasto-brush", 110)
        try paint(c, "watercolor-round", 150)
        return c
    }

    private func hasPlaceholder(_ v: JSONValue) -> Bool {
        switch v {
        case .string(let s): return s.contains(";pending-")
        case .array(let a): return a.contains(where: hasPlaceholder)
        case .object(let o): return o.contains { hasPlaceholder($0.value) }
        default: return false
        }
    }

    func testSnapshotSavesExactlyWhatToJSONSaves() throws {
        let c = try painting()
        let snapshot = c.saveSnapshot()
        XCTAssertGreaterThan(snapshot.pendingPngCount, 3, "layers, thick paint and light are left to encode")
        XCTAssertTrue(hasPlaceholder(.object(snapshot.pending)))
        let document = snapshot.document()
        XCTAssertFalse(hasPlaceholder(.object(document)))
        XCTAssertEqual(JSONValue.object(document).stringified(), JSONValue.object(c.toJSON()).stringified())
    }

    func testPlaceholdersNeverReachTheEncodeCaches() throws {
        let c = try painting()
        _ = c.saveSnapshot()
        // The layer PNG cache is filled by real encodes only: the next plain save has no placeholders.
        XCTAssertFalse(hasPlaceholder(.object(c.toJSON())))
        XCTAssertFalse(hasPlaceholder(.object(c.saveSnapshot().document())))
    }

    func testSnapshotEncodesOffTheControllersThreadWhileItKeepsPainting() throws {
        let c = try painting()
        let expected = JSONValue.object(c.toJSON()).stringified()
        let snapshot = c.saveSnapshot()
        // The painting goes on: the snapshot keeps what was there when it was taken.
        try paint(c, "soft-pastel", 180)
        let done = expectation(description: "encoded")
        var saved = ""
        DispatchQueue.global(qos: .utility).async {
            saved = JSONValue.object(snapshot.document()).stringified()
            done.fulfill()
        }
        wait(for: [done], timeout: 120)
        XCTAssertEqual(saved, expected)
        XCTAssertNotEqual(JSONValue.object(c.toJSON()).stringified(), expected)
    }

    func testThumbnailMatchesExportPng() throws {
        let c = try painting()
        let snapshot = c.saveSnapshot(thumbnailMaxSide: 100)
        XCTAssertEqual(snapshot.thumbnailPng(), try c.exportPng(scale: 100.0 / 320))
        XCTAssertEqual(c.saveSnapshot(thumbnailMaxSide: 1000).thumbnailPng(), try c.exportPng())
        XCTAssertNil(c.saveSnapshot().thumbnailPng())
    }

    func testDeferralOnlyCoversItsOwnRun() {
        let pixels = [UInt8](repeating: 200, count: 4 * 4)
        let (url, encodes) = PngDeferral.run { pngDataUrl(2, 2, pixels) }
        XCTAssertTrue(url.contains(";pending-"))
        XCTAssertEqual(encodes.pngs.count, 1)
        XCTAssertEqual(encodes.dataUrls(), [pngDataUrl(2, 2, pixels)])
        XCTAssertFalse(PngDeferral.isDeferring)
        XCTAssertTrue(pngDataUrl(2, 2, pixels).hasPrefix("data:image/png;base64,"))
    }
}
