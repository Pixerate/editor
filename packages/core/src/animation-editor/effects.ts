/**
 * Provider effects in the animation editor (see `@pixerate/editor/effects`).
 *
 * - A **motion** effect (Flair's motion primitives: `entrance.pop`, `emphasis.wiggle`…) is
 *   applied to nodes of the artwork: the provider animates the artwork's SVG
 *   (`applyVectorEffect` with `nodeIds`), and its changes become ordinary scene commands, so the
 *   preview, onion skins and the Flair export and import work on them as on any command.
 * - A **vector** effect brings its own picture (a lower third, a loader): its SVG is added to the
 *   artwork as a group, and its changes become shots that animate that group.
 *
 * Every command made this way carries `source` (`instance`, `effect`, `values`), so the applied
 * effect can be listed, changed (made again with new values, in place) or removed as a whole.
 */

import type { EffectValue, EffectVectorMotion } from '../effects/types.js';
import { vectorDocumentToSvg } from '../vector/svg.js';
import type { VectorDocument, VectorGroupNode, VectorNode } from '../vector/types.js';
import { fromFlairSvgMotion } from './flair-import.js';
import type { MotionCommand, MotionEffectSource, MotionScene, MotionShot } from './types.js';

/** One provider effect applied in a scene. */
export interface AppliedMotionEffect {
	instance: string;
	effect: string;
	provider?: string;
	name?: string;
	values: Record<string, EffectValue>;
	/** `motion`: animates artwork nodes; `vector`: its own picture, the artwork group `group`. */
	kind: 'motion' | 'vector';
	/** The nodes it animates (for `vector`, the group). */
	targets: string[];
	/** The shots holding its commands. */
	shots: string[];
	group?: string;
}

const sourceOf = (c: MotionCommand): MotionEffectSource | undefined => (c as { source?: MotionEffectSource }).source;

/** Every provider effect in a scene, in the order they first appear. */
export function motionSceneEffects(scene: MotionScene): AppliedMotionEffect[] {
	const out = new Map<string, AppliedMotionEffect>();
	const groups = new Set(scene.artwork.nodes.filter((n) => n.type === 'group').map((n) => n.id));
	for (const shot of scene.shots) {
		for (const c of shot.run) {
			const s = sourceOf(c);
			if (!s) continue;
			let e = out.get(s.instance);
			if (!e) {
				const vector = groups.has(s.instance);
				e = { instance: s.instance, effect: s.effect, ...(s.provider ? { provider: s.provider } : {}), ...(s.name ? { name: s.name } : {}), values: { ...(s.values ?? {}) }, kind: vector ? 'vector' : 'motion', targets: vector ? [s.instance] : [], shots: [], ...(vector ? { group: s.instance } : {}) };
				out.set(s.instance, e);
			}
			if (!e.shots.includes(shot.id)) e.shots.push(shot.id);
			if (e.kind === 'motion' && 'targets' in c) for (const t of c.targets) if (!e.targets.includes(t)) e.targets.push(t);
		}
	}
	return [...out.values()];
}

/** A fresh instance id (`fx1`, `fx2`…) not used by an effect, shot or node. */
export function nextMotionEffectInstance(scene: MotionScene): string {
	const used = new Set<string>([...motionSceneEffects(scene).map((e) => e.instance), ...scene.shots.map((s) => s.id)]);
	const walk = (nodes: readonly VectorNode[]) => nodes.forEach((n) => (used.add(n.id), n.type === 'group' && walk(n.children)));
	walk(scene.artwork.nodes);
	for (let i = 1; ; i++) if (!used.has(`fx${i}`)) return `fx${i}`;
}

/** The artwork as the SVG a provider animates (node ids become element ids). */
export const motionArtworkSvg = (artwork: VectorDocument): string => vectorDocumentToSvg(artwork);

const tag = (commands: MotionCommand[], source: MotionEffectSource): MotionCommand[] => commands.map((c) => (c.type === 'wait' ? c : ({ ...c, source } as MotionCommand)));

/** A provider's motion for the artwork as commands (one run, timed as the provider timed it). */
export function motionCommandsFromEffect(artwork: VectorDocument, motion: Pick<EffectVectorMotion, 'svg' | 'animate'>, source: MotionEffectSource): { commands: MotionCommand[]; notes: string[] } {
	const imported = fromFlairSvgMotion({ svg: motionArtworkSvg(artwork), animate: [...(motion.animate ?? [])] });
	const commands: MotionCommand[] = [];
	imported.scene.shots.forEach((shot, i) => {
		shot.run.forEach((c, j) => commands.push(i > 0 && j === 0 ? ({ ...c, with: 'after' } as MotionCommand) : c));
	});
	return { commands: tag(commands, source), notes: imported.notes };
}

/** Renames node ids (and the ids commands name) with `prefix`. */
function prefixed(nodes: readonly VectorNode[], shots: readonly MotionShot[], prefix: string): { nodes: VectorNode[]; shots: MotionShot[] } {
	const map = new Map<string, string>();
	const rename = (list: readonly VectorNode[]): VectorNode[] =>
		list.map((n) => {
			map.set(n.id, prefix + n.id);
			const next = { ...n, id: prefix + n.id } as VectorNode;
			if (next.type === 'group') (next as VectorGroupNode).children = rename((n as VectorGroupNode).children);
			return next;
		});
	const out = rename(nodes);
	const id = (v: unknown) => (typeof v === 'string' && map.has(v) ? map.get(v)! : v);
	const remapped = shots.map((s) => ({
		...s,
		run: s.run.map((c) => {
			const next: Record<string, unknown> = { ...c };
			if (Array.isArray(next.targets)) next.targets = (next.targets as string[]).map((t) => id(t));
			for (const k of ['path', 'into']) if (k in next) next[k] = id(next[k]);
			return next as unknown as MotionCommand;
		})
	}));
	return { nodes: out, shots: remapped };
}

/**
 * A vector effect's own picture and motion: a group (id `source.instance`) holding its SVG,
 * scaled into `box` of the artwork (default the whole artwork), and the shots that animate it.
 */
export function motionPartsFromVectorEffect(
	artwork: VectorDocument,
	motion: Pick<EffectVectorMotion, 'svg' | 'animate'>,
	source: MotionEffectSource,
	box: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: artwork.width, height: artwork.height }
): { group: VectorGroupNode; shots: MotionShot[]; notes: string[] } {
	const imported = fromFlairSvgMotion({ svg: motion.svg, animate: [...(motion.animate ?? [])] }, { hold: 0 });
	const art = imported.scene.artwork;
	const prefix = `${source.instance}-`;
	const { nodes, shots } = prefixed(art.nodes, imported.scene.shots, prefix);
	const k = Math.min(box.width / art.width, box.height / art.height);
	const dx = box.x + (box.width - art.width * k) / 2;
	const dy = box.y + (box.height - art.height * k) / 2;
	const group = { type: 'group', id: source.instance, name: source.name ?? source.effect, children: nodes, transform: [k, 0, 0, k, dx, dy] } as unknown as VectorGroupNode;
	const tagged = shots.map((s, i) => ({ ...s, id: i === 0 ? source.instance + '-shot' : `${source.instance}-shot-${i + 1}`, run: tag(s.run, source) }));
	return { group, shots: tagged.map((s) => (s.hold === 0 ? (({ hold: _h, ...rest }) => rest)(s) : s)), notes: imported.notes };
}

/**
 * The scene without one applied effect: its commands are removed (and shots left empty by that,
 * and a vector effect's artwork group). Returns where its commands were, to put new ones back.
 */
export function withoutMotionEffect(scene: MotionScene, instance: string): { scene: MotionScene; place: { shot: string; index: number } | null; removedShots: string[] } {
	let place: { shot: string; index: number } | null = null;
	const removedShots: string[] = [];
	const shots: MotionShot[] = [];
	for (const shot of scene.shots) {
		const run = shot.run.filter((c, i) => {
			const mine = sourceOf(c)?.instance === instance;
			if (mine && !place) place = { shot: shot.id, index: i };
			return !mine;
		});
		if (run.length === shot.run.length) shots.push(shot);
		else if (run.length === 0) removedShots.push(shot.id);
		else shots.push({ ...shot, run });
	}
	const artwork = { ...scene.artwork, nodes: scene.artwork.nodes.filter((n) => n.id !== instance) };
	return { scene: { ...scene, shots, artwork }, place, removedShots };
}
