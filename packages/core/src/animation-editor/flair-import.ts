import type { MotionBehavior } from '../animation/behavior.js';
import type { AnimationEasing } from '../animation/easing.js';
import { applyMatrix, invertMatrix, multiplyMatrices, nodeMatrix, type AffineMatrix } from '../vector/geometry.js';
import { parseSvgTransform, parseVectorSvg } from '../vector/svg.js';
import { checkMotionScene } from './check.js';
import { indexMotionNodes, MOTION_EASE_IN_OUT, MOTION_EASE_OUT, type MotionNodeEntry } from './compile.js';
import type { FlairEase, FlairSvgAnimation, FlairSvgMotion, FlairVectorEffect } from './flair.js';
import type { MotionIssue } from './issues.js';
import { motionSceneShapeProblems } from './parse.js';
import type { MotionCamera, MotionCommand, MotionControl, MotionScene, MotionShot } from './types.js';

/**
 * Import from Flair: a Flair `SvgMotion` (or a catalog `VectorEffect`) becomes a scene, so an
 * effect made in Flair, or taken from its catalog, can be opened and edited here. The reverse
 * of `toFlairSvgMotion`, as far as the scene model goes:
 *
 * - The SVG becomes the artwork (`parseVectorSvg`); `{{name: color …}}` placeholders become
 *   colour controls (other placeholders take their defaults).
 * - Each Flair step becomes a shot, its changes commands timed by their `delay`, all together.
 * - Opacity, paint, stroke width, transforms (as move, rotate and scale), drawing on, following
 *   a path, camera views and behaviours (pulse, shake, teeter, wave, wiggle, colour pulse) carry
 *   over. Counting, writing text, solo containers and anything else are listed in `notes`.
 */

export interface FlairImportResult {
	scene: MotionScene;
	/** What could not be carried over exactly, in sentences. */
	notes: string[];
	/** `checkMotionScene` of the result. */
	issues: MotionIssue[];
}

export interface FlairImportOptions {
	/** The scene's name (default: the effect's, else `from-flair`). */
	name?: string;
	/** Hold after the last shot, ms (default: the effect's `hold`, else 600). */
	hold?: number;
}

/** A `{{name}}` placeholder or `{{name: type attributes}}` declaration, as Flair writes them. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*(?::\s*([A-Za-z0-9]*)([^}]*))?\}\}/g;

function attributeOf(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name}=(?:'([^']*)'|(\\S+))`).exec(attrs);
	return m ? (m[1] ?? m[2]) : undefined;
}

/** Placeholders replaced by their defaults; colour declarations become controls. */
function resolvePlaceholders(motion: FlairSvgMotion, notes: string[]): { motion: FlairSvgMotion; controls: MotionControl[] } {
	const text = JSON.stringify(motion);
	const declared = new Map<string, { type: string; value: string; label?: string }>();
	for (const m of text.matchAll(PLACEHOLDER)) {
		if (!m[2] || declared.has(m[1])) continue;
		const attrs = m[3] ?? '';
		const value = attributeOf(attrs, 'default');
		const fallback = m[2] === 'color' ? '#000000' : '0';
		declared.set(m[1], { type: m[2], value: m[2] === 'color' ? (value ?? fallback).toLowerCase() : (value ?? fallback), ...(attributeOf(attrs, 'label') ? { label: attributeOf(attrs, 'label') } : {}) });
	}
	const controls: MotionControl[] = [];
	for (const [name, d] of declared) {
		if (d.type === 'color' && /^#[0-9a-fA-F]{6}$/.test(d.value)) controls.push({ name, type: 'color', default: d.value.toLowerCase(), ...(d.label ? { label: d.label } : {}) });
		else notes.push(`Control "${name}" (${d.type}) is fixed at its default ${d.value}: scenes take colour controls only.`);
	}
	const unknown = new Set<string>();
	const filled = text.replace(PLACEHOLDER, (_, name: string) => {
		const d = declared.get(name);
		if (!d) unknown.add(name);
		return (d?.value ?? '').replace(/"/g, '\\"');
	});
	for (const name of unknown) notes.push(`Placeholder "{{${name}}}" has no declaration, so it was left empty.`);
	// SVG comments (where Flair declares controls) are dropped with the markup's comments.
	return { motion: JSON.parse(filled) as FlairSvgMotion, controls };
}

/** A Flair ease as an editor easing. Flair's `in-out` is a cubic polynomial, close to the editor's ease-in-out curve. */
function easingOf(ease: FlairEase | undefined, fallback: AnimationEasing): AnimationEasing {
	if (ease === undefined) return fallback;
	if (ease === 'linear') return 'linear';
	if (ease === 'out') return MOTION_EASE_OUT;
	if (ease === 'in-out') return MOTION_EASE_IN_OUT;
	if (Array.isArray(ease)) return { type: 'cubic-bezier', x1: ease[0], y1: ease[1], x2: ease[2], y2: ease[3] };
	if (typeof ease === 'object' && 'spring' in ease) return { type: 'spring', ...ease.spring };
	return fallback;
}

interface Pose {
	dx: number;
	dy: number;
	rotation: number;
	sx: number;
	sy: number;
}

/** A Flair transform value as the editor's offset from the node's rest (move, turn and scale about its centre), or null when it skews. */
function poseOf(value: string | number, entry: MotionNodeEntry): Pose | null {
	const t = parseSvgTransform(String(value));
	const o: AffineMatrix = multiplyMatrices(invertMatrix(nodeMatrix(entry.node)) ?? [1, 0, 0, 1, 0, 0], t);
	const sx = Math.hypot(o[0], o[1]);
	if (!(sx > 1e-9)) return null;
	const sy = (o[0] * o[3] - o[1] * o[2]) / sx;
	// No skew: the second column is the first turned a quarter, times sy.
	if (Math.abs(o[2] + (o[1] / sx) * sy) > 1e-6 || Math.abs(o[3] - (o[0] / sx) * sy) > 1e-6) return null;
	const c = entry.center;
	const moved = applyMatrix(o, c);
	return { dx: moved.x - c.x, dy: moved.y - c.y, rotation: (Math.atan2(o[1], o[0]) * 180) / Math.PI, sx, sy };
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** One Flair change as commands (all starting together), or a note on why it is skipped. */
function commandsFor(anim: FlairSvgAnimation, nodes: Map<string, MotionNodeEntry>, entered: Set<string>, notes: string[]): MotionCommand[] {
	const id = anim.id!;
	const entry = nodes.get(id);
	const where = `"${id}"`;
	if (!entry) {
		notes.push(`A change to ${where} was skipped: the artwork has no element with that id.`);
		return [];
	}
	const targets = [id];
	const duration = anim.ms ?? 800;
	const timing = {
		duration,
		...(anim.strobe ? { steps: anim.strobe } : {}),
		...(anim.repeat && anim.repeat > 1 ? { repeat: anim.repeat, ...(anim.alternate ? { repeatMode: 'mirror' as const } : {}) } : {})
	};
	const ease = (fallback: AnimationEasing) => ({ ease: easingOf(anim.ease, fallback) });
	const out: MotionCommand[] = [];
	const behavior: MotionBehavior | undefined = anim.behavior;
	const unsupported = (['count', 'write', 'scramble', 'solo'] as const).filter((k) => (anim as Record<string, unknown>)[k] !== undefined);
	if (unsupported.length) notes.push(`${where}: ${unsupported.join(', ')} ${unsupported.length > 1 ? 'are' : 'is'} not part of scenes and was skipped.`);

	if (anim.draw !== undefined && anim.draw !== false) {
		const [from, to] = anim.draw === true ? [0, 1] : anim.draw;
		out.push({ type: 'draw', targets, from, to, ...timing, ...ease(MOTION_EASE_IN_OUT) });
	}
	if (anim.along) {
		const path = nodes.get(anim.along);
		if (!path || path.node.type !== 'path') notes.push(`${where} follows "${anim.along}", which is not a path in the artwork; the follow was skipped.`);
		else out.push({ type: 'follow', targets, path: anim.along, from: anim.at?.[0] ?? 0, to: anim.at?.[1] ?? 1, ...(anim.orient ? { rotate: true } : {}), ...timing, ...ease(MOTION_EASE_IN_OUT) });
	}
	for (const [attr, [a, b]] of Object.entries(anim.attrs ?? {})) {
		if (attr === 'opacity') {
			const [from, to] = [Number(a), Number(b)];
			if (behavior) notes.push(`${where}: an opacity ${behavior.type} became a plain fade.`);
			if (from === 0 && to > 0 && !entered.has(id)) {
				entered.add(id);
				out.push({ type: 'enter', targets, style: 'fade', ...timing, ...ease(MOTION_EASE_OUT) });
			} else out.push({ type: 'fade', targets, to: Math.min(1, Math.max(0, to)), ...timing, ...ease(MOTION_EASE_IN_OUT) });
		} else if (attr === 'fill' || attr === 'stroke') {
			if (behavior?.type === 'pulse') out.push({ type: 'color-pulse', targets, color: String(b), paint: attr, count: behavior.count ?? 1, ...timing, ...ease('linear') });
			else {
				if (behavior) notes.push(`${where}: a ${attr} ${behavior.type} became a plain colour change.`);
				out.push({ type: 'style', targets, [attr]: String(b), ...timing, ...ease(MOTION_EASE_IN_OUT) } as MotionCommand);
			}
		} else if (attr === 'stroke-width') {
			out.push({ type: 'style', targets, strokeWidth: Number(b), ...timing, ...ease(MOTION_EASE_IN_OUT) });
		} else if (attr === 'transform') {
			const p0 = poseOf(a, entry);
			const p1 = poseOf(b, entry);
			if (!p0 || !p1) {
				notes.push(`${where}: a transform that skews was skipped (scenes move, turn and scale).`);
				continue;
			}
			const d = { x: r3(p1.dx - p0.dx), y: r3(p1.dy - p0.dy), r: r3(p1.rotation - p0.rotation), sx: p1.sx / p0.sx, sy: p1.sy / p0.sy };
			if (behavior) {
				const linear = ease('linear');
				const moves = d.x !== 0 || d.y !== 0;
				const turns = d.r !== 0;
				const scales = !near(d.sx, 1) || !near(d.sy, 1);
				if (behavior.type === 'pulse' && scales && !moves && !turns) out.push({ type: 'pulse', targets, amount: r3(d.sx - 1), count: behavior.count ?? 1, ...timing, ...linear });
				else if (behavior.type === 'oscillate' && (behavior.decay ?? 0) > 0 && turns && !moves && !scales) out.push({ type: 'teeter', targets, angle: d.r, count: behavior.count ?? 1, ...timing, ...linear });
				else if (behavior.type === 'oscillate' && (behavior.decay ?? 0) > 0 && moves && !turns && !scales && (d.x === 0 || d.y === 0))
					out.push({ type: 'shake', targets, amount: d.x || d.y, count: behavior.count ?? 1, ...(d.x === 0 ? { axis: 'vertical' as const } : {}), ...timing, ...linear });
				else if (behavior.type === 'oscillate' && !behavior.decay && d.x === 0 && d.y !== 0 && !turns && !scales) out.push({ type: 'wave', targets, amount: -d.y, count: behavior.count ?? 1, ...timing, ...linear });
				else if (behavior.type === 'wriggle' && !scales)
					out.push({ type: 'wiggle', targets, amount: Math.max(Math.abs(d.x), Math.abs(d.y)), ...(turns ? { rotate: Math.abs(d.r) } : {}), frequency: behavior.frequency ?? 2, octaves: behavior.octaves ?? 2, seed: behavior.seed ?? 42, ...timing, ...linear });
				else notes.push(`${where}: a transform ${behavior.type} that is not a pulse, shake, teeter, wave or wiggle was skipped.`);
				continue;
			}
			const e = ease(MOTION_EASE_IN_OUT);
			if (d.x !== 0 || d.y !== 0) out.push({ type: 'move', targets, by: { x: d.x, y: d.y }, ...timing, ...e });
			if (d.r !== 0) out.push({ type: 'rotate', targets, to: r3(p1.rotation), ...timing, ...e });
			if (!near(d.sx, 1) || !near(d.sy, 1)) out.push({ type: 'scale', targets, to: near(p1.sx, p1.sy) ? r3(p1.sx) : { x: r3(p1.sx), y: r3(p1.sy) }, ...timing, ...e });
		} else notes.push(`${where}: changing "${attr}" is not part of scenes and was skipped.`);
	}
	return out;
}

/** A Flair `SvgMotion` as a scene (see the module notes for what carries over). */
export function fromFlairSvgMotion(input: FlairSvgMotion, options: FlairImportOptions = {}): FlairImportResult {
	const notes: string[] = [];
	if (!input || typeof input.svg !== 'string') throw new Error('Give a Flair SvgMotion: { svg: "<svg …>", animate: [ … ] }.');
	const { motion, controls } = resolvePlaceholders(input, notes);
	const artwork = parseVectorSvg(motion.svg);
	const nodes = indexMotionNodes(artwork.nodes);
	const byStep = new Map<number, FlairSvgAnimation[]>();
	for (const anim of motion.animate ?? []) {
		const step = Math.max(0, Math.floor(anim.step ?? 0));
		if (!byStep.has(step)) byStep.set(step, []);
		byStep.get(step)!.push(anim);
	}
	const steps = [...byStep.keys()].sort((a, b) => a - b);
	if (steps.length > 1) notes.push('Each Flair step became a shot played after the one before (Flair steps wait for clicks or set times).');
	const entered = new Set<string>();
	const shots: MotionShot[] = steps.map((step, index) => {
		const anims = [...byStep.get(step)!].sort((a, b) => (a.delay ?? 0) - (b.delay ?? 0));
		let camera: MotionCamera | undefined;
		let cameraMs = 0;
		const run: MotionCommand[] = [];
		let last = 0;
		for (const anim of anims) {
			if (anim.view !== undefined) {
				if (camera || (anim.delay ?? 0) > 0) {
					notes.push(`Step ${step}: a camera move ${camera ? 'after the first' : `${anim.delay} ms in`} was dropped; a shot frames the camera once, at its start.`);
					continue;
				}
				const ms = anim.ms ?? 800;
				const ease = easingOf(anim.ease, MOTION_EASE_IN_OUT);
				camera = typeof anim.view === 'string' ? { frame: anim.view, padding: 0, ms, ease } : { x: anim.view[0], y: anim.view[1], width: anim.view[2], height: anim.view[3], ms, ease };
				cameraMs = index === 0 ? 0 : ms;
				continue;
			}
			if (!anim.id) continue;
			// A shot's commands start after its camera move: earlier changes are pushed back to it.
			const at = Math.max(0, (anim.delay ?? 0) - cameraMs);
			if (cameraMs && (anim.delay ?? 0) < cameraMs) notes.push(`Step ${step}: a change to "${anim.id}" during the camera move now starts after it.`);
			for (const command of commandsFor(anim, nodes, entered, notes)) {
				const first = run.length === 0;
				run.push({ ...command, ...(first ? {} : { with: 'previous' as const }), ...(at - last > 0 || first ? { delay: first ? at : at - last } : {}) } as MotionCommand);
				if (first && at === 0) delete (run[run.length - 1] as { delay?: number }).delay;
				last = at;
			}
		}
		return { id: `step-${step}`, ...(camera ? { camera } : {}), run, ...(index === steps.length - 1 ? { hold: options.hold ?? 600 } : {}) };
	});
	const scene: MotionScene = { version: 1, name: options.name ?? 'from-flair', artwork, shots, ...(controls.length ? { controls } : {}) };
	const problems = motionSceneShapeProblems(scene);
	if (problems.length) throw new Error(`The imported scene is not well formed:\n${problems.join('\n')}`);
	return { scene, notes: [...new Set(notes)], issues: checkMotionScene(scene) };
}

/** A Flair catalog `VectorEffect` as a scene: its motion, name, description, colour controls and presets. */
export function fromFlairVectorEffect(effect: FlairVectorEffect, options: FlairImportOptions = {}): FlairImportResult {
	if (!effect || effect.kind !== 'vector' || !effect.motion) throw new Error('Give a Flair vector effect: { kind: "vector", id, name, motion: { svg, animate } }.');
	const result = fromFlairSvgMotion(effect.motion, { name: options.name ?? effect.id ?? effect.name, hold: options.hold ?? effect.hold });
	const names = new Set((result.scene.controls ?? []).map((c) => c.name));
	const presets = (effect.presets ?? []).map((p) => ({ name: p.name, values: Object.fromEntries(Object.entries(p.values).filter(([k]) => names.has(k))) })).filter((p) => Object.keys(p.values).length);
	const scene: MotionScene = { ...result.scene, ...(effect.description ? { description: effect.description } : {}), ...(presets.length ? { presets } : {}) };
	const notes = [...result.notes];
	if (effect.trigger) notes.push(`The effect plays on ${effect.trigger}; scenes play through, so the trigger is not kept (pass it back to toFlairVectorEffect).`);
	return { scene, notes, issues: checkMotionScene(scene) };
}
