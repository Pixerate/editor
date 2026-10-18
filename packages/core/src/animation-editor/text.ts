// Unit selection after effectcraft-main/crates/text/src/selectors.rs (characters, words or lines; forward, backward, from the centre, from the edges or random order), MIT OR Apache-2.0, © ArtCraft Team and contributors.
import { motionSeedFromId } from '../animation/behavior.js';
import { collectPathNodes } from '../vector/geometry.js';
import type { MotionNodeEntry } from './compile.js';
import type { MotionCascade, MotionTextUnit } from './types.js';

/** Outlined text (a group of letter paths) read as lines of words of letters, in reading order. */
export interface MotionTextLayout {
	lines: { words: { letters: string[] }[] }[];
}

/**
 * Reads a group of letter paths (text converted to outlines) as text: letters sorted into lines
 * by their vertical overlap, left to right in each line, and into words where the gap between
 * two letters is wider than about a third of the line's letter height. Null when `id` is not a
 * group with paths.
 */
export function motionTextLayout(nodes: ReadonlyMap<string, MotionNodeEntry>, id: string): MotionTextLayout | null {
	const group = nodes.get(id)?.node;
	if (!group || group.type !== 'group') return null;
	const letters = collectPathNodes(group)
		.map((p) => ({ id: p.id, b: nodes.get(p.id)?.bounds }))
		.filter((l): l is { id: string; b: NonNullable<MotionNodeEntry['bounds']> } => !!l.b && l.b.width + l.b.height > 0);
	if (!letters.length) return null;
	// Lines: letters whose vertical centre falls inside a line's band join it.
	const lines: { top: number; bottom: number; letters: typeof letters }[] = [];
	for (const l of [...letters].sort((a, c) => a.b.y + a.b.height / 2 - (c.b.y + c.b.height / 2))) {
		const cy = l.b.y + l.b.height / 2;
		const line = lines.find((x) => cy >= x.top && cy <= x.bottom);
		if (line) {
			line.letters.push(l);
			line.top = Math.min(line.top, l.b.y);
			line.bottom = Math.max(line.bottom, l.b.y + l.b.height);
		} else lines.push({ top: l.b.y, bottom: l.b.y + l.b.height, letters: [l] });
	}
	lines.sort((a, c) => a.top - c.top);
	return {
		lines: lines.map((line) => {
			const row = [...line.letters].sort((a, c) => a.b.x - c.b.x);
			const heights = row.map((l) => l.b.height).sort((a, c) => a - c);
			const gap = heights[Math.floor(heights.length / 2)] * 0.35;
			const words: { letters: string[] }[] = [];
			row.forEach((l, i) => {
				const prev = row[i - 1];
				if (!prev || l.b.x - (prev.b.x + prev.b.width) > gap) words.push({ letters: [] });
				words[words.length - 1].letters.push(l.id);
			});
			return { words };
		})
	};
}

/** A layout's units (each a list of letter ids), by letter, word or line. */
export function motionTextUnits(layout: MotionTextLayout, by: MotionTextUnit): string[][] {
	if (by === 'line') return layout.lines.map((l) => l.words.flatMap((w) => w.letters));
	if (by === 'word') return layout.lines.flatMap((l) => l.words.map((w) => w.letters));
	return layout.lines.flatMap((l) => l.words.flatMap((w) => w.letters.map((id) => [id])));
}

/** Units in cascade order: forward, backward, from the centre out, from the edges in, or a seeded shuffle. */
export function motionCascade<T>(units: readonly T[], cascade: MotionCascade = 'forward', seed = 1): T[] {
	const n = units.length;
	const mid = (n - 1) / 2;
	const indexed = units.map((u, i) => ({ u, i }));
	if (cascade === 'backward') return [...units].reverse();
	if (cascade === 'center') return indexed.sort((a, b) => Math.abs(a.i - mid) - Math.abs(b.i - mid) || a.i - b.i).map((x) => x.u);
	if (cascade === 'edges') return indexed.sort((a, b) => Math.abs(b.i - mid) - Math.abs(a.i - mid) || a.i - b.i).map((x) => x.u);
	if (cascade === 'random') {
		// Mulberry32: the same seed always gives the same order.
		let s = seed >>> 0 || 1;
		const rand = () => {
			s = (s + 0x6d2b79f5) >>> 0;
			let t = s;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const out = [...units];
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}
	return [...units];
}

/** Default stagger (ms) between units. */
export const MOTION_TEXT_STAGGER: Readonly<Record<MotionTextUnit, number>> = { letter: 40, word: 120, line: 300 };

/**
 * What a command animates, each with its stagger slot: its targets in order, or (with `split`) the
 * letters of each target's text, a slot per letter, word or line in cascade order.
 */
export function motionCommandSlots(nodes: ReadonlyMap<string, MotionNodeEntry>, command: { targets: readonly string[]; split?: MotionTextUnit; cascade?: MotionCascade; stagger?: number }): { slots: { id: string; slot: number }[]; stagger: number } {
	if (!command.split) return { slots: command.targets.map((id, k) => ({ id, slot: k })), stagger: command.stagger ?? 0 };
	const slots: { id: string; slot: number }[] = [];
	let slot = 0;
	for (const target of command.targets) {
		const layout = motionTextLayout(nodes, target);
		if (!layout) {
			slots.push({ id: target, slot: slot++ });
			continue;
		}
		for (const unit of motionCascade(motionTextUnits(layout, command.split), command.cascade, motionSeedFromId(target))) {
			for (const id of unit) slots.push({ id, slot });
			slot++;
		}
	}
	return { slots, stagger: command.stagger ?? MOTION_TEXT_STAGGER[command.split] };
}
