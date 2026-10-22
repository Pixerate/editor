// Agent playback on a spreadsheet (see `tools/playback.ts`): the cursor clicks the cell a write
// names and types the value, drags across a block it fills, or marks the rows and columns it
// inserts or deletes. Plans only name cells (A1 refs); the grid component finds them on screen.
import type { PlaybackRef, PlaybackStep } from '../tools/playback.js';
import { colNameToIndex, indexToColName } from './formula/evaluator.js';

/** Rows and columns (0-based, inclusive) a playback ref covers; `null` ends mean the whole sheet. */
export interface SpreadsheetPlaybackRange {
	startRow: number | null;
	endRow: number | null;
	startCol: number | null;
	endCol: number | null;
}

const CELL = /^\s*\$?([A-Za-z]{1,3})\$?(\d+)\s*$/;
const COL = /^\s*([A-Za-z]{1,3})\s*$/;
const ROW = /^\s*(\d+)\s*$/;

/**
 * Parses a playback ref to the rows and columns it covers: `{ kind: 'cell', id: 'B2' | 'B2:D5' }`,
 * `{ kind: 'row', id: '5' | '5:7' }` (1-based) or `{ kind: 'column', id: 'C' | 'C:E' }`. Null otherwise.
 */
export function parseSpreadsheetPlaybackRef(ref: PlaybackRef): SpreadsheetPlaybackRange | null {
	const [a, b = a] = ref.id.split(':');
	if (!a) return null;
	if (ref.kind === 'cell') {
		const s = CELL.exec(a);
		const e = CELL.exec(b!);
		if (!s || !e) return null;
		const r = [Number(s[2]) - 1, Number(e[2]) - 1];
		const c = [colNameToIndex(s[1]!.toUpperCase()), colNameToIndex(e[1]!.toUpperCase())];
		return { startRow: Math.min(r[0]!, r[1]!), endRow: Math.max(r[0]!, r[1]!), startCol: Math.min(c[0]!, c[1]!), endCol: Math.max(c[0]!, c[1]!) };
	}
	if (ref.kind === 'row') {
		const s = ROW.exec(a);
		const e = ROW.exec(b!);
		if (!s || !e) return null;
		return { startRow: Math.min(+s[1]!, +e[1]!) - 1, endRow: Math.max(+s[1]!, +e[1]!) - 1, startCol: null, endCol: null };
	}
	if (ref.kind === 'column') {
		const s = COL.exec(a);
		const e = COL.exec(b!);
		if (!s || !e) return null;
		const c = [colNameToIndex(s[1]!.toUpperCase()), colNameToIndex(e[1]!.toUpperCase())];
		return { startRow: null, endRow: null, startCol: Math.min(c[0]!, c[1]!), endCol: Math.max(c[0]!, c[1]!) };
	}
	return null;
}

const cell = (id: string): PlaybackRef => ({ kind: 'cell', id });

const shown = (v: unknown): string | null => {
	if (v === null || v === undefined || v === '') return null;
	const text = String(v);
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

/** The cursor steps for one spreadsheet tool call (by bare name), or null to visit its `range` / `cell`. */
export function planSpreadsheetToolPlayback(tool: string, args: Record<string, any>): PlaybackStep[] | null {
	const count = Number.isInteger(args.count) && args.count > 0 ? (args.count as number) : 1;
	switch (tool) {
		case 'set_cell': {
			if (typeof args.cell !== 'string') return null;
			const value = shown(args.value);
			return [{ type: 'target', ref: cell(args.cell) }, { type: 'press' }, { type: 'release' }, ...(value ? [{ type: 'type' as const, text: value }] : [])];
		}
		case 'set_range': {
			const start = typeof args.start === 'string' ? CELL.exec(args.start) : null;
			const rows = Array.isArray(args.values) ? (args.values as unknown[][]) : [];
			if (!start || !rows.length) return null;
			const width = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)));
			const col = colNameToIndex(start[1]!.toUpperCase());
			const end = `${indexToColName(col + width - 1)}${Number(start[2]) + rows.length - 1}`;
			const first = shown(rows.flat().find((v) => v !== null && v !== undefined && v !== ''));
			// Drag across the block it fills, then type the first value.
			return [
				{ type: 'target', ref: cell(args.start) },
				{ type: 'press' },
				{ type: 'target', ref: cell(`${args.start}:${end}`) },
				{ type: 'release' },
				...(first ? [{ type: 'type' as const, text: first }] : [])
			];
		}
		case 'insert_rows':
		case 'delete_rows': {
			const from = Number(tool === 'insert_rows' ? args.before : args.start);
			if (!Number.isInteger(from) || from < 1) return null;
			return [{ type: 'target', ref: { kind: 'row', id: `${from}:${from + count - 1}` } }, { type: 'press' }, { type: 'release' }];
		}
		case 'insert_columns':
		case 'delete_columns': {
			const from = String(tool === 'insert_columns' ? args.before : args.start ?? '');
			if (!COL.test(from)) return null;
			const index = colNameToIndex(from.trim().toUpperCase());
			return [{ type: 'target', ref: { kind: 'column', id: `${indexToColName(index)}:${indexToColName(index + count - 1)}` } }, { type: 'press' }, { type: 'release' }];
		}
		default:
			return null;
	}
}
