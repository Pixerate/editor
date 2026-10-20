// Portions ported from cadcraft/crates/constraints/src/lm.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Damped, weighted, minimum-norm Gauss–Newton (Levenberg–Marquardt style) with a numerical
 * Jacobian, and the rank / null-space tools the degrees-of-freedom analysis uses.
 *
 * Each step solves `min ‖W^{1/2} Δx‖` subject to `J Δx = −r` (damped):
 * `Δx = −W⁻¹ Jᵀ (J W⁻¹ Jᵀ + μ I)⁻¹ r`. Under-constrained systems therefore move as little as
 * possible, and heavily weighted parameters (geometry just edited) move least.
 */

/** Most residual rows one solve may have (the normal matrix is rows × rows). */
export const MAX_ROWS = 800;

export type ResidualFn = (x: readonly number[], out: number[]) => void;

export const maxAbs = (v: readonly number[]): number => v.reduce((m, a) => (Number.isFinite(a) ? Math.max(m, Math.abs(a)) : Infinity), 0);
const norm2 = (v: readonly number[]): number => v.reduce((s, a) => s + a * a, 0);

/** Numerical Jacobian over the free parameters (row-major, rows × free.length). */
export function jacobian(f: ResidualFn, x: readonly number[], free: readonly number[], rows: number): Float64Array {
	const nf = free.length;
	const jac = new Float64Array(rows * nf);
	const xp = x.slice();
	const rp: number[] = [];
	const rm: number[] = [];
	free.forEach((j, k) => {
		const xj = x[j];
		const h = 1e-7 * Math.max(Math.abs(xj), 1);
		xp[j] = xj + h;
		rp.length = 0;
		f(xp, rp);
		xp[j] = xj - h;
		rm.length = 0;
		f(xp, rm);
		xp[j] = xj;
		for (let i = 0; i < rows; i++) {
			const d = ((rp[i] ?? 0) - (rm[i] ?? 0)) / (2 * h);
			jac[i * nf + k] = Number.isFinite(d) ? d : 0;
		}
	});
	return jac;
}

/** Solves the dense `n × n` system `a y = b` by Gaussian elimination with partial pivoting; null when singular. */
function solveDense(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
	let scale = 0;
	for (const v of a) scale = Math.max(scale, Math.abs(v));
	scale = Math.max(scale, 1e-300);
	for (let col = 0; col < n; col++) {
		let piv = col;
		let best = 0;
		for (let r = col; r < n; r++) {
			const v = Math.abs(a[r * n + col]);
			if (v > best) {
				best = v;
				piv = r;
			}
		}
		if (best <= scale * 1e-15) return null;
		if (piv !== col) {
			for (let c = 0; c < n; c++) {
				const t = a[piv * n + c];
				a[piv * n + c] = a[col * n + c];
				a[col * n + c] = t;
			}
			const t = b[piv];
			b[piv] = b[col];
			b[col] = t;
		}
		const p = a[col * n + col];
		for (let r = col + 1; r < n; r++) {
			const f = a[r * n + col] / p;
			if (f === 0) continue;
			for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c];
			b[r] -= f * b[col];
		}
	}
	const y = new Float64Array(n);
	for (let r = n - 1; r >= 0; r--) {
		let s = b[r];
		for (let c = r + 1; c < n; c++) s -= a[r * n + c] * y[c];
		y[r] = s / a[r * n + r];
		if (!Number.isFinite(y[r])) return null;
	}
	return y;
}

function reflect(v: readonly number[], vv: number, c: number[]): void {
	let d = 0;
	for (let i = 0; i < v.length; i++) d += v[i] * c[i];
	const f = (2 * d) / vv;
	if (f !== 0) for (let i = 0; i < v.length; i++) c[i] -= f * v[i];
}

/**
 * Householder QR with column pivoting of the columns `cols` (all the same length). Stops when the
 * largest remaining column norm drops to `rel` times the first pivot's (or below `abs`). Returns
 * the numerical rank and the Householder vectors.
 */
export function qr(cols: number[][], rel: number, abs: number): { rank: number; reflectors: number[][] } {
	const m = cols[0]?.length ?? 0;
	const n = cols.length;
	const refl: number[][] = [];
	let first: number | null = null;
	for (let k = 0; k < Math.min(m, n); k++) {
		let best = k;
		let bestNorm = -1;
		for (let j = k; j < n; j++) {
			let v = 0;
			for (let i = k; i < m; i++) v += cols[j][i] * cols[j][i];
			if (Number.isFinite(v) && v > bestNorm) {
				bestNorm = v;
				best = j;
			}
		}
		const norm = Math.sqrt(Math.max(bestNorm, 0));
		const lim = first === null ? abs : Math.max(first * rel, abs);
		if (!(norm > lim)) break;
		if (first === null) first = norm;
		[cols[k], cols[best]] = [cols[best], cols[k]];
		const col = cols[k];
		const v = new Array<number>(m).fill(0);
		for (let i = k; i < m; i++) v[i] = col[i];
		const alpha = v[k] >= 0 ? -norm : norm;
		v[k] -= alpha;
		const vv = norm2(v);
		if (!(vv > 0)) break;
		for (let j = k; j < n; j++) reflect(v, vv, cols[j]);
		refl.push(v);
	}
	return { rank: refl.length, reflectors: refl };
}

/** Column norm (after row balancing) below which a column is difference noise. */
const COL_NOISE = 1e-6;
/** Relative threshold below which a pivot counts as zero (the Jacobian is numerical). */
const RANK_TOL = 1e-7;

/** Rows and then columns scaled to unit norm, as the rows of the `rows × cols` matrix `m` (columns of its transpose). */
function balancedRows(m: Float64Array, rows: number, cols: number): number[][] {
	const r: number[][] = [];
	for (let i = 0; i < rows; i++) {
		const row = Array.from(m.subarray(i * cols, (i + 1) * cols));
		const n = Math.sqrt(norm2(row));
		const f = n > 1e-12 && Number.isFinite(n) ? 1 / n : 0;
		r.push(row.map((v) => v * f));
	}
	for (let c = 0; c < cols; c++) {
		let n = 0;
		for (const row of r) n += row[c] * row[c];
		n = Math.sqrt(n);
		// An exactly zero derivative evaluated by differences is noise, not a direction.
		const f = n > COL_NOISE && Number.isFinite(n) ? 1 / n : 0;
		for (const row of r) row[c] *= f;
	}
	return r;
}

/** Numerical rank of a row-major `rows × cols` Jacobian (balanced, then QR with column pivoting). */
export function rankQr(m: Float64Array, rows: number, cols: number): number {
	if (rows === 0 || cols === 0) return 0;
	return qr(balancedRows(m, rows, cols), RANK_TOL, 1e-12).rank;
}

/** Rank and an orthonormal basis of the null space of a row-major `rows × cols` Jacobian (balanced columns). */
export function nullSpace(m: Float64Array, rows: number, cols: number): { rank: number; basis: number[][] } {
	const { rank, reflectors } = rows === 0 ? { rank: 0, reflectors: [] as number[][] } : qr(balancedRows(m, rows, cols), RANK_TOL, 1e-12);
	const basis: number[][] = [];
	for (let j = rank; j < cols; j++) {
		const e = new Array<number>(cols).fill(0);
		e[j] = 1;
		for (let i = reflectors.length - 1; i >= 0; i--) {
			const v = reflectors[i];
			const vv = norm2(v);
			if (vv > 0) reflect(v, vv, e);
		}
		basis.push(e);
	}
	return { rank, basis };
}

export interface SolveOutcome {
	x: number[];
	converged: boolean;
}

/** Runs the solver from `x0`; only `free` parameters change. */
export function solveLm(f: ResidualFn, x0: readonly number[], free: readonly number[], weights: readonly number[], tol: number, maxIter: number): SolveOutcome {
	let x = x0.slice();
	let r: number[] = [];
	f(x, r);
	const rows = r.length;
	if (rows === 0 || maxAbs(r) <= tol) return { x, converged: true };
	if (!free.length || rows > MAX_ROWS) return { x, converged: false };
	const nf = free.length;
	const winv = free.map((j) => 1 / Math.max(weights[j] ?? 1, 1e-12));
	let mu = 1e-10;
	let cost = norm2(r);
	let rn: number[] = [];
	for (let iter = 0; iter < maxIter; iter++) {
		const jac = jacobian(f, x, free, rows);
		// A = J W⁻¹ Jᵀ
		const a = new Float64Array(rows * rows);
		for (let i = 0; i < rows; i++) {
			for (let k = i; k < rows; k++) {
				let s = 0;
				for (let c = 0; c < nf; c++) s += jac[i * nf + c] * jac[k * nf + c] * winv[c];
				a[i * rows + k] = s;
				a[k * rows + i] = s;
			}
		}
		let diagMax = 1e-12;
		for (let i = 0; i < rows; i++) diagMax = Math.max(diagMax, a[i * rows + i]);
		let improved = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			const ad = a.slice();
			for (let i = 0; i < rows; i++) ad[i * rows + i] += mu * diagMax;
			const y = solveDense(ad, Float64Array.from(r), rows);
			if (!y) {
				mu *= 10;
				continue;
			}
			const xn = x.slice();
			free.forEach((j, c) => {
				let s = 0;
				for (let i = 0; i < rows; i++) s += jac[i * nf + c] * y[i];
				xn[j] -= winv[c] * s;
			});
			rn = [];
			f(xn, rn);
			const cn = norm2(rn);
			if (Number.isFinite(cn) && cn < cost) {
				x = xn;
				r = rn;
				cost = cn;
				mu = Math.max(mu * 0.1, 1e-15);
				improved = true;
				break;
			}
			mu *= 10;
		}
		if (maxAbs(r) <= tol) return { x, converged: true };
		if (!improved) break;
	}
	return { x, converged: maxAbs(r) <= tol };
}
