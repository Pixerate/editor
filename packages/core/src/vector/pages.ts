/**
 * Multipage documents with master pages, built on frames (after CorelDRAW's pages and master
 * page, concept only). The document's pages are its top-level frames in order, except master
 * pages: top-level frames with `frame.master` set. A page whose `frame.masterId` names a master
 * draws the master's children under its own, laid out by each child's resizing constraints from
 * the master's rectangle to the page's (so a footer pinned to the bottom stays at the bottom of a
 * taller page). Text on a master can show `{page}` (the page's number) and `{pages}` (how many).
 *
 * The drawn master art (`masterArt`) is derived like a lens's backdrop: `resolveVectorMasterPages`
 * brings it up to date after every edit (the controller's refresh) and `stripVectorMasterArt`
 * removes it from saved documents. Node objects are kept when nothing changed, so render caches
 * hold.
 */
import { isVectorFrame, vectorFrameChildMatrix, type VectorFrameGroup } from './frames.js';
import { transformVectorNode, vectorNodeBounds } from './geometry.js';
import type { VectorDocument, VectorNode, VectorTextNode, VectorTextRun } from './types.js';

/** Whether `node` is a master page (a frame with `master` set). */
export function isVectorMasterPage(node: VectorNode | null | undefined): node is VectorFrameGroup {
	return isVectorFrame(node) && !!node.frame.master;
}

/** The document's pages: its top-level frames that are not master pages, in order. */
export function vectorPages(doc: Pick<VectorDocument, 'nodes'>): VectorFrameGroup[] {
	return doc.nodes.filter((n): n is VectorFrameGroup => isVectorFrame(n) && !n.frame.master);
}

/** The document's master pages (top-level frames with `master` set), in order. */
export function vectorMasterPages(doc: Pick<VectorDocument, 'nodes'>): VectorFrameGroup[] {
	return doc.nodes.filter(isVectorMasterPage);
}

/** Text with `{page}` and `{pages}` filled in, its runs' lengths kept in step. */
function fillTokens(node: VectorTextNode, page: number, pages: number): VectorTextNode {
	const map = (s: string) => s.replace(/\{page\}/g, String(page)).replace(/\{pages\}/g, String(pages));
	if (!/\{pages?\}/.test(node.text)) return node;
	if (!node.runs?.length) return { ...node, text: map(node.text) };
	let at = 0;
	let text = '';
	const runs: VectorTextRun[] = [];
	for (const r of node.runs) {
		const part = map(node.text.slice(at, at + r.length));
		at += r.length;
		text += part;
		runs.push({ ...r, length: part.length });
	}
	return { ...node, text: text + map(node.text.slice(at)), runs };
}

/** A master's child on a page: ids made unique to the page, tokens filled in. */
function onPage(node: VectorNode, pageId: string, page: number, pages: number): VectorNode {
	const id = `${pageId}~master~${node.id}`;
	if (node.type === 'group') return { ...node, id, children: node.children.map((c) => onPage(c, pageId, page, pages)) };
	if (node.type === 'text') return { ...fillTokens(node, page, pages), id, locked: true };
	return { ...node, id, locked: true } as VectorNode;
}

const artCache = new WeakMap<VectorFrameGroup, Map<string, VectorNode[]>>();

/** The master's art as drawn on a page (cached per master object and page placement). */
export function vectorMasterArt(master: VectorFrameGroup, page: VectorFrameGroup, number: number, count: number): VectorNode[] {
	const f = page.frame;
	const key = `${page.id}|${f.x}|${f.y}|${f.width}|${f.height}|${number}|${count}`;
	let byKey = artCache.get(master);
	const hit = byKey?.get(key);
	if (hit) return hit;
	const art = master.children
		.filter((c) => c.visible !== false)
		.map((c) => {
			const box = vectorNodeBounds(c);
			const m = box ? vectorFrameChildMatrix(c.resizing, box, master.frame, page.frame) : null;
			return onPage(m ? transformVectorNode(c, m) : c, page.id, number, count);
		});
	if (!byKey) artCache.set(master, (byKey = new Map()));
	byKey.set(key, art);
	return art;
}

/**
 * The document with every page's `masterArt` up to date (and gone from pages without a master).
 * The same document object when nothing changed.
 */
export function resolveVectorMasterPages(doc: VectorDocument): VectorDocument {
	const masters = new Map(vectorMasterPages(doc).map((m) => [m.id, m]));
	const pages = vectorPages(doc);
	const numbers = new Map(pages.map((p, i) => [p.id, i + 1]));
	let changed = false;
	const nodes = doc.nodes.map((n) => {
		if (!isVectorFrame(n)) return n;
		const master = !n.frame.master && n.frame.masterId ? masters.get(n.frame.masterId) : undefined;
		const art = master ? vectorMasterArt(master, n, numbers.get(n.id) ?? 0, pages.length) : undefined;
		if (art === n.masterArt || (!art && !n.masterArt)) return n;
		changed = true;
		if (!art) {
			const { masterArt: _m, ...rest } = n;
			return rest as VectorFrameGroup;
		}
		return { ...n, masterArt: art };
	});
	return changed ? { ...doc, nodes } : doc;
}

/** The document without pages' drawn master art (what is saved). */
export function stripVectorMasterArt(doc: VectorDocument): VectorDocument {
	if (!doc.nodes.some((n) => n.type === 'group' && n.masterArt)) return doc;
	return {
		...doc,
		nodes: doc.nodes.map((n) => {
			if (n.type !== 'group' || !n.masterArt) return n;
			const { masterArt: _m, ...rest } = n;
			return rest;
		})
	};
}
