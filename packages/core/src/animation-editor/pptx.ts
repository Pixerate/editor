// Preset IDs and timing reading adapted from deckcraft-main/crates/model/src/anim.rs (`ANIMATIONS`) and crates/pptx/src/read/timing.rs (`collect`, `animations`), MIT OR Apache-2.0, © ArtCraft Team and contributors.
import type { AnimationEasing } from '../animation/easing.js';
import { readZip, type ZipArchive, type ZipReadOptions } from '../import/zip.js';
import { ellipseSubpath, rectSubpath } from '../vector/geometry.js';
import type { VectorDocument, VectorNode, VectorPathNode, VectorSubpath } from '../vector/types.js';
import { checkMotionScene } from './check.js';
import type { MotionIssue } from './issues.js';
import { motionSceneShapeProblems } from './parse.js';
import type { MotionCommand, MotionDirection, MotionScene, MotionShot } from './types.js';

/**
 * Import a PowerPoint slide's animation: the slide's shapes become the artwork and its animation
 * pane (`p:timing`) becomes shots, a shot per click, so a slide built in PowerPoint can be opened,
 * edited and exported here.
 *
 * - Shapes: rectangles, rounded rectangles, ellipses, triangles, diamonds, lines and custom
 *   geometry with their position, size, rotation, flips, solid fill and outline (theme colours
 *   read from the theme). Groups keep their children. Text, pictures, charts and tables are left
 *   out with a note (the artwork has no text).
 * - Animation: entrance, exit and emphasis effects map to the editor's commands (fly in → slide,
 *   wipe → wipe, zoom → zoom, pulse → pulse, spin → rotate…), motion paths to a follow along a
 *   hidden path. "On click" starts a shot, "with previous" and "after previous" keep their timing,
 *   delays, repeats, auto-reverse and acceleration carry over. Effects with no match fade, noted.
 */

export interface PptxAnimationImportOptions extends ZipReadOptions {
	/** Which slide (1 = first, default 1). */
	slide?: number;
	/** `DOMParser` constructor (default: the global one; pass jsdom's or xmldom's in Node). */
	DOMParser?: { new (): DOMParser };
}

export interface PptxAnimationImport {
	scene: MotionScene;
	/** What could not be carried over, in sentences. */
	notes: string[];
	issues: MotionIssue[];
	/** How many slides the file has. */
	slides: number;
}

const EMU = 9525; // EMU per CSS pixel

const kids = (el: Element | null | undefined, name: string): Element[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
const deep = (el: Element | Document | null | undefined, name: string): Element[] => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
const num = (el: Element | null | undefined, attr: string, fallback = 0) => {
	const v = el?.getAttribute(attr);
	const n = v === null || v === undefined ? NaN : Number(v);
	return Number.isFinite(n) ? n : fallback;
};
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
function resolve(base: string, target: string): string {
	const out: string[] = [];
	for (const seg of (target.startsWith('/') ? target.slice(1) : base + target).split('/')) {
		if (seg === '..') out.pop();
		else if (seg && seg !== '.') out.push(seg);
	}
	return out.join('/');
}

interface Ctx {
	zip: ZipArchive;
	Parser: { new (): DOMParser };
	notes: string[];
	theme: Map<string, string>;
	nodes: Map<number, string>;
	used: Set<string>;
}

async function xml(ctx: Ctx, path: string): Promise<Document | null> {
	if (!ctx.zip.has(path)) return null;
	const text = new TextDecoder().decode(await ctx.zip.read(path));
	const doc = new ctx.Parser().parseFromString(text, 'application/xml');
	return doc.getElementsByTagName('parsererror').length ? null : doc;
}

async function rels(ctx: Ctx, part: string): Promise<Map<string, string>> {
	const doc = await xml(ctx, `${dirname(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`);
	const out = new Map<string, string>();
	for (const r of deep(doc, 'Relationship')) if (r.getAttribute('TargetMode') !== 'External') out.set(r.getAttribute('Id') ?? '', resolve(dirname(part), r.getAttribute('Target') ?? ''));
	return out;
}

/** A DrawingML colour element (`a:srgbClr`, `a:schemeClr`, `a:sysClr`, `a:prstClr`) as `#rrggbb`. */
function colour(ctx: Ctx, holder: Element | null): string | null {
	if (!holder) return null;
	const c = holder.firstElementChild;
	if (!c) return null;
	let hex: string | null = null;
	if (c.localName === 'srgbClr') hex = `#${(c.getAttribute('val') ?? '000000').toLowerCase()}`;
	else if (c.localName === 'sysClr') hex = `#${(c.getAttribute('lastClr') ?? '000000').toLowerCase()}`;
	else if (c.localName === 'schemeClr') {
		const name = c.getAttribute('val') ?? '';
		const alias: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
		hex = ctx.theme.get(alias[name] ?? name) ?? null;
	} else if (c.localName === 'prstClr') hex = ({ black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff' } as Record<string, string>)[c.getAttribute('val') ?? ''] ?? null;
	if (!hex || !/^#[0-9a-f]{6}$/.test(hex)) return null;
	// Shade and tint, roughly.
	const lum = kid(c, 'lumMod');
	if (lum) {
		const k = num(lum, 'val', 100000) / 100000;
		const off = num(kid(c, 'lumOff'), 'val', 0) / 100000;
		hex = `#${[1, 3, 5].map((i) => Math.round(Math.min(255, Math.max(0, parseInt(hex!.slice(i, i + 2), 16) * k + 255 * off))).toString(16).padStart(2, '0')).join('')}`;
	}
	return hex;
}

/** Preset geometry in a box (local units), or null when not drawn here. */
function preset(prst: string, w: number, h: number): VectorSubpath[] | null {
	const poly = (pts: [number, number][]): VectorSubpath[] => [{ closed: true, anchors: pts.map(([x, y]) => ({ x, y })) }];
	switch (prst) {
		case 'rect':
			return [rectSubpath({ x: 0, y: 0, width: w, height: h })];
		case 'roundRect':
			return [rectSubpath({ x: 0, y: 0, width: w, height: h }, Math.min(w, h) * 0.16667)];
		case 'ellipse':
			return [ellipseSubpath({ x: 0, y: 0, width: w, height: h })];
		case 'triangle':
			return poly([[w / 2, 0], [w, h], [0, h]]);
		case 'rtTriangle':
			return poly([[0, 0], [w, h], [0, h]]);
		case 'diamond':
			return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
		case 'parallelogram':
			return poly([[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]]);
		case 'hexagon':
			return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
		case 'line':
		case 'straightConnector1':
			return [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: w, y: h }] }];
		default:
			return null;
	}
}

/** Custom geometry (`a:custGeom`) in a box, scaled from each path's own size. */
function custom(geom: Element, w: number, h: number): VectorSubpath[] {
	const out: VectorSubpath[] = [];
	for (const path of deep(geom, 'path')) {
		const sx = w / (num(path, 'w') || w || 1);
		const sy = h / (num(path, 'h') || h || 1);
		const pt = (el: Element) => ({ x: num(el, 'x') * sx, y: num(el, 'y') * sy });
		let cur: VectorSubpath | null = null;
		for (const cmd of Array.from(path.children)) {
			const pts = kids(cmd, 'pt').map(pt);
			if (cmd.localName === 'moveTo' && pts[0]) {
				if (cur) out.push(cur);
				cur = { closed: false, anchors: [{ x: pts[0].x, y: pts[0].y }] };
			} else if (!cur) continue;
			else if (cmd.localName === 'lnTo' && pts[0]) cur.anchors.push({ x: pts[0].x, y: pts[0].y });
			else if (cmd.localName === 'cubicBezTo' && pts.length === 3) {
				cur.anchors[cur.anchors.length - 1].out = pts[0];
				cur.anchors.push({ x: pts[2].x, y: pts[2].y, in: pts[1] });
			} else if (cmd.localName === 'quadBezTo' && pts.length === 2) {
				const p0 = cur.anchors[cur.anchors.length - 1];
				cur.anchors[cur.anchors.length - 1].out = { x: p0.x + (2 / 3) * (pts[0].x - p0.x), y: p0.y + (2 / 3) * (pts[0].y - p0.y) };
				cur.anchors.push({ x: pts[1].x, y: pts[1].y, in: { x: pts[1].x + (2 / 3) * (pts[0].x - pts[1].x), y: pts[1].y + (2 / 3) * (pts[0].y - pts[1].y) } });
			} else if (cmd.localName === 'close') {
				cur.closed = true;
				out.push(cur);
				cur = null;
			}
		}
		if (cur) out.push(cur);
	}
	return out;
}

/** A shape's box (pixels in its parent's space) and its transform: rotation and flips about its centre. */
function placement(xfrm: Element | null, map: (x: number, y: number, w: number, h: number) => [number, number, number, number]) {
	const off = kid(xfrm, 'off');
	const ext = kid(xfrm, 'ext');
	const [x, y, w, h] = map(num(off, 'x'), num(off, 'y'), num(ext, 'cx'), num(ext, 'cy'));
	const rot = (num(xfrm, 'rot') / 60000) * (Math.PI / 180);
	const fx = xfrm?.getAttribute('flipH') === '1' ? -1 : 1;
	const fy = xfrm?.getAttribute('flipV') === '1' ? -1 : 1;
	const cx = x + w / 2;
	const cy = y + h / 2;
	const cos = Math.cos(rot);
	const sin = Math.sin(rot);
	// translate(x, y) then flip and rotate about the centre.
	const a = cos * fx;
	const b = sin * fx;
	const c = -sin * fy;
	const d = cos * fy;
	const e = cx - a * (w / 2) - c * (h / 2);
	const f = cy - b * (w / 2) - d * (h / 2);
	// `+ 0` turns -0 (sin 0 negated) into 0.
	return { x, y, w, h, transform: [a, b, c, d, e, f].map((v) => v + 0) as [number, number, number, number, number, number] };
}

const idFor = (ctx: Ctx, spid: number, name: string) => {
	const base = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shape'}-${spid}`;
	let id = base;
	for (let k = 2; ctx.used.has(id); k++) id = `${base}-${k}`;
	ctx.used.add(id);
	ctx.nodes.set(spid, id);
	return id;
};

function shapes(ctx: Ctx, tree: Element, map: (x: number, y: number, w: number, h: number) => [number, number, number, number]): VectorNode[] {
	const out: VectorNode[] = [];
	for (const el of Array.from(tree.children)) {
		const nv = el.firstElementChild;
		const cNvPr = kid(nv, 'cNvPr');
		const spid = num(cNvPr, 'id', -1);
		const name = cNvPr?.getAttribute('name') ?? '';
		if (el.localName === 'grpSp') {
			const xfrm = kid(kid(el, 'grpSpPr'), 'xfrm');
			const off = kid(xfrm, 'off');
			const ext = kid(xfrm, 'ext');
			const chOff = kid(xfrm, 'chOff');
			const chExt = kid(xfrm, 'chExt');
			const sx = num(ext, 'cx') / (num(chExt, 'cx') || num(ext, 'cx') || 1);
			const sy = num(ext, 'cy') / (num(chExt, 'cy') || num(ext, 'cy') || 1);
			const inner = (x: number, y: number, w: number, h: number) => map(num(off, 'x') + (x - num(chOff, 'x')) * sx, num(off, 'y') + (y - num(chOff, 'y')) * sy, w * sx, h * sy);
			const id = idFor(ctx, spid, name || 'group');
			out.push({ id, type: 'group', ...(name ? { name } : {}), children: shapes(ctx, el, inner) });
			continue;
		}
		if (el.localName === 'pic' || el.localName === 'graphicFrame') {
			ctx.notes.push(`"${name || `shape ${spid}`}" is a ${el.localName === 'pic' ? 'picture' : 'chart, table or diagram'}, which the artwork cannot hold; it was left out.`);
			continue;
		}
		if (el.localName !== 'sp' && el.localName !== 'cxnSp') continue;
		const spPr = kid(el, 'spPr');
		const { w, h, transform } = placement(kid(spPr, 'xfrm'), map);
		const prst = kid(spPr, 'prstGeom')?.getAttribute('prst');
		const cust = kid(spPr, 'custGeom');
		let subpaths = cust ? custom(cust, w, h) : prst ? preset(prst, w, h) : null;
		if (!subpaths) {
			if (prst) ctx.notes.push(`"${name}" is a ${prst}, drawn as its bounding rectangle.`);
			subpaths = [rectSubpath({ x: 0, y: 0, width: w, height: h })];
		}
		const style = kid(el, 'style');
		const fill = kid(spPr, 'noFill') ? null : (colour(ctx, kid(spPr, 'solidFill')) ?? (el.localName === 'cxnSp' ? null : colour(ctx, kid(style, 'fillRef'))));
		const ln = kid(spPr, 'ln');
		const stroke = kid(ln, 'noFill') ? null : (colour(ctx, kid(ln, 'solidFill')) ?? colour(ctx, kid(style, 'lnRef')));
		if (kid(spPr, 'gradFill')) ctx.notes.push(`"${name}" has a gradient fill, imported as its first colour or none.`);
		const text = deep(kid(el, 'txBody'), 't').map((t) => t.textContent ?? '').join('').trim();
		if (text) ctx.notes.push(`"${name}" has text ("${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"), which the artwork cannot hold; only its shape was imported.`);
		const node: VectorPathNode = {
			id: idFor(ctx, spid, name),
			type: 'path',
			...(name ? { name } : {}),
			transform,
			fill: fill ?? (kid(spPr, 'gradFill') ? colour(ctx, kid(deep(spPr, 'gs')[0], 'srgbClr') ? deep(spPr, 'gs')[0] : null) : null),
			stroke,
			strokeWidth: Math.max(0.5, (num(ln, 'w', 12700) || 12700) / EMU),
			subpaths
		};
		out.push(node);
	}
	return out;
}

const DIRECTION_FROM: Record<number, MotionDirection> = { 1: 'down', 2: 'left', 4: 'up', 8: 'right' }; // "from top" travels down…
const DIRECTION_TO: Record<number, MotionDirection> = { 1: 'up', 2: 'right', 4: 'down', 8: 'left' };

/** PowerPoint's acceleration / deceleration as a cubic-bezier ease, or undefined for the command's own. */
function easeOf(ctn: Element): AnimationEasing | undefined {
	const accel = num(ctn, 'accel') / 100000;
	const decel = num(ctn, 'decel') / 100000;
	if (!accel && !decel) return undefined;
	return { type: 'cubic-bezier', x1: Math.min(1, accel), y1: 0, x2: Math.max(0, 1 - decel), y2: 1 };
}

/** One effect of the animation pane as a command, or null with a note. */
function command(ctx: Ctx, ctn: Element, scene: { width: number; height: number }, artwork: VectorNode[], target: string, hidden: VectorNode[]): MotionCommand | null {
	const cls = ctn.getAttribute('presetClass');
	const id = num(ctn, 'presetID');
	const sub = num(ctn, 'presetSubtype');
	const durs = [ctn, ...deep(ctn, 'cTn')].map((c) => num(c, 'dur', NaN)).filter(Number.isFinite);
	const duration = durs.length ? Math.max(...durs) : undefined;
	const ease = easeOf(ctn);
	const base = { targets: [target], ...(duration !== undefined ? { duration } : {}), ...(ease ? { ease } : {}) };
	const repeat = num(ctn, 'repeatCount', 1000) / 1000;
	const auto = ctn.getAttribute('autoRev') === '1';
	const timing = auto || repeat > 1 ? { repeat: Math.max(1, Math.round(repeat)) * (auto ? 2 : 1), ...(auto ? { repeatMode: 'mirror' as const } : {}) } : {};
	const label = `${cls} effect ${id} on "${target}"`;
	if (cls === 'entr') {
		const by: Record<number, MotionCommand> = {
			1: { type: 'enter', ...base, duration: 0 },
			2: { type: 'enter', style: 'slide', ...base, direction: DIRECTION_FROM[sub] ?? 'up', distance: Math.round(Math.max(scene.width, scene.height) / 3) },
			10: { type: 'enter', style: 'fade', ...base },
			9: { type: 'enter', style: 'fade', ...base },
			22: { type: 'enter', style: 'wipe', ...base, direction: DIRECTION_FROM[sub] ?? 'right' },
			16: { type: 'enter', style: 'split', ...base, orientation: sub === 26 || sub === 42 ? 'vertical' : 'horizontal' },
			6: { type: 'enter', style: 'iris', ...base, shape: 'circle' },
			4: { type: 'enter', style: 'iris', ...base, shape: 'box' },
			53: { type: 'enter', style: 'zoom', ...base },
			23: { type: 'enter', style: 'zoom', ...base },
			31: { type: 'enter', style: 'pop', ...base },
			26: { type: 'enter', style: 'pop', ...base },
			55: { type: 'enter', style: 'grow', ...base },
			37: { type: 'enter', style: 'rise', ...base },
			42: { type: 'enter', style: 'rise', ...base }
		};
		if (by[id]) return by[id];
		ctx.notes.push(`${label} has no match here; it fades in instead.`);
		return { type: 'enter', style: 'fade', ...base };
	}
	if (cls === 'exit') {
		const by: Record<number, MotionCommand> = {
			1: { type: 'exit', ...base, duration: 0 },
			10: { type: 'exit', style: 'fade', ...base },
			9: { type: 'exit', style: 'fade', ...base },
			2: { type: 'exit', style: 'slide', ...base, direction: DIRECTION_TO[sub] ?? 'down', distance: Math.round(Math.max(scene.width, scene.height) / 3) },
			22: { type: 'exit', style: 'wipe', ...base, direction: DIRECTION_TO[sub] ?? 'right' },
			53: { type: 'exit', style: 'shrink', ...base },
			31: { type: 'exit', style: 'shrink', ...base }
		};
		if (by[id]) return by[id];
		ctx.notes.push(`${label} has no match here; it fades out instead.`);
		return { type: 'exit', style: 'fade', ...base };
	}
	if (cls === 'emph') {
		const rot = deep(ctn, 'animRot')[0];
		const scale = kid(deep(ctn, 'animScale')[0], 'by');
		const clr = colour(ctx, kid(deep(ctn, 'animClr')[0], 'to'));
		switch (id) {
			case 26:
				return { type: 'pulse', ...base, ...timing };
			case 27:
				return { type: 'color-pulse', ...base, ...(clr ? { color: clr } : {}), ...timing };
			case 32:
				return { type: 'teeter', ...base, ...timing };
			case 34:
				return { type: 'wave', ...base, ...timing };
			case 8:
				return { type: 'rotate', ...base, by: rot ? num(rot, 'by') / 60000 : 360, ...timing };
			case 6:
				return { type: 'scale', ...base, to: scale ? { x: num(scale, 'x', 100000) / 100000, y: num(scale, 'y', 100000) / 100000 } : 1.5, ...timing };
			case 9:
				return { type: 'fade', ...base, to: 0.5, ...timing };
			case 1:
			case 19:
				return clr ? { type: 'style', ...base, fill: clr, ...timing } : null;
			case 7:
				return clr ? { type: 'style', ...base, stroke: clr, ...timing } : null;
		}
		ctx.notes.push(`${label} has no match here and was skipped.`);
		return null;
	}
	if (cls === 'path') {
		const motion = deep(ctn, 'animMotion')[0];
		const d = motion?.getAttribute('path');
		if (!d) return null;
		// The path is in fractions of the slide, from where the shape is.
		const entry = artwork.flatMap(function all(n: VectorNode): VectorNode[] { return n.type === 'group' ? [n, ...n.children.flatMap(all)] : [n]; }).find((n) => n.id === target);
		const t = entry?.transform ?? [1, 0, 0, 1, 0, 0];
		const p = entry?.type === 'path' ? entry.subpaths[0]?.anchors : undefined;
		const xs = (p ?? []).map((a) => a.x);
		const ys = (p ?? []).map((a) => a.y);
		const lx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
		const ly = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
		const cx = t[0] * lx + t[2] * ly + t[4];
		const cy = t[1] * lx + t[3] * ly + t[5];
		const nums = d.match(/[MLCZE]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
		const sp: VectorSubpath = { closed: false, anchors: [] };
		let i = 0;
		const read = () => ({ x: cx + Number(nums[i++]) * scene.width, y: cy + Number(nums[i++]) * scene.height });
		while (i < nums.length) {
			const c = nums[i++].toUpperCase();
			if (c === 'M' || c === 'L') sp.anchors.push(read());
			else if (c === 'C') {
				const c1 = read();
				const c2 = read();
				const e = read();
				if (sp.anchors.length) sp.anchors[sp.anchors.length - 1].out = c1;
				sp.anchors.push({ ...e, in: c2 });
			} else if (c === 'Z') sp.closed = true;
		}
		if (sp.anchors.length < 2) return null;
		const pathId = `${target}-path-${hidden.length + 1}`;
		hidden.push({ id: pathId, type: 'path', name: 'Motion path', visible: false, fill: null, stroke: '#94a3b8', subpaths: [sp] });
		return { type: 'follow', ...base, path: pathId, ...timing };
	}
	return null;
}

/** A PowerPoint slide's shapes and animation as a scene (see the module notes). */
export async function fromPptxAnimation(data: ArrayBuffer | ArrayBufferView, options: PptxAnimationImportOptions = {}): Promise<PptxAnimationImport> {
	const Parser = options.DOMParser ?? (globalThis as { DOMParser?: { new (): DOMParser } }).DOMParser;
	if (!Parser) throw new Error('No DOMParser: pass one in options (jsdom\'s or xmldom\'s in Node).');
	let zip: ZipArchive;
	try {
		zip = await readZip(data, options);
	} catch (error) {
		throw new Error(`This is not a PowerPoint file (.pptx): ${(error as Error).message}`);
	}
	const ctx: Ctx = { zip, Parser, notes: [], theme: new Map(), nodes: new Map(), used: new Set() };
	const pres = await xml(ctx, 'ppt/presentation.xml');
	if (!pres) throw new Error('This is not a PowerPoint file (.pptx): it has no ppt/presentation.xml.');
	const presRels = await rels(ctx, 'ppt/presentation.xml');
	const slidePaths = deep(pres, 'sldId').map((s) => presRels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id') ?? '') ?? '').filter(Boolean);
	const n = options.slide ?? 1;
	if (!(Number.isInteger(n) && n >= 1 && n <= slidePaths.length)) throw new Error(`There is no slide ${n}; the file has ${slidePaths.length} slide${slidePaths.length === 1 ? '' : 's'}.`);
	const size = deep(pres, 'sldSz')[0];
	const width = Math.round(num(size, 'cx', 12192000) / EMU);
	const height = Math.round(num(size, 'cy', 6858000) / EMU);
	for (const [, path] of presRels) {
		if (!path.includes('theme/')) continue;
		const theme = await xml(ctx, path);
		const scheme = deep(theme, 'clrScheme')[0];
		for (const c of Array.from(scheme?.children ?? [])) {
			const v = c.firstElementChild;
			const hex = v?.localName === 'srgbClr' ? v.getAttribute('val') : v?.getAttribute('lastClr');
			if (hex) ctx.theme.set(c.localName, `#${hex.toLowerCase()}`);
		}
		break;
	}
	const slide = await xml(ctx, slidePaths[n - 1]);
	if (!slide) throw new Error(`Slide ${n} cannot be read.`);
	const tree = deep(slide, 'spTree')[0];
	const toPx = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x / EMU, y / EMU, w / EMU, h / EMU];
	const nodes = tree ? shapes(ctx, tree, toPx) : [];
	const bg = colour(ctx, deep(deep(slide, 'bg')[0], 'solidFill')[0] ?? null) ?? '#ffffff';

	// The animation pane: effects in order, a shot per click.
	const hidden: VectorNode[] = [];
	const shots: MotionShot[] = [];
	const effects = deep(deep(slide, 'timing')[0], 'cTn').filter((c) => c.hasAttribute('presetClass'));
	for (const ctn of effects) {
		const spid = num(deep(ctn, 'spTgt')[0], 'spid', -1);
		const target = ctx.nodes.get(spid);
		if (!target) {
			ctx.notes.push(`An effect targets shape ${spid}, which was not imported; it was skipped.`);
			continue;
		}
		if (deep(ctn, 'txEl').length) ctx.notes.push(`An effect on "${target}" animates part of its text, which was not imported; it animates the whole shape.`);
		const cmd = command(ctx, ctn, { width, height }, nodes, target, hidden);
		if (!cmd) continue;
		const kind = ctn.getAttribute('nodeType');
		const delay = num(kid(kid(ctn, 'stCondLst'), 'cond'), 'delay', 0);
		if (kind === 'clickEffect' || !shots.length) shots.push({ id: `click-${shots.length + 1}`, run: [] });
		const run = shots[shots.length - 1].run;
		const placed = { ...cmd, ...(delay > 0 ? { delay } : {}), ...(kind === 'withEffect' && run.length ? { with: 'previous' as const } : {}) } as MotionCommand;
		run.push(placed);
	}
	if (effects.length && !shots.length) ctx.notes.push('The slide\'s effects could not be read.');
	const artwork: VectorDocument = { width, height, background: bg, nodes: [...nodes, ...hidden] };
	const scene: MotionScene = { version: 1, name: `slide-${n}`, artwork, shots, ...(shots.length > 1 ? { trigger: 'click' as const } : {}) };
	const problems = motionSceneShapeProblems(scene);
	if (problems.length) throw new Error(`The imported scene is not well formed:\n${problems.join('\n')}`);
	return { scene, notes: [...new Set(ctx.notes)], issues: checkMotionScene(scene), slides: slidePaths.length };
}

