// Drawing a line on in pieces (#812), ported line for line from packages/core/src/animation/draw.ts:
// several paths drawn on as one continuous stroke, frame-pure, whole at p = 1.
import Foundation

/// One drawn path's place along the shared line, as lengths from the line's start.
public struct DrawPiece: Sendable, Equatable {
    public var from: Double
    public var to: Double
    /// The element's id, for `drawPiecesToFlair`.
    public var id: String?
    public init(from: Double, to: Double, id: String? = nil) { self.from = from; self.to = to; self.id = id }
}

/// A piece at one progress: how much of it shows, from its start.
public struct DrawnPiece: Sendable, Equatable {
    public var visible: Double
    public var length: Double
    public var fraction: Double
    /// `stroke-dasharray` that shows it: `"<visible> <length>"`.
    public var dasharray: String
    /// Whether anything shows (round caps draw a dot for a zero dash).
    public var shown: Bool
}

public enum DrawPiecesError: Error, CustomStringConvertible, Equatable {
    case invalid(String)
    public var description: String { switch self { case .invalid(let m): return m } }
}

/// How the head moves along the line: an animation easing or a function of 0–1.
public enum DrawEase: Sendable {
    case easing(AnimationEasing?)
    case function(@Sendable (Double) -> Double)
}

/// The plan for drawing one line from its pieces (`drawPieces` in the TS core).
public struct DrawPieces: Sendable {
    public let pieces: [DrawPiece]
    public let total: Double
    public let at: Double
    public let span: Double
    let ease: DrawEase
    /// Each piece's window in the overall progress (where the head reaches its start and end).
    public private(set) var windows: [(start: Double, end: Double)] = []

    public init(_ pieces: [DrawPiece], total totalOption: Double? = nil, at atOption: Double = 0, span spanOption: Double? = nil, ease: DrawEase = .easing(nil)) throws {
        for (i, piece) in pieces.enumerated() where !piece.from.isFinite || !piece.to.isFinite || piece.to < piece.from {
            throw DrawPiecesError.invalid("pieces[\(i)] must have finite from ≤ to (got from \(JSONValue.jsNumber(piece.from)), to \(JSONValue.jsNumber(piece.to))).")
        }
        var furthest = 0.0
        for piece in pieces { furthest = max(furthest, piece.to) }
        let total = totalOption ?? furthest
        if !(total >= 0) { throw DrawPiecesError.invalid("total must be a length of 0 or more (got \(JSONValue.jsNumber(total))).") }
        self.pieces = pieces
        self.total = total
        self.at = min(1, max(0, atOption))
        self.span = min(1 - self.at, max(0, spanOption ?? 1 - self.at))
        self.ease = ease
        let plan = self
        self.windows = pieces.map { (start: plan.progressAt($0.from), end: plan.progressAt($0.to)) }
    }

    private func curve(_ t: Double) -> Double {
        switch ease {
        case .function(let f): return f(t)
        case .easing(let e): return evaluateEasing(e ?? .named("linear"), t)
        }
    }

    private func local(_ p: Double) -> Double {
        p >= at + span ? 1 : p <= at ? 0 : min(1, (p - at) / span)
    }

    /// The head's position along the line at progress `p`.
    public func headAt(_ p: Double) -> Double {
        if !(p < 1) { return total }
        let u = local(p)
        if u <= 0 { return 0 }
        if u >= 1 { return total }
        return min(total, max(0, total * curve(u)))
    }

    /// Every piece at progress `p`, in the pieces' order.
    public func drawAt(_ p: Double) -> [DrawnPiece] {
        let head = headAt(p)
        return pieces.map { piece in
            let length = piece.to - piece.from
            let visible = min(length, max(0, head - piece.from))
            let reached = head >= piece.from && head > 0
            let fraction = length > 0 ? visible / length : reached ? 1 : 0
            return DrawnPiece(visible: visible, length: length, fraction: fraction, dasharray: "\(formatDrawNumber(visible)) \(formatDrawNumber(length))", shown: visible > 0)
        }
    }

    func progressAt(_ s: Double) -> Double {
        if s <= 0 { return at }
        var lo = at, hi = at + span
        for _ in 0..<60 {
            let mid = (lo + hi) / 2
            if headAt(mid) >= s { hi = mid } else { lo = mid }
        }
        return hi
    }
}

func formatDrawNumber(_ v: Double) -> String {
    let rounded = drawRound(v * 1000) / 1000
    return rounded == 0 ? "0" : JSONValue.jsNumber(rounded)
}

/// One draw-on of an SVG element, in the shape of Flair's `SvgAnimation` (`draw: true`, linear).
public struct DrawPieceAnimation: Sendable, Equatable {
    public var id: String
    public var delay: Double
    public var ms: Double
}

/// The plan as Flair draw-ons over a motion `durationMs` long (`drawPiecesToFlair` in the TS core).
public func drawPiecesToFlair(_ plan: DrawPieces, durationMs: Double) -> [DrawPieceAnimation] {
    var out: [DrawPieceAnimation] = []
    for (i, piece) in plan.pieces.enumerated() {
        guard let id = piece.id else { continue }
        let w = plan.windows[i]
        out.append(DrawPieceAnimation(id: id, delay: drawRound(w.start * durationMs), ms: max(1, drawRound((w.end - w.start) * durationMs))))
    }
    return out
}

/// `Math.round`: the nearest integer, ties toward +∞.
func drawRound(_ x: Double) -> Double {
    let f = x.rounded(.down)
    return x - f >= 0.5 ? f + 1 : f
}
