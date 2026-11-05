import Foundation
import PixerateRaster

// Damped, weighted, minimum-norm Gauss–Newton (Levenberg–Marquardt style) with a numerical
// Jacobian, and the rank / null-space tools the degrees-of-freedom analysis uses
// (`vector/constraints/lm.ts`). Ported operation for operation in the TS order: the solve is
// iterative, so a different summation order or a fused multiply-add would change how many
// iterations it takes and where it stops.

/// Most residual rows one solve may have (the normal matrix is rows × rows).
let CONSTRAINT_MAX_ROWS = 800

/// Residuals at `x`, appended to `out`.
typealias ResidualFn = (_ x: [Double], _ out: inout [Double]) -> Void

/// The largest magnitude (`Infinity` once any value is not finite).
func constraintMaxAbs(_ v: [Double]) -> Double {
    var m = 0.0
    for a in v { m = a.isFinite ? JS.max(m, Swift.abs(a)) : .infinity }
    return m
}

private func norm2(_ v: [Double]) -> Double {
    var s = 0.0
    for a in v { s = s + a * a }
    return s
}

/// Numerical Jacobian over the free parameters (row-major, rows × free.count).
func constraintJacobian(_ f: ResidualFn, _ x: [Double], _ free: [Int], _ rows: Int) -> [Double] {
    let nf = free.count
    var jac = [Double](repeating: 0, count: rows * nf)
    var xp = x
    var rp: [Double] = []
    var rm: [Double] = []
    for (k, j) in free.enumerated() {
        let xj = x[j]
        let h = 1e-7 * JS.max(Swift.abs(xj), 1)
        xp[j] = xj + h
        rp.removeAll(keepingCapacity: true)
        f(xp, &rp)
        xp[j] = xj - h
        rm.removeAll(keepingCapacity: true)
        f(xp, &rm)
        xp[j] = xj
        for i in 0 ..< rows {
            let d = ((i < rp.count ? rp[i] : 0) - (i < rm.count ? rm[i] : 0)) / (2 * h)
            jac[i * nf + k] = d.isFinite ? d : 0
        }
    }
    return jac
}

/// Solves the dense `n × n` system `a y = b` by Gaussian elimination with partial pivoting; nil when singular.
private func solveDense(_ a: inout [Double], _ b: inout [Double], _ n: Int) -> [Double]? {
    var scale = 0.0
    for v in a { scale = JS.max(scale, Swift.abs(v)) }
    scale = JS.max(scale, 1e-300)
    for col in 0 ..< n {
        var piv = col
        var best = 0.0
        for r in col ..< n {
            let v = Swift.abs(a[r * n + col])
            if v > best {
                best = v
                piv = r
            }
        }
        if best <= scale * 1e-15 { return nil }
        if piv != col {
            for c in 0 ..< n {
                let t = a[piv * n + c]
                a[piv * n + c] = a[col * n + c]
                a[col * n + c] = t
            }
            let t = b[piv]
            b[piv] = b[col]
            b[col] = t
        }
        let p = a[col * n + col]
        for r in col + 1 ..< max(n, col + 1) {
            let f = a[r * n + col] / p
            if f == 0 { continue }
            for c in col ..< n { a[r * n + c] -= f * a[col * n + c] }
            b[r] -= f * b[col]
        }
    }
    var y = [Double](repeating: 0, count: n)
    var r = n - 1
    while r >= 0 {
        var s = b[r]
        for c in r + 1 ..< max(n, r + 1) { s -= a[r * n + c] * y[c] }
        y[r] = s / a[r * n + r]
        if !y[r].isFinite { return nil }
        r -= 1
    }
    return y
}

private func reflect(_ v: [Double], _ vv: Double, _ c: inout [Double]) {
    var d = 0.0
    for i in 0 ..< v.count { d += v[i] * c[i] }
    let f = (2 * d) / vv
    if f != 0 { for i in 0 ..< v.count { c[i] -= f * v[i] } }
}

/// Householder QR with column pivoting of the columns `cols` (all the same length). Stops when the
/// largest remaining column norm drops to `rel` times the first pivot's (or below `abs`). Returns
/// the numerical rank and the Householder vectors.
func constraintQr(_ input: [[Double]], _ rel: Double, _ abs: Double) -> (rank: Int, reflectors: [[Double]]) {
    var cols = input
    let m = cols.first?.count ?? 0
    let n = cols.count
    var refl: [[Double]] = []
    var first: Double?
    var k = 0
    while k < Swift.min(m, n) {
        var best = k
        var bestNorm = -1.0
        for j in k ..< n {
            var v = 0.0
            for i in k ..< m { v += cols[j][i] * cols[j][i] }
            if v.isFinite && v > bestNorm {
                bestNorm = v
                best = j
            }
        }
        let norm = JS.max(bestNorm, 0).squareRoot()
        let lim = first.map { JS.max($0 * rel, abs) } ?? abs
        if !(norm > lim) { break }
        if first == nil { first = norm }
        cols.swapAt(k, best)
        let col = cols[k]
        var v = [Double](repeating: 0, count: m)
        for i in k ..< m { v[i] = col[i] }
        let alpha = v[k] >= 0 ? -norm : norm
        v[k] -= alpha
        let vv = norm2(v)
        if !(vv > 0) { break }
        for j in k ..< n { reflect(v, vv, &cols[j]) }
        refl.append(v)
        k += 1
    }
    return (refl.count, refl)
}

/// Column norm (after row balancing) below which a column is difference noise.
private let COL_NOISE = 1e-6
/// Relative threshold below which a pivot counts as zero (the Jacobian is numerical).
private let RANK_TOL = 1e-7

/// Rows and then columns scaled to unit norm, as the rows of the `rows × cols` matrix `m`.
private func balancedRows(_ m: [Double], _ rows: Int, _ cols: Int) -> [[Double]] {
    var r: [[Double]] = []
    for i in 0 ..< rows {
        let row = Array(m[(i * cols) ..< ((i + 1) * cols)])
        let n = norm2(row).squareRoot()
        let f = n > 1e-12 && n.isFinite ? 1 / n : 0
        r.append(row.map { $0 * f })
    }
    for c in 0 ..< cols {
        var n = 0.0
        for row in r { n += row[c] * row[c] }
        n = n.squareRoot()
        // An exactly zero derivative evaluated by differences is noise, not a direction.
        let f = n > COL_NOISE && n.isFinite ? 1 / n : 0
        for i in r.indices { r[i][c] *= f }
    }
    return r
}

/// Numerical rank of a row-major `rows × cols` Jacobian (balanced, then QR with column pivoting).
func constraintRankQr(_ m: [Double], _ rows: Int, _ cols: Int) -> Int {
    if rows == 0 || cols == 0 { return 0 }
    return constraintQr(balancedRows(m, rows, cols), RANK_TOL, 1e-12).rank
}

/// Rank and an orthonormal basis of the null space of a row-major `rows × cols` Jacobian.
func constraintNullSpace(_ m: [Double], _ rows: Int, _ cols: Int) -> (rank: Int, basis: [[Double]]) {
    let (rank, reflectors) = rows == 0 ? (0, [[Double]]()) : constraintQr(balancedRows(m, rows, cols), RANK_TOL, 1e-12)
    var basis: [[Double]] = []
    var j = rank
    while j < cols {
        var e = [Double](repeating: 0, count: cols)
        e[j] = 1
        for v in reflectors.reversed() {
            let vv = norm2(v)
            if vv > 0 { reflect(v, vv, &e) }
        }
        basis.append(e)
        j += 1
    }
    return (rank, basis)
}

/// Where a solve ended.
struct ConstraintSolveOutcome {
    var x: [Double]
    var converged: Bool
}

/// Runs the solver from `x0`; only `free` parameters change (`solveLm`).
func constraintSolveLm(_ f: ResidualFn, _ x0: [Double], _ free: [Int], _ weights: [Double], _ tol: Double, _ maxIter: Int) -> ConstraintSolveOutcome {
    var x = x0
    var r: [Double] = []
    f(x, &r)
    let rows = r.count
    if rows == 0 || constraintMaxAbs(r) <= tol { return ConstraintSolveOutcome(x: x, converged: true) }
    if free.isEmpty || rows > CONSTRAINT_MAX_ROWS { return ConstraintSolveOutcome(x: x, converged: false) }
    let nf = free.count
    let winv = free.map { j in 1 / JS.max(j < weights.count ? weights[j] : 1, 1e-12) }
    var mu = 1e-10
    var cost = norm2(r)
    var rn: [Double] = []
    for _ in 0 ..< maxIter {
        let jac = constraintJacobian(f, x, free, rows)
        // A = J W⁻¹ Jᵀ
        var a = [Double](repeating: 0, count: rows * rows)
        for i in 0 ..< rows {
            for k in i ..< rows {
                var s = 0.0
                for c in 0 ..< nf { s += jac[i * nf + c] * jac[k * nf + c] * winv[c] }
                a[i * rows + k] = s
                a[k * rows + i] = s
            }
        }
        var diagMax = 1e-12
        for i in 0 ..< rows { diagMax = JS.max(diagMax, a[i * rows + i]) }
        var improved = false
        for _ in 0 ..< 12 {
            var ad = a
            for i in 0 ..< rows { ad[i * rows + i] += mu * diagMax }
            var b = r
            guard let y = solveDense(&ad, &b, rows) else {
                mu *= 10
                continue
            }
            var xn = x
            for (c, j) in free.enumerated() {
                var s = 0.0
                for i in 0 ..< rows { s += jac[i * nf + c] * y[i] }
                xn[j] -= winv[c] * s
            }
            rn = []
            f(xn, &rn)
            let cn = norm2(rn)
            if cn.isFinite && cn < cost {
                x = xn
                r = rn
                cost = cn
                mu = JS.max(mu * 0.1, 1e-15)
                improved = true
                break
            }
            mu *= 10
        }
        if constraintMaxAbs(r) <= tol { return ConstraintSolveOutcome(x: x, converged: true) }
        if !improved { break }
    }
    return ConstraintSolveOutcome(x: x, converged: constraintMaxAbs(r) <= tol)
}
