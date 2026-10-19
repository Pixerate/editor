// Pairing passes adapted from deckcraft-main/crates/anim/src/morph.rs (`morph_pairs`) and figcraft-main/crates/ui-egui/src/present.rs (`match_layers`), MIT OR Apache-2.0, © ArtCraft Team and contributors.
import type { VectorNode } from '../vector/types.js';

/** How the parts of one node pair with the parts of another for a `match` (Smart Animate). */
export interface MotionMatch {
	/** `[from id, into id]`: each part of the target and the part of `into` it becomes. */
	pairs: [string, string][];
	/** Parts of the target with no partner (they fade out). */
	unpairedFrom: string[];
	/** Parts of `into` with no partner (they cannot appear). */
	unpairedInto: string[];
}

const SEPARATOR = /[-_/.:]/;

/** An id with the group's own id (or its last word) taken out, so `card-a-title` and `card-b-title` both read `title`. */
function localId(id: string, groupId: string): string {
	if (groupId && id.includes(groupId)) return id.split(groupId).join('').replace(/^[-_/.:]+|[-_/.:]+$/g, '');
	const parts = id.split(SEPARATOR);
	return parts[parts.length - 1] ?? id;
}

/**
 * Pairs the parts of `from` with the parts of `into`, each part used once, in passes: the same
 * `name`, then the same id once each group's own id is taken out, then the same kind in order.
 * Paired groups pair their own parts the same way, so a part pairs with a part, never a group
 * with a path. Two paths (or a path and a group with no children) pair whole.
 */
export function matchMotionNodes(from: VectorNode, into: VectorNode): MotionMatch {
	const out: MotionMatch = { pairs: [], unpairedFrom: [], unpairedInto: [] };
	const visit = (a: VectorNode, b: VectorNode) => {
		const aKids = a.type === 'group' ? a.children : [];
		const bKids = b.type === 'group' ? b.children : [];
		if (!aKids.length || !bKids.length) {
			out.pairs.push([a.id, b.id]);
			return;
		}
		const left = new Set(aKids);
		const right = new Set(bKids);
		const pair = (key: (n: VectorNode, group: VectorNode) => string | undefined) => {
			for (const x of [...left]) {
				const k = key(x, a);
				if (!k) continue;
				const y = [...right].find((n) => key(n, b) === k);
				if (!y) continue;
				left.delete(x);
				right.delete(y);
				if (x.type === 'group' && y.type === 'group') visit(x, y);
				else out.pairs.push([x.id, y.id]);
			}
		};
		pair((n) => n.name?.trim() || undefined);
		pair((n, g) => localId(n.id, g.id) || undefined);
		// Then the same kind, in stacking order.
		for (const x of [...left]) {
			const y = [...right].find((n) => n.type === x.type);
			if (!y) continue;
			left.delete(x);
			right.delete(y);
			if (x.type === 'group' && y.type === 'group') visit(x, y);
			else out.pairs.push([x.id, y.id]);
		}
		out.unpairedFrom.push(...[...left].map((n) => n.id));
		out.unpairedInto.push(...[...right].map((n) => n.id));
	};
	visit(from, into);
	return out;
}
