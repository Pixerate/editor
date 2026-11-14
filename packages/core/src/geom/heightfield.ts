/**
 * Heightfield meshes (#807): a surface `y = height(x, z)` over a rectangle, closed by side walls
 * and a floor into a watertight solid (every edge shared by exactly two triangles, all facing
 * out), with smooth normals. Pure arrays a renderer turns into geometry
 * (`@pixerate/editor/three` `heightfieldGeometry`), for terrain-like surfaces and relief on 3-D
 * chart tops.
 */

export interface HeightfieldOptions {
	/** The rectangle, in x from `x0` to `x1` and z from `z0` to `z1`. */
	x0: number;
	x1: number;
	z0: number;
	z1: number;
	/** Grid segments along x and z (default 32 × 8). */
	resolution?: readonly [number, number];
	/** The floor's height (default 0). Heights below it are raised to it. */
	base?: number;
}

export interface Heightfield {
	/** x y z per vertex: the top grid, then the floor grid. */
	positions: Float32Array;
	normals: Float32Array;
	/** Three vertex indices per triangle, counter-clockwise seen from outside. */
	indices: Uint32Array;
	/** The top surface's height at each grid point, row by row (z), then along x. */
	heights: Float64Array;
	/** Grid points along x and z. */
	columns: number;
	rows: number;
}

/** The watertight solid under `height(x, z)` over the options' rectangle. */
export function heightfield(height: (x: number, z: number) => number, options: HeightfieldOptions): Heightfield {
	const nx = Math.max(1, Math.floor(options.resolution?.[0] ?? 32));
	const nz = Math.max(1, Math.floor(options.resolution?.[1] ?? 8));
	const base = options.base ?? 0;
	const columns = nx + 1;
	const rows = nz + 1;
	const count = columns * rows;
	const positions = new Float32Array(count * 2 * 3);
	const heights = new Float64Array(count);
	const at = (i: number, k: number) => k * columns + i;
	for (let k = 0; k < rows; k++) {
		const z = options.z0 + ((options.z1 - options.z0) * k) / nz;
		for (let i = 0; i < columns; i++) {
			const x = options.x0 + ((options.x1 - options.x0) * i) / nx;
			const raw = height(x, z);
			const y = Number.isFinite(raw) ? Math.max(base, raw) : base;
			const v = at(i, k);
			heights[v] = y;
			positions.set([x, y, z], v * 3);
			positions.set([x, base, z], (count + v) * 3);
		}
	}
	const tris: number[] = [];
	// The top faces +y, the floor −y (x and z run the usual right-handed way, y up).
	for (let k = 0; k < nz; k++) {
		for (let i = 0; i < nx; i++) {
			const a = at(i, k), b = at(i + 1, k), c = at(i, k + 1), d = at(i + 1, k + 1);
			tris.push(a, c, b, b, c, d);
			tris.push(count + a, count + b, count + c, count + b, count + d, count + c);
		}
	}
	// Side walls round the edge of the grid, going round anticlockwise seen from above.
	const ring: number[] = [];
	for (let i = 0; i < nx; i++) ring.push(at(i, 0));
	for (let k = 0; k < nz; k++) ring.push(at(nx, k));
	for (let i = nx; i > 0; i--) ring.push(at(i, nz));
	for (let k = nz; k > 0; k--) ring.push(at(0, k));
	for (let r = 0; r < ring.length; r++) {
		const top0 = ring[r]!, top1 = ring[(r + 1) % ring.length]!;
		tris.push(top0, top1, count + top0, top1, count + top1, count + top0);
	}
	const indices = Uint32Array.from(tris);
	// Smooth normals: each vertex the area-weighted sum of its faces' normals.
	const normals = new Float32Array(positions.length);
	for (let t = 0; t < indices.length; t += 3) {
		const ia = indices[t]! * 3, ib = indices[t + 1]! * 3, ic = indices[t + 2]! * 3;
		const ux = positions[ib]! - positions[ia]!, uy = positions[ib + 1]! - positions[ia + 1]!, uz = positions[ib + 2]! - positions[ia + 2]!;
		const vx = positions[ic]! - positions[ia]!, vy = positions[ic + 1]! - positions[ia + 1]!, vz = positions[ic + 2]! - positions[ia + 2]!;
		const nx3 = uy * vz - uz * vy, ny3 = uz * vx - ux * vz, nz3 = ux * vy - uy * vx;
		for (const i of [ia, ib, ic]) {
			normals[i] += nx3;
			normals[i + 1] += ny3;
			normals[i + 2] += nz3;
		}
	}
	for (let i = 0; i < normals.length; i += 3) {
		const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
		normals[i] /= len;
		normals[i + 1] /= len;
		normals[i + 2] /= len;
	}
	return { positions, normals, indices, heights, columns, rows };
}
