/**
 * House style for spreadsheets (#779): the `spreadsheet.json` profile (header case, number
 * formats by kind, a frozen header row, the colours conditional formats may use), its checks,
 * and `check_spreadsheet_style` / `fix_spreadsheet_style`.
 *
 * Findings target cells in A1 notation (`{ cell: "B3" }`), with the fix when it is certain
 * (`numberFormat` or `value`), or a conditional format rule (`{ rule: id }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import { TEXT_CASES, applyTextCase } from '../tools/text-case.js';
import { indexToColName } from './formula/evaluator.js';
import { cellFormatForNumberFormat } from './numfmt/presets.js';
import type { SpreadsheetDocument } from './types.js';
import type { SpreadsheetController } from './controller.js';

/** The `spreadsheet.json` profile, after `$token` references are resolved. */
export interface SpreadsheetStyleProfile {
	headerCase?: 'sentence' | 'title' | 'upper';
	properNouns?: string[];
	/** Excel format codes by kind: what every cell of that kind should use. */
	numberFormats?: Partial<Record<'number' | 'currency' | 'percentage' | 'date', string>>;
	/** Header rows stay visible (frozen) while scrolling. */
	freezeHeader?: boolean;
	/** Colours conditional formats may use (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target: a cell (with the certain fix) or a conditional format rule. */
export type SpreadsheetStyleTarget = { cell: string; numberFormat?: string; value?: string } | { rule: string } | { sheet: true };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as SpreadsheetStyleProfile;
const address = (row: number, col: number) => `${indexToColName(col)}${row + 1}`;
const headerRows = (doc: SpreadsheetDocument) => Math.max(1, doc.table?.headerRowCount ?? 1);

const headerCase: StyleCheck<SpreadsheetDocument> = {
	id: 'header-case',
	description: 'Header cells (the header rows; the first row by default) use the house case ("headerCase"), keeping acronyms, words with digits and "properNouns". Formulas and numbers are left alone.',
	run(doc, profile) {
		const { headerCase: kind, properNouns = [] } = profileOf(profile);
		if (!kind) throw new Error('the profile has no "headerCase".');
		const out: Finding[] = [];
		for (let r = 0; r < Math.min(headerRows(doc), doc.rows.length); r++) {
			doc.columns.forEach((col, c) => {
				const cell = doc.cells[doc.rows[r].id]?.[col.id];
				if (!cell || typeof cell.value !== 'string' || !cell.value.trim() || cell.raw.startsWith('=')) return;
				const want = applyTextCase(cell.raw, kind, properNouns);
				if (want === cell.raw) return;
				out.push({ severity: 'warning' as const, message: `Header ${address(r, c)} "${cell.raw}" is not in ${kind} case; write "${want}".`, target: { cell: address(r, c), value: want } satisfies SpreadsheetStyleTarget });
			});
		}
		return out;
	}
};

const numberFormats: StyleCheck<SpreadsheetDocument> = {
	id: 'number-formats',
	description: 'Cells formatted as a number, currency, percentage or date use the house format code for that kind ("numberFormats", e.g. { "currency": "\\"$\\"#,##0.00" }).',
	run(doc, profile) {
		const wanted = profileOf(profile).numberFormats;
		if (!wanted || !Object.keys(wanted).length) throw new Error('the profile has no "numberFormats".');
		const out: Finding[] = [];
		doc.rows.forEach((row, r) => {
			doc.columns.forEach((col, c) => {
				const cell = doc.cells[row.id]?.[col.id];
				const code = cell?.numberFormat;
				if (!code) return;
				const kind = cellFormatForNumberFormat(code);
				if (kind !== 'number' && kind !== 'currency' && kind !== 'percentage' && kind !== 'date') return;
				const want = wanted[kind];
				if (!want || want === code) return;
				out.push({ severity: 'info' as const, message: `${address(r, c)} shows a ${kind} as ${code}; the house format is ${want}.`, target: { cell: address(r, c), numberFormat: want } satisfies SpreadsheetStyleTarget });
			});
		});
		return out;
	}
};

const freezeHeader: StyleCheck<SpreadsheetDocument> = {
	id: 'freeze-header',
	description: 'The header rows stay visible while scrolling ("freezeHeader": true): at least as many frozen rows as header rows.',
	run(doc, profile) {
		if (profileOf(profile).freezeHeader !== true) return [];
		const header = headerRows(doc);
		if ((doc.table?.frozenRowCount ?? 0) >= header) return [];
		return [{ severity: 'info' as const, message: `Freeze the top ${header === 1 ? 'row' : `${header} rows`} so the header stays visible.`, target: { sheet: true } satisfies SpreadsheetStyleTarget }];
	}
};

/** The colours a sheet's conditional formats use, for the shared checks. */
export function spreadsheetStyleSurface(doc: SpreadsheetDocument): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const rule of doc.table?.conditionalFormats ?? []) {
		const target = { rule: rule.id };
		const label = `Conditional format ${rule.id}`;
		const style = (rule as { style?: { fill?: string; color?: string } }).style;
		if (style?.fill) colors.push({ color: style.fill, label: `${label} fill`, target, use: 'background' });
		if (style?.color) colors.push({ color: style.color, label: `${label} text`, target, use: 'text', ...(style.fill ? { background: style.fill } : {}) });
		for (const stop of (rule as { stops?: { color: string }[] }).stops ?? []) colors.push({ color: stop.color, label: `${label} scale`, target, use: 'fill' });
		const bar = (rule as { type?: string; color?: string }).type === 'dataBar' ? (rule as { color?: string }).color : undefined;
		if (bar) colors.push({ color: bar, label: `${label} bar`, target, use: 'fill' });
	}
	return { colors };
}

/** The spreadsheet house-style domain: register it with `createStyleResolver({ domains })`. */
export const spreadsheetStyleDomain: StyleDomain<SpreadsheetDocument> = {
	id: 'spreadsheet',
	title: 'Spreadsheets',
	description: 'How sheets read: header case, the number format for each kind of value, a frozen header row, and the colours conditional formats may use.',
	profileSchema: {
		type: 'object',
		properties: {
			headerCase: { type: 'string', enum: [...TEXT_CASES], description: 'Case for header cells: "sentence", "title" or "upper".' },
			properNouns: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Names written exactly as given in any header case.' },
			numberFormats: {
				type: 'object',
				properties: {
					number: { type: 'string', minLength: 1, description: 'Excel format code for plain numbers, e.g. "#,##0.00".' },
					currency: { type: 'string', minLength: 1, description: 'Excel format code for money, e.g. "\\"$\\"#,##0.00".' },
					percentage: { type: 'string', minLength: 1, description: 'Excel format code for percentages, e.g. "0.0%".' },
					date: { type: 'string', minLength: 1, description: 'Excel format code for dates, e.g. "yyyy-mm-dd".' }
				},
				additionalProperties: false,
				description: 'The house number format for each kind of value.'
			},
			freezeHeader: { type: 'boolean', description: 'Keep the header rows visible while scrolling.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours conditional formats may use (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [headerCase, numberFormats, freezeHeader],
	surface: spreadsheetStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		headerCase: 'sentence',
		numberFormats: { number: '#,##0', currency: '"$"#,##0.00', percentage: '0.0%', date: 'yyyy-mm-dd' },
		freezeHeader: true,
		checks: ['header-case', 'number-formats', 'freeze-header', 'palette-only']
	}
};

export interface SpreadsheetStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `spreadsheet-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work (`report`, ...): skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The sheet cannot be changed: `fix_spreadsheet_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_spreadsheet_style` and, while the sheet is editable, `fix_spreadsheet_style` (applies
 * every certain fix, number formats, header case and a frozen header, as one undo step).
 */
export function createSpreadsheetStyleToolProvider(controller: SpreadsheetController, styles: StyleResolver, options: SpreadsheetStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'spreadsheet')) throw new Error('The style resolver has no "spreadsheet" domain; add spreadsheetStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This sheet is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('spreadsheet', controller.document, scope);

	const check: AgentTool = {
		name: 'check_spreadsheet_style',
		title: 'Check spreadsheet house style',
		description:
			'Checks the sheet against the house style (see get_style with domain "spreadsheet"): runs the checks its profile turns on (header-case, number-formats, freeze-header, and the brand\'s palette-only and min-contrast on conditional format colours). Returns findings with a severity, a sentence saying how to fix it, a target ({ cell: "B3" } with the numberFormat or value to set when the fix is certain, { rule: id } for a conditional format, or { sheet: true }) and the layer that asked; the checks that ran and those skipped. fix_spreadsheet_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check spreadsheet house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			const certain = report.findings.filter((f) => {
				const t = f.target as SpreadsheetStyleTarget | undefined;
				return !!t && (('cell' in t && (t.numberFormat !== undefined || t.value !== undefined)) || 'sheet' in t);
			}).length;
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: certain,
				...(style.skills.length ? {} : { note: 'No house style applies to spreadsheets.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_spreadsheet_style',
		title: 'Fix spreadsheet house style',
		description:
			'Applies every certain house-style fix as one undo step: the house number format on cells of each kind, header text in the house case, and a frozen header. Read-only cells are skipped. Returns how many it fixed and the findings left for you (conditional format colours: change them with the conditional format tools). Run check_spreadsheet_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix spreadsheet house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const doc = controller.document;
			const at = (cell: string) => {
				const m = /^([A-Z]+)(\d+)$/.exec(cell)!;
				const c = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
				return { r: Number(m[2]) - 1, c };
			};
			let fixed = 0;
			const left: StyleFinding[] = [];
			controller.batch(() => {
				for (const f of findings) {
					const t = f.target as SpreadsheetStyleTarget | undefined;
					if (t && 'sheet' in t && f.check === 'freeze-header') {
						controller.setFrozenRowCount(headerRows(doc));
						fixed++;
						continue;
					}
					if (!t || !('cell' in t) || (t.numberFormat === undefined && t.value === undefined)) {
						left.push(f);
						continue;
					}
					const { r, c } = at(t.cell);
					const row = doc.rows[r];
					const col = doc.columns[c];
					if (!row || !col || col.readOnly || controller.getCell(row.id, col.id).readOnly) {
						left.push(f);
						continue;
					}
					if (t.numberFormat !== undefined) controller.setCellNumberFormat({ startRow: r, startCol: c, endRow: r, endCol: c }, t.numberFormat);
					if (t.value !== undefined) controller.setCellValue(row.id, col.id, t.value);
					fixed++;
				}
			});
			return { fixed, left };
		}
	};

	return {
		id: options.id ?? 'spreadsheet-style',
		namespace: options.namespace,
		title: 'Spreadsheet house style',
		description: 'Check a sheet against the house style and apply its certain fixes.',
		skill: 'pixerate-spreadsheet',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
