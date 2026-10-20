/**
 * Masks and clipping. A group with `mask` set is a mask group: its first (bottom) child is the
 * mask and the children above it (the contents) show only where the mask lets them.
 *
 * - `clip`: a clipping mask, by the mask's outline (every path inside it, filled by its own fill
 *   rule, whatever its paint; the mask's paint is not drawn). Drawn as an SVG `<clipPath>`.
 * - `alpha` / `luminance`: an opacity mask, by the mask's drawn alpha or its brightness (times its
 *   alpha). Drawn as an SVG `<mask>` holding the mask as drawn (`mask-type="alpha"` for alpha).
 * - `invert` swaps what shows and what hides. An inverted clip is the even-odd clip of a large
 *   rectangle with the mask's outline (its boolean union) cut out of it, as pdfcraft's redaction
 *   clips content out of a region; an inverted opacity mask draws the mask through a colour
 *   matrix filter that turns its alpha (or brightness) upside down.
 *
 * Geometry uses the masked result: the contents' shapes clipped by the mask's region (its outline
 * for clips, its painted area for opacity masks) with our booleans, open paths cut where they
 * cross it. Bounds, hit-testing, snapping, outlines, booleans and the Pathfinder all read it
 * through `vectorAppearanceShapes`. An opacity mask is hit and bounded by where it paints at all,
 * not by how strongly: a dark luminance mask still counts.
 *
 * A hidden mask child turns the mask off and the contents draw whole (figcraft
 * `crates/doc/src/geometry.rs`: a hidden mask doesn't clip). The group's own opacity, blend mode
 * and filters apply after masking (its drop shadow follows the masked silhouette), and its path
 * effects act on the contents only, not on the mask.
 *
 * Extension point for lens objects: a lens is a shape that changes what is beneath it (blur,
 * magnify, recolour). It will reuse this module's pieces rather than the mask group model: the
 * region of a shape (`vectorMaskRegionShapes` with the lens as the source) clips a filtered copy
 * of the backdrop the way `vectorMaskRenderData` clips the contents, and hit-testing and bounds
 * stay those of the lens shape itself. See `VectorMaskRenderData` for where a renderer draws it.
 *
 * The mask model (`is_mask`, `MaskType`: alpha, vector, luminance; hidden masks off) follows
 * figcraft `crates/doc/src/node.rs` and `geometry.rs`; clipping a node's drawing to a shape layer
 * by layer follows designcraft `crates/render/src/fx.rs` (`push_clip_layer` around each body); the
 * inverted clip follows pdfcraft `crates/redact/src/interp.rs` (`clip_out`). Ported from ArtCraft
 * (MIT OR Apache-2.0, © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md).
 */
import { bezierPathBounds, bezierPathToSvg, distanceToBezierPath, transformBezierPath, pointInBezierPath, type AffineMatrix, type BezierPath } from '../canvas/pathops/bezier.js';
import { pathBoolean } from '../canvas/pathops/boolean.js';
import { IDENTITY_MATRIX, isIdentityMatrix, multiplyMatrices } from '../geom/affine.js';
import { isVectorFrame, vectorFrameDrawn } from './frames.js';
import { applyVectorEffects, expandVectorAppearance, vectorAppearanceNodes, vectorAppearanceShapes, vectorChildAppearanceShapes, type VectorAppearanceShape } from './appearance.js';
import { bezierToSubpaths, hitTestVectorNode, nodeMatrix, subpathsToBezier, unionBounds, vectorNodeBounds } from './geometry.js';
import { vectorPaintLayerNodes, vectorStrokeStackReach } from './paintLayers.js';
import { eraseFromOutline } from './pathCut.js';
import { vectorStrokeOutlinePath } from './stroke.js';
import { activeVectorFilters, vectorFilterReach, type VectorFilterPrimitive, type VectorRenderFilter } from './filters.js';
import { VECTOR_MASK_TYPES, type VectorBounds, type VectorFillRule, type VectorGroupNode, type VectorMask, type VectorMaskType, type VectorNode, type Vec2 } from './types.js';

/** A group whose `mask` takes effect (not a blend or live boolean, with a child to be the mask). */
export type VectorMaskGroup = VectorGroupNode & { mask: VectorMask };

/** Whether `value` is a mask type. */
export function isVectorMaskType(value: unknown): value is VectorMaskType {
	return typeof value === 'string' && (VECTOR_MASK_TYPES as readonly string[]).includes(value);
}

/** Reads mask settings from untrusted data (JSON, agent input, SVG data attributes); null when invalid. */
export function sanitizeVectorMask(value: unknown): VectorMask | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (!isVectorMaskType(r.type)) return null;
	return r.invert === true ? { type: r.type, invert: true } : { type: r.type };
}

/** Whether a node is a mask group: a group with `mask`, at least one child, and not a blend or live boolean. */
export function isVectorMaskGroup(node: VectorNode | null | undefined): node is VectorMaskGroup {
	return node?.type === 'group' && !!node.mask && isVectorMaskType(node.mask.type) && !node.blend && !node.liveBoolean && node.children.length > 0;
}

/** Whether a mask group's mask is on: its mask child is visible. */
export function isVectorMaskActive(node: VectorNode | null | undefined): node is VectorMaskGroup {
	return isVectorMaskGroup(node) && node.children[0].visible !== false;
}

/** A mask group's mask (its first child), or null. */
export function vectorMaskSource(node: VectorNode | null | undefined): VectorNode | null {
	return isVectorMaskGroup(node) ? node.children[0] : null;
}

/** The children a mask group masks (all but the first); a plain group's children. */
export function vectorMaskContents(group: VectorGroupNode): VectorNode[] {
	return isVectorMaskGroup(group) ? group.children.slice(1) : group.children;
}

/** The mask group whose mask is `id`, or null. */
export function vectorMaskOwner(nodes: readonly VectorNode[], id: string): VectorMaskGroup | null {
	for (const n of nodes) {
		if (n.type !== 'group') continue;
		if (isVectorMaskGroup(n) && n.children[0].id === id) return n;
		const inner = vectorMaskOwner(n.children, id);
		if (inner) return inner;
	}
	return null;
}

/** What agents and panels read about a mask group. */
export interface VectorMaskSummary {
	type: VectorMaskType;
	invert: boolean;
	/** Id of the mask (the group's first child). */
	maskId: string;
	/** Ids of the masked contents, bottom to top. */
	contents: string[];
	/** False while the mask child is hidden (the contents draw whole). */
	enabled: boolean;
}

/** A mask group's settings, mask and contents, or null for any other node. */
export function vectorMaskSummary(node: VectorNode | null | undefined): VectorMaskSummary | null {
	if (!isVectorMaskGroup(node)) return null;
	return {
		type: node.mask.type,
		invert: !!node.mask.invert,
		maskId: node.children[0].id,
		contents: node.children.slice(1).map((c) => c.id),
		enabled: node.children[0].visible !== false
	};
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/** One shape of a mask's region: a path (in the mask group's own space) and the rule that fills it. */
export interface VectorMaskRegionShape {
	path: BezierPath;
	fillRule: VectorFillRule;
}

const place = (path: BezierPath, m: AffineMatrix) => (isIdentityMatrix(m) ? path : transformBezierPath(path, m));

/**
 * The area `node` covers as a mask of `type`, in the space `parent` maps it to: for a clip, the
 * outline of every visible path inside it (effects applied), whatever its paint; for an opacity
 * mask, where it paints (drawn fills, and drawn strokes as their outlines). A nested mask group
 * covers its masked result. `self` counts the node even when hidden (the mask itself).
 */
export function vectorMaskRegionShapes(node: VectorNode, type: VectorMaskType, parent: AffineMatrix = IDENTITY_MATRIX, self = true): VectorMaskRegionShape[] {
	if (!self && node.visible === false) return [];
	// A frame covers what it draws: its fill and its children, clipped to its rectangle.
	if (isVectorFrame(node)) node = vectorFrameDrawn(node);
	const m = multiplyMatrices(nodeMatrix(node), parent);
	if (isVectorMaskActive(node) || (node.type === 'group' && node.effects?.length)) {
		// Drawn as shapes: a nested mask's masked result, or a group's effects applied.
		return vectorAppearanceShapes(node).flatMap((s) => regionOfPath(s.path, s.source, type, m));
	}
	const drawn = expandVectorAppearance(node);
	if (drawn.type === 'group') {
		const inner = multiplyMatrices(nodeMatrix(drawn), parent);
		return drawn.children.flatMap((c) => vectorMaskRegionShapes(c, type, inner, false));
	}
	return regionOfPath(subpathsToBezier(drawn.subpaths), drawn, type, m);
}

function regionOfPath(path: BezierPath, style: VectorNode & { type: 'path' }, type: VectorMaskType, m: AffineMatrix): VectorMaskRegionShape[] {
	if (!path.length) return [];
	const fillRule = style.fillRule ?? 'nonzero';
	if (type === 'clip') return [{ path: place(path, m), fillRule }];
	const out: VectorMaskRegionShape[] = [];
	let filled = false;
	for (const l of vectorPaintLayerNodes(style)) {
		if (!l.drawn) continue;
		if (l.kind === 'fill') {
			if (!filled) out.push({ path: place(path, m), fillRule });
			filled = true;
		} else if ((l.node.strokeWidth ?? 1) > 0) {
			const area = vectorStrokeOutlinePath(path, l.node);
			if (area.length) out.push({ path: place(area, m), fillRule: 'nonzero' });
		}
	}
	return out;
}

const regionCache = new WeakMap<VectorMaskGroup, VectorMaskRegionShape[]>();

/** The region of a mask group's mask in the group's own space (not inverted). Cached per group object. */
export function vectorMaskRegion(group: VectorMaskGroup): VectorMaskRegionShape[] {
	let hit = regionCache.get(group);
	if (!hit) {
		hit = vectorMaskRegionShapes(group.children[0], group.mask.type);
		regionCache.set(group, hit);
	}
	return hit;
}

const unionCache = new WeakMap<VectorMaskGroup, BezierPath>();

/** The mask's region as one clean path (a boolean union, read nonzero or even-odd alike). Cached per group object. */
export function vectorMaskRegionPath(group: VectorMaskGroup): BezierPath {
	let hit = unionCache.get(group);
	if (!hit) {
		const shapes = vectorMaskRegion(group);
		hit = !shapes.length ? [] : shapes.length === 1 && shapes[0].fillRule === 'nonzero' ? shapes[0].path : pathBoolean('union', shapes.map((s) => ({ path: s.path, fillRule: s.fillRule }))).path;
		unionCache.set(group, hit);
	}
	return hit;
}

/** Whether a point (in the group's own space) is inside the mask's region, `tolerance` past its edge counting. */
function inRegion(group: VectorMaskGroup, p: Vec2, tolerance: number): boolean {
	const pt: [number, number] = [p.x, p.y];
	for (const s of vectorMaskRegion(group)) {
		if (pointInBezierPath(s.path, pt, s.fillRule)) return true;
		if (tolerance > 0 && distanceToBezierPath(s.path, pt) <= tolerance) return true;
	}
	return false;
}

/**
 * Whether a mask group's mask lets point `p` (the group's own space) through: inside its region,
 * or outside it when inverted. `tolerance` widens what counts as through (its edge, either way).
 * Always true while the mask is off.
 */
export function vectorMaskContains(group: VectorMaskGroup, p: Vec2, tolerance = 0): boolean {
	if (!isVectorMaskActive(group)) return true;
	if (group.mask.type !== 'clip') {
		// Opacity masks: where the mask paints, by its own hit-test (strokes, alignment, arrowheads).
		const source = group.children[0];
		const hit = hitTestVectorNode(source.visible === false ? { ...source, visible: true } : source, p, group.mask.invert ? 0 : tolerance);
		return group.mask.invert ? !hit || (tolerance > 0 && hitNearEdge(group, p, tolerance)) : hit;
	}
	if (!group.mask.invert) return inRegion(group, p, tolerance);
	return !inRegion(group, p, 0) || hitNearEdge(group, p, tolerance);
}

function hitNearEdge(group: VectorMaskGroup, p: Vec2, tolerance: number): boolean {
	if (tolerance <= 0) return false;
	return vectorMaskRegion(group).some((s) => distanceToBezierPath(s.path, [p.x, p.y]) <= tolerance);
}

// ---------------------------------------------------------------------------
// Masked shapes
// ---------------------------------------------------------------------------

/** A path's open subpaths cut by the region (kept inside it, or outside when inverted). */
function clipOpen(path: BezierPath, region: BezierPath, invert: boolean): BezierPath {
	const out: BezierPath = [];
	for (const sp of bezierToSubpaths(path)) {
		const pieces = eraseFromOutline(sp, region, { keep: invert ? 'outside' : 'inside' });
		// Null: the outline never crosses the region's edge, so it is all in or all out.
		if (pieces === null) {
			const a = sp.anchors[0];
			const inside = !!a && pointInBezierPath(region, [a.x, a.y], 'nonzero');
			if (inside !== invert) out.push(...subpathsToBezier([sp]));
		} else out.push(...subpathsToBezier(pieces));
	}
	return out;
}

/** A shape's path clipped by the mask's region: booleans for its closed contours, cuts for its open ones. */
function clipShapePath(path: BezierPath, fillRule: VectorFillRule, region: BezierPath, invert: boolean): BezierPath {
	const subpaths = bezierToSubpaths(path);
	const closed = subpaths.filter((sp) => sp.closed);
	const open = subpaths.filter((sp) => !sp.closed);
	const out: BezierPath = [];
	if (closed.length) {
		const operands = [{ path: subpathsToBezier(closed), fillRule }, { path: region, fillRule: 'nonzero' as const }];
		out.push(...(region.length ? pathBoolean(invert ? 'difference' : 'intersection', operands).path : invert ? operands[0].path : []));
	}
	if (open.length) out.push(...(region.length ? clipOpen(subpathsToBezier(open), region, invert) : invert ? subpathsToBezier(open) : []));
	return out;
}

/**
 * What a mask group draws as shapes in its own space: its contents' shapes (their own effects
 * applied, then the group's), each clipped by the mask's region. The appearance code calls this
 * for mask groups (`vectorAppearanceShapes`), so use that instead (it caches).
 */
export function vectorMaskedShapes(group: VectorMaskGroup): VectorAppearanceShape[] {
	const contents = group.children.flatMap((c, i) => (i === 0 ? [] : vectorChildAppearanceShapes(c, i)));
	const shapes = applyVectorEffects(contents, group.effects);
	if (!isVectorMaskActive(group)) return shapes;
	const region = vectorMaskRegionPath(group);
	const invert = !!group.mask.invert;
	const out: VectorAppearanceShape[] = [];
	for (const s of shapes) {
		const path = clipShapePath(s.path, s.source.fillRule ?? 'nonzero', region, invert);
		// Keep the shape's evaluated paths in the clip's clean nonzero form.
		if (path.length) out.push({ ...s, path, source: s.source.fillRule === 'evenodd' ? { ...s.source, fillRule: 'nonzero' } : s.source });
	}
	return out;
}

/**
 * The node with every working mask group inside it replaced by a plain group of its masked shapes
 * (ids `<group id>~fx<n>`, placement kept): the geometry booleans, the Pathfinder, the Shape
 * Builder and the paint bucket work with. The node itself when it holds no mask.
 */
export function vectorMaskedGeometry(node: VectorNode): VectorNode {
	if (node.type !== 'group') return node;
	if (isVectorMaskActive(node)) {
		return {
			id: node.id,
			type: 'group',
			...(node.transform ? { transform: node.transform } : {}),
			...(node.opacity !== undefined ? { opacity: node.opacity } : {}),
			...(node.visible === false ? { visible: false } : {}),
			...(node.locked ? { locked: true } : {}),
			children: vectorAppearanceNodes(node)
		};
	}
	let changed = false;
	const children = node.children.map((c) => {
		const next = vectorMaskedGeometry(c);
		if (next !== c) changed = true;
		return next;
	});
	return changed ? { ...node, children } : node;
}

/** Bounds of a mask group's masked result in its own space (stroke widths not included), or null. */
export function vectorMaskedLocalBounds(group: VectorMaskGroup): VectorBounds | null {
	const b = bezierPathBounds(vectorAppearanceShapes(group).flatMap((s) => s.path));
	return b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
}

// ---------------------------------------------------------------------------
// Render data
// ---------------------------------------------------------------------------

/** How far anything inside a node draws past its geometry: strokes, and filters on the way down. */
function paintReach(node: VectorNode): number {
	const own = vectorFilterReach(activeVectorFilters(node));
	if (node.type === 'path') return own + vectorStrokeStackReach(node);
	if (node.type === 'text' || node.type === 'instance') return own + paintReach(expandVectorAppearance(node));
	return own + Math.max(0, ...node.children.map(paintReach));
}

/**
 * The box a mask group's contents can draw over, in its own space (strokes and filters included,
 * with a margin): the `<mask>` region, the filter region of an inverted opacity mask and the
 * rectangle an inverted clip cuts the mask out of. Null without contents.
 */
export function vectorMaskContentBounds(group: VectorMaskGroup): VectorBounds | null {
	const contents = group.children.slice(1);
	const b = unionBounds(contents.map((c) => vectorNodeBounds(c, IDENTITY_MATRIX)));
	if (!b) return null;
	const pad = Math.max(0, ...contents.map(paintReach)) + Math.max(b.width, b.height) * 0.05 + 4;
	return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

/** One path of a clipping mask's `<clipPath>` (group space). */
export interface VectorMaskClipShape {
	d: string;
	clipRule: VectorFillRule;
}

/**
 * How to draw a mask group's mask, in the group's own space. Draw the group's own `<g>` (transform,
 * opacity, blend mode, filter) holding an inner `<g>` with the contents, referencing:
 * - `clip`: a `<clipPath id>` holding each of `clip` as `<path d clip-rule>`;
 * - `alpha` / `luminance`: a `<mask id maskUnits="userSpaceOnUse" x y width height>` over
 *   `bounds` (with `mask-type="alpha"` for alpha) holding the mask node as drawn, wrapped in
 *   `<g filter={filter}>` when `filter` is set (an inverted mask).
 */
export interface VectorMaskRenderData {
	type: VectorMaskType;
	invert: boolean;
	/** Id of the `<clipPath>` or `<mask>` element. */
	id: string;
	/** Clip shapes (clipping masks). An inverted clip is one even-odd shape: a rectangle with the mask's outline cut out. */
	clip?: VectorMaskClipShape[];
	/** Region of the `<mask>` (opacity masks). */
	bounds?: VectorBounds;
	/** `url(#id)` of the inverting filter (inverted opacity masks; in `filters`). */
	filter?: string;
	/** The inverting filter itself (inverted opacity masks). */
	invertFilter?: VectorRenderFilter;
}

const fe = (tag: string, attrs: Record<string, string | number>): VectorFilterPrimitive => ({ tag, attrs });
const LUMA = '-0.2125 -0.7154 -0.0721 0 1';

/** The filter that inverts an opacity mask over `bounds`: alpha → 1 − alpha, or brightness → 1 − brightness over black. */
function invertFilter(type: 'alpha' | 'luminance', id: string, bounds: VectorBounds): VectorRenderFilter {
	const primitives =
		type === 'alpha'
			? [fe('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 1' })]
			: [
					// Over black first, so a transparent area reads as dark (hidden) before inverting.
					fe('feFlood', { 'flood-color': '#000000', result: 'black' }),
					fe('feComposite', { in: 'SourceGraphic', in2: 'black', operator: 'over', result: 'flat' }),
					fe('feColorMatrix', { in: 'flat', type: 'matrix', values: `${LUMA} ${LUMA} ${LUMA} 0 0 0 0 1` })
				];
	const r = (n: number) => Math.round(n * 1000) / 1000;
	return { id, x: r(bounds.x), y: r(bounds.y), width: r(bounds.width), height: r(bounds.height), primitives };
}

const rectPath = (b: VectorBounds): BezierPath => [
	{ type: 'M', x: b.x, y: b.y },
	{ type: 'L', x: b.x + b.width, y: b.y },
	{ type: 'L', x: b.x + b.width, y: b.y + b.height },
	{ type: 'L', x: b.x, y: b.y + b.height },
	{ type: 'Z' }
];

/**
 * A mask group's mask as render data with element id `id` (and `filterId` for an inverting
 * filter), or null when the mask is off or the group has no contents. Shared by the canvases and
 * SVG export.
 */
export function vectorMaskRenderData(group: VectorMaskGroup, id: string, filterId: string, precision = 3): VectorMaskRenderData | null {
	if (!isVectorMaskActive(group) || group.children.length < 2) return null;
	const invert = !!group.mask.invert;
	const bounds = vectorMaskContentBounds(group);
	if (group.mask.type === 'clip') {
		const shapes = vectorMaskRegion(group);
		if (!invert) return { type: 'clip', invert, id, clip: shapes.map((s) => ({ d: bezierPathToSvg(s.path, { precision }), clipRule: s.fillRule })) };
		// Inverted (pdfcraft `clip_out`): a rectangle round the contents with the mask's union cut out, even-odd.
		const box = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
		const region = vectorMaskRegionPath(group);
		return { type: 'clip', invert, id, clip: [{ d: bezierPathToSvg([...rectPath(box), ...region], { precision }), clipRule: 'evenodd' }] };
	}
	if (!bounds) return null;
	if (!invert) return { type: group.mask.type, invert, id, bounds };
	const filter = invertFilter(group.mask.type, filterId, bounds);
	return { type: group.mask.type, invert, id, bounds, filter: `url(#${filterId})`, invertFilter: filter };
}
