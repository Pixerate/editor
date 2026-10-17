/**
 * Free Distort, perspective and skew: the selection box's corners or sides dragged, and nodes sent
 * through a map of document space while each keeps its own (rigid) transform.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): vectorcraft `crates/tools/src/xform/free.rs` (`distort_quad`: a corner
 * moved freely, or with its partner mirrored along the dominant axis for perspective, and a side's
 * two corners moved together; `shear_for_side`: a side handle shears about the opposite side, or
 * the centre with Alt).
 */
import { mapVectorSubpaths, type VectorPointMap } from './pathMap.js';
import { mapVectorPaint } from './gradient.js';
import { applyMatrix, invertMatrix, multiplyMatrices, nodeMatrix, type AffineMatrix } from './geometry.js';
import { vectorEffectInputBounds, vectorEnvelopeMap, vectorEnvelopeMesh } from './appearance.js';
import { mapVectorMeshPoints } from './warp.js';
import type { Vec2, VectorBounds, VectorEffect, VectorGroupNode, VectorNode, VectorPathNode, VectorTransformHandle } from './types.js';

/** Default tolerance (document units) of Free Distort's adaptive path mapping. */
export const VECTOR_DISTORT_TOLERANCE = 0.05;

/** How dragging a selection box handle distorts it: each corner freely, or in symmetric perspective. */
export type VectorDistortMode = 'distort' | 'perspective';

const CORNER_INDEX: Partial<Record<VectorTransformHandle, number>> = { nw: 0, ne: 1, se: 2, sw: 3 };
const SIDE_CORNERS: Partial<Record<VectorTransformHandle, [number, number]>> = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] };

/** A box's corners clockwise from the top left. */
export const vectorBoxCorners = (b: VectorBounds): Vec2[] => [
	{ x: b.x, y: b.y },
	{ x: b.x + b.width, y: b.y },
	{ x: b.x + b.width, y: b.y + b.height },
	{ x: b.x, y: b.y + b.height }
];

/**
 * The quad (clockwise from the top left) box `b` becomes when handle `handle` is dragged by `d`: a
 * corner moves by `d` (`distort`), or along the drag's dominant axis with the corner beside it on
 * that side moving the opposite way (`perspective`); a side moves both its corners.
 */
export function vectorDistortQuad(b: VectorBounds, handle: VectorTransformHandle, d: Vec2, mode: VectorDistortMode = 'distort'): Vec2[] {
	const q = vectorBoxCorners(b);
	const i = CORNER_INDEX[handle];
	if (i !== undefined) {
		if (mode === 'perspective') {
			if (Math.abs(d.x) >= Math.abs(d.y)) {
				const partner = [1, 0, 3, 2][i];
				q[i].x += d.x;
				q[partner].x -= d.x;
			} else {
				const partner = [3, 2, 1, 0][i];
				q[i].y += d.y;
				q[partner].y -= d.y;
			}
		} else {
			q[i].x += d.x;
			q[i].y += d.y;
		}
		return q;
	}
	const side = SIDE_CORNERS[handle];
	if (side) for (const k of side) q[k] = { x: q[k].x + d.x, y: q[k].y + d.y };
	return q;
}

const about = (o: Vec2, m: AffineMatrix): AffineMatrix => multiplyMatrices(multiplyMatrices([1, 0, 0, 1, -o.x, -o.y], m), [1, 0, 0, 1, o.x, o.y]);

/**
 * The skew for dragging side `handle` of box `b` by `d`: along that side, about the opposite side
 * (or the centre, `fromCenter`). Corners give the identity.
 */
export function vectorShearForSide(b: VectorBounds, handle: VectorTransformHandle, d: Vec2, fromCenter = false): AffineMatrix {
	const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	if (handle === 'n' || handle === 's') {
		const o = fromCenter ? center : { x: center.x, y: handle === 'n' ? b.y + b.height : b.y };
		const lever = (handle === 'n' ? b.y : b.y + b.height) - o.y;
		return about(o, [1, 0, Math.abs(lever) > 1e-9 ? d.x / lever : 0, 1, 0, 0]);
	}
	if (handle === 'e' || handle === 'w') {
		const o = fromCenter ? center : { x: handle === 'w' ? b.x + b.width : b.x, y: center.y };
		const lever = (handle === 'w' ? b.x : b.x + b.width) - o.x;
		return about(o, [1, Math.abs(lever) > 1e-9 ? d.y / lever : 0, 0, 1, 0, 0]);
	}
	return [1, 0, 0, 1, 0, 0];
}

/**
 * A skew by `ax` degrees horizontally (vertical lines lean right for positive angles: x' = x + tan(ax)·y)
 * and `ay` degrees vertically (y' = y + tan(ay)·x), about `origin`.
 */
export function vectorSkewMatrix(ax: number, ay: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
	const tx = Math.tan((ax * Math.PI) / 180);
	const ty = Math.tan((ay * Math.PI) / 180);
	return about(origin, [1, ty, tx, 1, 0, 0]);
}

/** Effects after their node's geometry went through a non-affine map: envelope meshes follow it (a preset becomes the mesh it stood for). */
function mapEffects(node: VectorNode, f: VectorPointMap): VectorEffect[] | undefined {
	if (!node.effects?.length) return undefined;
	return node.effects.map((e) => {
		if (e.type !== 'envelope') return e;
		if (e.params.style === 'mesh') return e.params.mesh ? { ...e, params: { ...e.params, mesh: mapVectorMeshPoints(e.params.mesh, f) } } : e;
		const bounds = vectorEffectInputBounds(node, e.id);
		if (!bounds || !vectorEnvelopeMap(e.params, bounds)) return e;
		return { ...e, params: { ...e.params, style: 'mesh', mesh: mapVectorMeshPoints(vectorEnvelopeMesh(e.params, bounds), f) } };
	});
}

/**
 * A node sent through `f`, a map of the space `parentToDoc` maps its parent to (the document):
 * every anchor and handle is mapped in the node's own space, adaptively so curves stay within
 * `tolerance`, and the node keeps its rigid `transform`. Gradients in the node's space have their
 * handles mapped (bounding-box ones follow the new bounds), envelope meshes and a blend's spine
 * are mapped too; stroke widths, live corner radii and effect parameters are kept.
 */
export function distortVectorNode<T extends VectorNode>(node: T, parentToDoc: AffineMatrix, f: VectorPointMap, tolerance = VECTOR_DISTORT_TOLERANCE): T {
	const toDoc = multiplyMatrices(nodeMatrix(node), parentToDoc);
	const inv = invertMatrix(toDoc);
	const local: VectorPointMap = (p) => applyMatrix(inv, f(applyMatrix(toDoc, p)));
	const effects = mapEffects(node, local);
	if (node.type === 'group') {
		const group = node as VectorGroupNode;
		const children = group.children.map((c) => distortVectorNode(c, toDoc, f, tolerance));
		const spine = group.blend?.spine;
		return {
			...group,
			children,
			...(effects ? { effects } : {}),
			...(spine ? { blend: { ...group.blend, spine: mapVectorSubpaths([spine], local, tolerance)[0] } } : {})
		} as T;
	}
	const path = node as VectorPathNode;
	return {
		...path,
		...(effects ? { effects } : {}),
		...(path.fill !== undefined ? { fill: mapVectorPaint(path.fill, local) } : {}),
		...(path.stroke !== undefined ? { stroke: mapVectorPaint(path.stroke, local) } : {}),
		subpaths: mapVectorSubpaths(path.subpaths, local, tolerance)
	} as T;
}
