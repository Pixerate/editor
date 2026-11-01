import { resolveEasing, springSettleMs } from '../animation/easing.js';
import { matchMotionNodes } from './match.js';
import { motionTextLayout } from './text.js';
import { normalizeTokenColor } from '../tokens/color.js';
import { collectPathNodes } from '../vector/geometry.js';
import type { VectorNode } from '../vector/types.js';
import { compileMotionScene, indexMotionNodes, motionRevealPadding, motionTrackKey, trackValue, type MotionTimeline } from './compile.js';
import { motionFrameAt } from './evaluate.js';
import { motionIssue, namedWithSuggestion, type MotionIssue } from './issues.js';
import { MOTION_CLIP_TARGET, motionCameraFramed, type MotionCommand, type MotionScene } from './types.js';

/** Changes shorter than this (ms) are too quick to follow. */
export const MOTION_MIN_CHANGE_MS = 120;

const NUMERIC_PARAMS = (node: VectorNode, effectId: string): string[] | null => {
	const effect = node.effects?.find((e) => e.id === effectId);
	if (!effect) return null;
	return Object.entries(effect.params as unknown as Record<string, unknown>)
		.filter(([, v]) => typeof v === 'number')
		.map(([k]) => k);
};

function usesColor(scene: MotionScene, color: string): boolean {
	const target = color.toLowerCase();
	let found = false;
	const walk = (v: unknown) => {
		if (found) return;
		if (typeof v === 'string') found = v.toLowerCase() === target;
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') Object.values(v).forEach(walk);
	};
	walk(scene.artwork);
	walk(scene.shots);
	return found;
}

function visibleAt(timeline: MotionTimeline, id: string, time: number, node: VectorNode): boolean {
	const num = (p: Parameters<typeof motionTrackKey>[1], rest: number) => {
		const v = trackValue(timeline.tracks.get(motionTrackKey(id, p)), time);
		return typeof v === 'number' ? v : rest;
	};
	if (node.visible === false) return false;
	if (num('opacity', node.opacity ?? 1) <= 0.01) return false;
	if (Math.abs(num('scaleX', 1) * num('scaleY', 1)) <= 1e-4) return false;
	// A reveal clip with no area (before a wipe in, after a wipe out).
	const clip = (p: 'clipRect' | 'clipCircle') => trackValue(timeline.tracks.get(motionTrackKey(id, p)), time);
	const rect = clip('clipRect');
	if (Array.isArray(rect) && (rect[2] <= 1e-4 || rect[3] <= 1e-4)) return false;
	const circle = clip('clipCircle');
	if (Array.isArray(circle) && circle[2] <= 1e-4) return false;
	const hasFill = node.type === 'path' ? !!node.fill && node.fill !== 'none' : collectPathNodes(node).some((p) => p.fill && p.fill !== 'none');
	// A group's strokes may each draw on in turn (draw order): drawn when any of them is.
	const drawn =
		num('drawEnd', 1) > 0.01 &&
		(node.type === 'path' ||
			collectPathNodes(node).length === 0 ||
			collectPathNodes(node).some((p) => {
				const v = trackValue(timeline.tracks.get(motionTrackKey(p.id, 'drawEnd')), time);
				return typeof v !== 'number' || v > 0.01;
			}));
	return drawn || (hasFill && num('fillOpacity', 1) > 0.01);
}

/**
 * What is wrong with a scene's meaning: unknown ids (with a "did you mean"), timing that
 * fights itself, things animated while hidden or off camera, and lengths outside the target.
 * The scene must be well formed (see `parseMotionScene`).
 */
export function checkMotionScene(scene: MotionScene): MotionIssue[] {
	const issues: MotionIssue[] = [];
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const ids = [...nodes.keys()];
	const timeline = compileMotionScene(scene);
	const artAspect = scene.artwork.width / scene.artwork.height;

	if (!scene.shots.length) issues.push(motionIssue('no-shots', 'The scene has no shots yet; add one with a list of commands.'));
	const seen = new Set<string>();
	for (const shot of scene.shots) {
		if (seen.has(shot.id)) issues.push(motionIssue('duplicate-shot-id', `Shot id "${shot.id}" is used twice; give each shot its own id.`, { shot: shot.id }));
		seen.add(shot.id);
	}

	const known = (id: string, code: 'unknown-target' | 'unknown-path' | 'unknown-shape' | 'unknown-frame', what: string, where: { shot: string; command?: number }) => {
		if (nodes.has(id)) return true;
		issues.push(motionIssue(code, `There is no ${what} ${namedWithSuggestion(id, ids)} in the artwork${ids.length ? '' : ' (it has no nodes yet)'}.`, { ...where, ids: [id] }));
		return false;
	};

	scene.shots.forEach((shot, shotIndex) => {
		if (shot.camera && 'frame' in shot.camera && typeof shot.camera.frame === 'string') known(shot.camera.frame, 'unknown-frame', 'node to frame', { shot: shot.id });
		else if (shot.camera && motionCameraFramed(shot.camera)) {
			const c = shot.camera as { width: number; height: number };
			if (!(c.width > 0 && c.height > 0)) issues.push(motionIssue('invalid-camera', `The camera needs a positive width and height (got ${c.width} × ${c.height}).`, { shot: shot.id }));
			else if (Math.abs(c.width / c.height / artAspect - 1) > 0.02)
				issues.push(motionIssue('camera-aspect', `The camera is ${c.width} × ${c.height}, a different shape from the ${scene.artwork.width} × ${scene.artwork.height} artwork, so it shows bands at the sides; frame a node instead to match.`, { shot: shot.id }));
		}
		if (shotIndex === 0 && shot.camera?.in !== undefined) issues.push(motionIssue('camera-move-first-shot', 'The first shot cuts to its framing (there is none before it to move from), so its camera "in" does not play; put the move on the next shot, or use a "during" move here.', { shot: shot.id }));
		if (!shot.run.length && !shot.camera && shotIndex > 0) issues.push(motionIssue('empty-shot', 'This shot only holds; add commands or a camera move, or remove it.', { shot: shot.id }));

		shot.run.forEach((command: MotionCommand, i) => {
			const where = { shot: shot.id, command: i };
			if (command.type === 'wait') return;
			const targets = command.targets.filter((id) => known(id, 'unknown-target', 'node', where));
			const timing = timeline.commands.find((c) => c.shot === shot.id && c.command === i);
			if (timing && timing.duration > 0 && timing.duration < MOTION_MIN_CHANGE_MS)
				issues.push(motionIssue('too-fast', `This ${command.type} lasts ${timing.duration} ms, too quick to follow; make it at least ${MOTION_MIN_CHANGE_MS} ms.`, { ...where, measured: timing.duration, needed: MOTION_MIN_CHANGE_MS, unit: 'ms', ids: targets }));
			if (command.duration !== undefined && command.ease !== undefined) {
				const ease = resolveEasing(command.ease);
				if (ease !== 'hold' && ease.type === 'spring') {
					const settle = springSettleMs(ease);
					if (command.duration < settle * 0.9)
						issues.push(motionIssue('spring-cut-short', `This ${command.type}'s spring takes ${settle} ms to settle but lasts ${command.duration} ms, so it jumps to its end; leave "duration" out (the spring sets it) or make it at least ${settle} ms.`, { ...where, measured: command.duration, needed: settle, unit: 'ms', ids: targets }));
				}
			}
			if (command.type === 'follow' && known(command.path, 'unknown-path', 'path', where) && nodes.get(command.path)!.node.type !== 'path')
				issues.push(motionIssue('not-a-path', `"${command.path}" is a group; follow a single path node.`, { ...where, ids: [command.path] }));
			if (command.type === 'morph') known(command.into, 'unknown-shape', 'shape', where);
			if (command.type !== 'play' && command.split)
				for (const id of targets)
					if (!motionTextLayout(nodes, id))
						issues.push(motionIssue('split-not-text', `"${id}" is not a group of letter paths, so "split": "${command.split}" animates it as a whole; convert the text to outlines and group the letters (get_text_layout shows how they read).`, { ...where, ids: [id] }));
			if (command.type === 'play' && !scene.clips?.[command.clip])
				issues.push(motionIssue('unknown-clip', `There is no clip ${namedWithSuggestion(command.clip, Object.keys(scene.clips ?? {}))}; define it with set_animation_clip.`, where));
			if (command.type === 'match' && known(command.into, 'unknown-shape', 'group', where)) {
				const into = nodes.get(command.into)!;
				for (const id of targets) {
					const entry = nodes.get(id)!;
					if (id === command.into || into.ancestors.includes(id) || entry.ancestors.includes(command.into)) {
						issues.push(motionIssue('match-self', `"${id}" cannot match "${command.into}": one is the other or holds it. Match two separate groups (the second usually hidden).`, { ...where, ids: [id, command.into] }));
						continue;
					}
					const m = matchMotionNodes(entry.node, into.node);
					if (m.unpairedInto.length)
						issues.push(motionIssue('match-unpaired', `${m.unpairedInto.map((x) => `"${x}"`).join(', ')} in "${command.into}" ${m.unpairedInto.length > 1 ? 'have' : 'has'} no partner in "${id}", so ${m.unpairedInto.length > 1 ? 'they do' : 'it does'} not appear; add a part with the same name or id to "${id}" (it can start hidden or tiny).`, { ...where, ids: m.unpairedInto }));
				}
			}
			const style = command.type === 'enter' || command.type === 'exit' ? command.style : undefined;
			if (style === 'wipe' || style === 'iris' || style === 'split')
				for (const id of targets)
					if (!motionRevealPadding(nodes.get(id)!))
						issues.push(motionIssue('reveal-no-box', `"${id}" has no width or height (a straight line), so a ${style} cannot clip it and it fades instead; use style "${command.type === 'enter' ? 'draw' : 'undraw'}" for a line.`, { ...where, ids: [id] }));
			if (command.type === 'style') {
				for (const key of ['fill', 'stroke'] as const) {
					const color = command[key];
					if (color === undefined) continue;
					if (normalizeTokenColor(color) === null) {
						issues.push(motionIssue('invalid-color', `${key} "${color}" is not a colour this editor reads; use hex ("#0ea5e9"), rgb() or rgba().`, where));
						continue;
					}
					for (const id of targets) {
						const node = nodes.get(id)!.node;
						const paths = node.type === 'path' ? [node] : collectPathNodes(node);
						if (paths.some((p) => p[key] !== undefined && p[key] !== null && typeof p[key] !== 'string'))
							issues.push(motionIssue('paint-not-color', `"${id}" has a gradient ${key}; it switches to ${color} at the end instead of blending.`, { ...where, ids: [id] }));
					}
				}
			}
			if (command.type === 'color-pulse') {
				const key = command.paint ?? 'fill';
				const color = command.color ?? '#f59e0b';
				if (normalizeTokenColor(color) === null) issues.push(motionIssue('invalid-color', `color "${color}" is not a colour this editor reads; use hex ("#0ea5e9"), rgb() or rgba().`, where));
				else
					for (const id of targets) {
						const node = nodes.get(id)!.node;
						const paths = node.type === 'path' ? [node] : collectPathNodes(node);
						if (paths.some((p) => typeof p[key] !== 'string'))
							issues.push(motionIssue('paint-not-color', `"${id}" has a gradient or no ${key}, so a colour pulse cannot tint it; give it a solid ${key} or pulse the ${key === 'fill' ? 'stroke' : 'fill'}.`, { ...where, ids: [id] }));
					}
			}
			if (command.type === 'effect') {
				for (const id of targets) {
					const node = nodes.get(id)!.node;
					const params = NUMERIC_PARAMS(node, command.effect);
					const effects = (node.effects ?? []).map((e) => e.id);
					if (!params)
						issues.push(motionIssue('unknown-effect', `"${id}" has no effect ${namedWithSuggestion(command.effect, effects)}${effects.length ? `; its effects are ${effects.map((e) => `"${e}"`).join(', ')}` : '; it has no live effects'}.`, { ...where, ids: [id] }));
					else if (!params.includes(command.param))
						issues.push(motionIssue('unknown-effect-param', `Effect "${command.effect}" has no numeric parameter ${namedWithSuggestion(command.param, params)}; use one of ${params.join(', ')}.`, { ...where, ids: [id] }));
				}
			}
			// Visibility at the start of the command.
			if (timing) {
				for (const id of targets) {
					const node = nodes.get(id)!.node;
					const before = Math.max(0, timing.start - 0.5);
					const visible = timing.start > 0 ? visibleAt(timeline, id, before, node) : node.visible !== false;
					if (command.type === 'enter' && visible && timing.start > 0)
						issues.push(motionIssue('enter-visible', `"${id}" is already showing when it enters, so it blinks out first; remove the enter or exit it earlier.`, { ...where, ids: [id] }));
					const probe = command.type === 'exit' ? timing.start + 0.5 : (timing.start + timing.end) / 2;
					if (command.type !== 'enter' && command.type !== 'draw' && !visibleAt(timeline, id, probe, node))
						issues.push(motionIssue('exit-hidden', `"${id}" is hidden when this ${command.type} starts, so it is not seen; enter it first.`, { ...where, ids: [id] }));
				}
			}
		});
	});

	// Drivers: their nodes must exist, and they must not follow each other round in a loop.
	const drivers = scene.drivers ?? [];
	drivers.forEach((d, i) => {
		for (const id of [d.target, d.source.node])
			if (!nodes.has(id)) issues.push(motionIssue('unknown-target', `Driver ${i + 1} names ${namedWithSuggestion(id, [...nodes.keys()])}, which the artwork does not have.`, { ids: [id] }));
	});
	{
		const key = (n: string, p: string) => `${n}.${p}`;
		const edges = new Map<string, string[]>();
		for (const d of drivers) edges.set(key(d.target, d.property), [...(edges.get(key(d.target, d.property)) ?? []), key(d.source.node, d.source.property)]);
		const state = new Map<string, 1 | 2>();
		const loop: string[] = [];
		const visit = (k: string, trail: string[]): boolean => {
			if (state.get(k) === 2) return false;
			if (state.get(k) === 1) return loop.push(...trail.slice(trail.indexOf(k)), k), true;
			state.set(k, 1);
			for (const n of edges.get(k) ?? []) if (visit(n, [...trail, k])) return true;
			state.set(k, 2);
			return false;
		};
		for (const k of edges.keys()) if (visit(k, [])) break;
		if (loop.length) issues.push(motionIssue('driver-cycle', `Drivers follow each other round in a loop (${loop.join(' ← ')}); remove one of them.`, { ids: [...new Set(loop.map((k) => k.split('.')[0]))] }));
	}

	// Clips: the nodes they name besides "$" must exist.
	for (const [name, clip] of Object.entries(scene.clips ?? {}))
		for (const command of clip.run)
			if (command.type !== 'wait')
				for (const id of command.targets)
					if (id !== MOTION_CLIP_TARGET && !nodes.has(id)) issues.push(motionIssue('unknown-target', `Clip "${name}" names ${namedWithSuggestion(id, [...nodes.keys()])}, which the artwork does not have; use "$" for the node the clip is played on.`, { ids: [id] }));

	// Triggers: what Flair's player does with a scene played in answer to the viewer.
	if (scene.trigger) {
		if ((scene.loop ?? 'none') !== 'none') issues.push(motionIssue('trigger-loop', `The scene plays on ${scene.trigger}, so its "${scene.loop}" loop does not apply; set loop to "none" or remove the trigger.`, {}));
		if (scene.trigger === 'click') {
			if (scene.shots.length === 1) issues.push(motionIssue('click-one-shot', 'The scene plays on click but has one shot, so every click replays it from the start; split it into shots (each click plays the next one).', { shot: scene.shots[0].id }));
			scene.shots.forEach((shot, i) => {
				if (i > 0 && shot.at) issues.push(motionIssue('click-cue', `Shot "${shot.id}" is cued, but on click a shot starts when it is clicked to; remove its "at" or the trigger.`, { shot: shot.id }));
			});
		}
	}

	// Cues: they must resolve, and the shot before must have ended by then.
	scene.shots.forEach((shot, i) => {
		if (!shot.at) return;
		const timing = timeline.shots[i];
		if (timing.cue === undefined) {
			const what = shot.at.beat !== undefined ? `beat ${shot.at.beat}, but the scene has no beat grid; set one with set_animation_settings ({ "beat": { "bpm": … } })` : `word ${shot.at.word}, but the narration has ${scene.narration?.words.length ?? 0} words (indexes from 0)`;
			issues.push(motionIssue('unknown-cue', `Shot "${shot.id}" is cued to ${what}.`, { shot: shot.id }));
		} else if (timing.missedBy !== undefined) {
			const late = Math.round(timing.missedBy);
			issues.push(motionIssue('cue-missed', `Shot "${shot.id}" is cued at ${Math.round(timing.cue)} ms but starts ${late} ms late, because the shot before runs until ${Math.round(timing.start)} ms; shorten that shot (its hold, durations or speed) or cue this one later.`, { shot: shot.id, measured: late, needed: 0, unit: 'ms' }));
		}
	});

	// Two segments changing the same property of a node at the same time.
	for (const [key, track] of timeline.tracks) {
		// Additive layers stack by design.
		if (key.endsWith('\u0000add')) continue;
		for (let i = 1; i < track.length; i++) {
			const a = track[i - 1];
			const b = track[i];
			if (b.start < a.end - 1 && (a.shot !== b.shot || a.command !== b.command)) {
				const property = key.split('\u0000')[1];
				if (!a.node) continue;
				issues.push(
					motionIssue('overlap', `"${a.node}" ${property} is changed by two commands at once (shot "${a.shot}" command ${a.command + 1} and shot "${b.shot}" command ${b.command + 1}); the later one takes over. Start it after the first ends, or use with: "after".`, {
						shot: b.shot,
						command: b.command,
						ids: [a.node]
					})
				);
			}
		}
	}

	// Animated nodes that end their command outside the camera.
	const reported = new Set<string>();
	for (const timing of timeline.commands) {
		const command = scene.shots[timing.shotIndex].run[timing.command];
		if (command.type === 'wait' || command.type === 'exit') continue;
		const frame = motionFrameAt(scene, timing.end);
		const cam = frame.camera;
		const docIndex = indexMotionNodes(frame.document.nodes);
		for (const id of command.targets) {
			const b = docIndex.get(id)?.bounds;
			if (!b || reported.has(id) || !visibleAt(timeline, id, timing.end, nodes.get(id)!.node)) continue;
			const outside = b.x + b.width < cam.x || b.y + b.height < cam.y || b.x > cam.x + cam.width || b.y > cam.y + cam.height;
			if (outside) {
				reported.add(id);
				issues.push(motionIssue('out-of-frame', `"${id}" is outside the camera when this ${command.type} ends, so it is not seen; move it into frame or move the camera.`, { shot: timing.shot, command: timing.command, ids: [id] }));
			}
		}
	}

	if (scene.controls) {
		for (const control of scene.controls) {
			if (!usesColor(scene, control.default))
				issues.push(motionIssue('unknown-control-color', `Control "${control.name}" stands for ${control.default}, which the scene never uses; set its default to a colour in the artwork.`));
		}
	}

	if (scene.target && scene.shots.length) {
		const seconds = Math.round(timeline.duration / 100) / 10;
		const [min, max] = scene.target;
		if (seconds > max) issues.push(motionIssue('scene-too-long', `The scene runs ${seconds} s, past its ${max} s target; shorten holds or durations, or fit it (fit_animation).`, { measured: seconds, needed: max, unit: 's' }));
		if (seconds < min) issues.push(motionIssue('scene-too-short', `The scene runs ${seconds} s, under its ${min} s target; hold longer, add shots, or fit it (fit_animation).`, { measured: seconds, needed: min, unit: 's' }));
	}
	return issues;
}
