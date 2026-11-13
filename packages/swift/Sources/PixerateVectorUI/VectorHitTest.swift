import CoreGraphics
import Foundation
import PixerateCore
import PixerateGeometry
import PixerateVector

/**
 * Picking on the canvas: which node a document point hits, as the canvases pick (`hitTestVectorNode`
 * in `vector/geometry.ts`, simplified). Paths hit where they paint: inside a fill (by its fill
 * rule) or within half the stroke width plus `tolerance` of the outline, with path effects applied.
 * Frames hit anywhere in their box; text, instances and other drawn nodes by their bounds. Hidden
 * nodes never hit; locked ones are skipped at the top level.
 */
public enum VectorHitTest {
    /// The topmost top-level node hit at `p` (document space), or nil.
    public static func topLevel(_ doc: VectorDocument, _ p: Vec2, tolerance: Double) -> String? {
        for node in doc.nodes.reversed() {
            if !node.isVisible || node.isLocked { continue }
            if hits(node, IDENTITY_MATRIX, p, tolerance) { return node.id }
        }
        return nil
    }

    /// The topmost path or text (inside groups) hit at `p`, for the Direct Selection tool.
    public static func deep(_ doc: VectorDocument, _ p: Vec2, tolerance: Double) -> String? {
        func visit(_ list: [VectorNode], _ parent: VectorMatrix) -> String? {
            for node in list.reversed() {
                if !node.isVisible || node.isLocked { continue }
                if node.isGroup && !isVectorFrame(node) {
                    let m = multiplyMatrices(nodeMatrix(node), parent)
                    if let hit = visit(node.children, m) { return hit }
                    continue
                }
                if hits(node, parent, p, tolerance) { return node.id }
            }
            return nil
        }
        return visit(doc.nodes, IDENTITY_MATRIX)
    }

    /// Whether `node` (under `parent`) is hit at `p`.
    public static func hits(_ node: VectorNode, _ parent: VectorMatrix, _ p: Vec2, _ tolerance: Double) -> Bool {
        if !node.isVisible { return false }
        if isVectorFrame(node) || node.isText || node.isInstance {
            guard let b = try? vectorNodeBounds(node, parent) else { return false }
            return contains(b, p, tolerance)
        }
        if node.isGroup {
            let m = multiplyMatrices(nodeMatrix(node), parent)
            if isVectorMaskGroup(node) && isVectorMaskActive(node), let mask = node.children.first {
                // Only what shows inside the mask hits.
                guard let b = try? vectorNodeBounds(mask, m), contains(b, p, tolerance) else { return false }
                return node.children.dropFirst().contains { hits($0, m, p, tolerance) }
            }
            return node.children.contains { hits($0, m, p, tolerance) }
        }
        guard node.isPath, let world = try? vectorPathWorldBezier(node, parent), !world.isEmpty else { return false }
        let cg = vectorCGPath(commands: world)
        let pt = CGPoint(x: p.x, y: p.y)
        let rule: CGPathFillRule = node.fillRule == "evenodd" ? .evenOdd : .winding
        if paints(node, "fill"), cg.contains(pt, using: rule) { return true }
        let strokeWidth = paints(node, "stroke") ? (node.strokeWidth ?? 1) : 0
        let reach = CGFloat(Swift.max(0, strokeWidth) + tolerance * 2)
        if reach <= 0 { return false }
        let area = cg.copy(strokingWithWidth: reach, lineCap: .round, lineJoin: .round, miterLimit: 4)
        return area.contains(pt)
    }

    /// Whether a node paints a fill (or stroke): the shorthand or any visible layer of its stack.
    static func paints(_ node: VectorNode, _ kind: String) -> Bool {
        if hasPaint(kind == "fill" ? node.fill : node.stroke) { return true }
        let stack = node[kind == "fill" ? "fills" : "strokes"]?.arrayValue ?? []
        return stack.contains { layer in layer["visible"] != .bool(false) && hasPaint(layer["paint"]) }
    }

    static func contains(_ b: VectorBounds, _ p: Vec2, _ tolerance: Double) -> Bool {
        p.x >= b.x - tolerance && p.x <= b.x + b.width + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.height + tolerance
    }

    /// Top-level nodes (visible, unlocked) whose bounds meet the box from `a` to `b`, bottom first.
    public static func marquee(_ doc: VectorDocument, _ a: Vec2, _ b: Vec2) -> [String] {
        let box = boundsFromPoints(a, b)
        return doc.nodes.compactMap { node -> String? in
            if !node.isVisible || node.isLocked { return nil }
            guard let nb = try? vectorNodeBounds(node, IDENTITY_MATRIX) else { return nil }
            return boundsIntersect(box, nb) ? node.id : nil
        }
    }
}
