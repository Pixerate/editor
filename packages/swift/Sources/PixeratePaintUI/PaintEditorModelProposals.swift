import CoreGraphics
import Foundation
import PixerateCore
import PixeratePaint
import PixerateRaster
import SwiftUI

/// A pending paint proposal as the canvas draws it (`<PaintCanvas proposals>`): its ghost image where its paint would go.
public struct PaintProposalGhost: Identifiable {
    public var id: String
    public var title: String
    public var rationale: String?
    /// Who suggests it (`agent:<id>`).
    public var origin: String
    /// Where the ghost sits, in document pixels.
    public var rect: CGRect
    /// The picture as it would look inside `rect` (premultiplied sRGB).
    public var image: CGImage

    /// What the canvas says about it to assistive technologies (`aria-label` on the web).
    public var accessibilityLabel: String { "Suggested: \(title)" }
}

extension PaintEditorModel {
    /**
     * Shows `store`'s pending proposals as ghosts over the canvas (`PaintCanvasView` draws
     * `proposalGhosts`: translucent, with a dashed edge, not hit-tested) and registers the proposal
     * tools (`propose_paint`, `list_paint_proposals`, `accept_paint_proposal`,
     * `reject_paint_proposal`) in `registry`, as the web's `usePaintProposals` with
     * `<PaintCanvas proposals>` do. The host draws its own accept and dismiss controls from
     * `proposalGhosts` and calls the store. Pass nil to stop. The store is attached to the
     * controller, so evolution tools share it.
     */
    public func showProposals(_ store: PaintProposals?) throws {
        for s in proposalSubscriptions { s.cancel() }
        proposalSubscriptions = []
        proposalStore = store
        guard let store else {
            proposalGhosts = []
            return
        }
        controller.attachProposals(store)
        proposalSubscriptions.append(try registry.register(createPaintProposalToolProvider(store)))
        proposalSubscriptions.append(store.subscribe { [weak self] list in
            MainActor.assumeIsolated { self?.updateProposalGhosts(list) }
        })
        updateProposalGhosts(store.proposals)
    }

    /// Rebuilds the ghost images, reusing those of proposals still pending.
    func updateProposalGhosts(_ list: [PaintProposal]) {
        let kept = Dictionary(proposalGhosts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        proposalGhosts = list.compactMap { p in kept[p.id] ?? PaintProposalGhost(p) }
    }
}

extension PaintProposalGhost {
    /// The proposal's ghost (`paintProposalGhost`), or nil when it paints nothing.
    init?(_ p: PaintProposal) {
        guard let b = p.bounds, b.width > 0, b.height > 0, p.ghost.count == b.width * b.height * 4 else { return nil }
        // Straight RGBA to premultiplied, which Core Graphics draws.
        var px = p.ghost
        for i in stride(from: 0, to: px.count, by: 4) {
            let a = UInt16(px[i + 3])
            for c in 0..<3 { px[i + c] = UInt8((UInt16(px[i + c]) * a + 127) / 255) }
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData),
              let image = CGImage(width: b.width, height: b.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: b.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        self.init(id: p.id, title: p.title, rationale: p.rationale, origin: p.origin, rect: CGRect(x: b.x, y: b.y, width: b.width, height: b.height), image: image)
    }
}

#if DEBUG
/// A painting with an agent's suggestion pending: a stroke shown as a ghost over it.
@MainActor
private func proposalPreviewModel() -> PaintEditorModel {
    let model = try! PaintEditorModel(controller: PaintEditorController(width: 320, height: 220))
    let c = model.controller
    _ = try? c.paintStroke(PaintStrokeInit(color: "#2e7d32", brushId: "soft-pastel", seed: 1), points: (0..<10).map { PenPoint(x: 30 + Double($0) * 28, y: 150, pressure: 0.7) })
    let store = PaintProposals(controller: c, origin: "agent:pixie")
    try? model.showProposals(store)
    _ = try? store.propose(["title": "Hills", "rationale": "A line of hills behind the grass.", "ops": [["kind": "stroke", "points": .array((0..<10).map { i in .object(["x": .number(30 + Double(i) * 28), "y": .number(90 + sin(Double(i) / 2) * 20), "pressure": 0.6]) }), "brushId": "soft-pastel", "color": "#6d4c41", "size": 14]]])
    return model
}

#Preview("A pending proposal's ghost") {
    PaintCanvasView(model: proposalPreviewModel(), interactive: false).frame(width: 480, height: 330)
}
#endif
