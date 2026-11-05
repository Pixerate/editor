import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Affine matrices in SVG order (`geom/affine.ts`, shared by the vector and image editors).
// Angles are degrees, clockwise on screen (y points down).

/// An affine matrix `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`
/// (`VectorMatrix` / `AffineMatrix`).
public struct VectorMatrix: Equatable, Sendable {
    public var a, b, c, d, e, f: Double

    public init(_ a: Double, _ b: Double, _ c: Double, _ d: Double, _ e: Double, _ f: Double) {
        self.a = a
        self.b = b
        self.c = c
        self.d = d
        self.e = e
        self.f = f
    }

    public static let identity = VectorMatrix(1, 0, 0, 1, 0, 0)

    /// `m[i]` as in the TS.
    public subscript(i: Int) -> Double {
        switch i {
        case 0: a
        case 1: b
        case 2: c
        case 3: d
        case 4: e
        default: f
        }
    }

    /// The geometry module's tuple form.
    public var tuple: PixerateGeometry.AffineMatrix { (a, b, c, d, e, f) }

    /// `[a, b, c, d, e, f]`.
    public var json: JSONValue { .array([a, b, c, d, e, f].map { .number($0) }) }

    /// A matrix from an array of six numbers, or nil.
    public init?(json: JSONValue?) {
        guard let list = json?.arrayValue, list.count == 6 else { return nil }
        let n = list.compactMap(\.numberValue)
        guard n.count == 6 else { return nil }
        self.init(n[0], n[1], n[2], n[3], n[4], n[5])
    }
}

/// `IDENTITY_MATRIX`.
public let IDENTITY_MATRIX = VectorMatrix.identity

/// `a` then `b` (apply `a` first).
public func multiplyMatrices(_ a: VectorMatrix, _ b: VectorMatrix) -> VectorMatrix {
    let (a0, a1, a2, a3, a4, a5) = a.tuple
    let (b0, b1, b2, b3, b4, b5) = b.tuple
    return VectorMatrix(b0 * a0 + b2 * a1, b1 * a0 + b3 * a1, b0 * a2 + b2 * a3, b1 * a2 + b3 * a3, b0 * a4 + b2 * a5 + b4, b1 * a4 + b3 * a5 + b5)
}

public func translateMatrix(_ dx: Double, _ dy: Double) -> VectorMatrix { VectorMatrix(1, 0, 0, 1, dx, dy) }

public func scaleMatrix(_ sx: Double, _ sy: Double, _ origin: Vec2 = Vec2(0, 0)) -> VectorMatrix {
    VectorMatrix(sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y)
}

/// Rotation by `degrees` clockwise (y points down) around `origin`.
public func rotateMatrix(_ degrees: Double, _ origin: Vec2 = Vec2(0, 0)) -> VectorMatrix {
    let r = (degrees * Double.pi) / 180
    let cos = JS.cos(r)
    let sin = JS.sin(r)
    return VectorMatrix(cos, sin, -sin, cos, origin.x - cos * origin.x + sin * origin.y, origin.y - sin * origin.x - cos * origin.y)
}

/// `m` applied about `origin` instead of the coordinate origin.
public func matrixAbout(_ m: VectorMatrix, _ origin: Vec2) -> VectorMatrix {
    multiplyMatrices(multiplyMatrices(translateMatrix(-origin.x, -origin.y), m), translateMatrix(origin.x, origin.y))
}

/// A skew by `ax` degrees horizontally and `ay` degrees vertically, about `origin`. `Math.tan` is
/// Foundation's here (V8's is not ported), so results compare within the trig tolerance.
public func skewMatrix(_ ax: Double, _ ay: Double, _ origin: Vec2 = Vec2(0, 0)) -> VectorMatrix {
    let tx = Foundation.tan((ax * Double.pi) / 180)
    let ty = Foundation.tan((ay * Double.pi) / 180)
    return matrixAbout(VectorMatrix(1, ty, tx, 1, 0, 0), origin)
}

public func applyMatrix(_ m: VectorMatrix, _ p: Vec2) -> Vec2 {
    Vec2(m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f)
}

public func isIdentityMatrix(_ m: VectorMatrix, _ eps: Double = 1e-12) -> Bool {
    abs(m.a - 1) < eps && abs(m.b) < eps && abs(m.c) < eps && abs(m.d - 1) < eps && abs(m.e) < eps && abs(m.f) < eps
}

/// The inverse matrix (the identity for a singular one).
public func invertMatrix(_ m: VectorMatrix) -> VectorMatrix {
    let (a, b, c, d, e, f) = m.tuple
    let det = a * d - b * c
    if det == 0 || !det.isFinite { return IDENTITY_MATRIX }
    return VectorMatrix(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)
}

/// Applies only the linear part (for directions and offsets).
public func applyMatrixLinear(_ m: VectorMatrix, _ v: Vec2) -> Vec2 {
    Vec2(m.a * v.x + m.c * v.y, m.b * v.x + m.d * v.y)
}

/// The rotation of a matrix in degrees, clockwise (y down), in (−180, 180]; for a mirrored matrix,
/// the rotation left after undoing a horizontal flip.
public func matrixRotation(_ m: VectorMatrix) -> Double {
    let (a, b, c, d, _, _) = m.tuple
    let mirrored = a * d - b * c < 0
    let deg = ((mirrored ? JS.atan2(-b - c, d - a) : JS.atan2(b - c, a + d)) * 180) / Double.pi
    return abs(deg) < 1e-9 ? 0 : deg
}

/// Splits `m` into `residual` then `rigid` (`m = residual × rigid` in apply order): `rigid` is the
/// nearest rotation plus the translation, `residual` the linear rest.
public func decomposeRigid(_ m: VectorMatrix) -> (rigid: VectorMatrix, residual: VectorMatrix) {
    let (a, b, c, d, e, f) = m.tuple
    let deg = matrixRotation(m)
    if deg == 0 { return (IDENTITY_MATRIX, m) }
    let r = (deg * Double.pi) / 180
    let cos = JS.cos(r)
    let sin = JS.sin(r)
    return (
        VectorMatrix(cos, sin, -sin, cos, e, f),
        VectorMatrix(cos * a + sin * b, -sin * a + cos * b, cos * c + sin * d, -sin * c + cos * d, 0, 0)
    )
}
