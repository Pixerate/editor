import { readZip, type ZipArchive, type ZipReadOptions } from '../import/zip.js';
import { CHART_OOXML_NS, chartFromOoxml } from './ooxml.js';
import type { ChartSpec } from './types.js';

type ParserCtor = { new (): DOMParser };

/** Office files charts can be read from. */
export type OfficeChartFileFormat = 'xlsx' | 'pptx' | 'docx';

/** A chart found in an Excel workbook, PowerPoint deck or Word document. */
export interface OfficeFileChart {
	/** `chart-1`, `chart-2`, … in file order (sheets, slides or the document body). */
	id: string;
	/** The chart part, e.g. `xl/charts/chart1.xml` or `ppt/charts/chartEx1.xml`. */
	path: string;
	/** `chart` for DrawingML (`c:chartSpace`), `chartex` for Office 2016 charts (`cx:chartSpace`). */
	partKind: 'chart' | 'chartex';
	/** Worksheet or chart sheet name (xlsx). */
	sheet?: string;
	/** 1-based slide number (pptx). */
	slide?: number;
	/** Top-left cell the chart is anchored to, e.g. `B2` (xlsx worksheets). */
	anchor?: string;
	/** The cells the chart covers, e.g. `B2:H18` (xlsx two-cell anchors). */
	range?: string;
	/** The shape name (`cNvPr name`), e.g. `Chart 3`. */
	name?: string;
	/** The chart's title (may be empty). */
	title: string;
	spec: ChartSpec;
	/** Problems reading it, as sentences. */
	issues: string[];
	/** Features the chart editor cannot hold (3-D, stock, …). */
	unsupported: string[];
	/** Writing `spec` back loses nothing. */
	lossless: boolean;
}

export interface OfficeChartsResult {
	format: OfficeChartFileFormat;
	charts: OfficeFileChart[];
}

export interface OfficeChartsReadOptions extends ZipReadOptions {
	/** `DOMParser` constructor (default: the global one; pass jsdom's or xmldom's in Node). */
	DOMParser?: ParserCtor;
	/** Stop after this many charts (default 500). */
	maxCharts?: number;
}

/** Thrown when the bytes are not a readable Office file of the expected kind. */
export class OfficeChartsError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'OfficeChartsError';
	}
}

const CHARTEX_NS = 'http://schemas.microsoft.com/office/drawing/2014/chartex';
const STRICT_CHART_NS = 'http://purl.oclc.org/ooxml/drawingml/chart';

interface Relationship {
	type: string;
	target: string;
	external: boolean;
}

interface Reader {
	zip: ZipArchive;
	Parser: ParserCtor;
	max: number;
	charts: OfficeFileChart[];
	seen: Set<string>;
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

function resolvePartPath(baseDir: string, target: string): string {
	const out: string[] = [];
	for (const segment of (target.startsWith('/') ? target.slice(1) : baseDir + target).split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') out.pop();
		else out.push(segment);
	}
	return out.join('/');
}

const relsPathFor = (partPath: string) => `${dirname(partPath)}_rels/${partPath.slice(dirname(partPath).length)}.rels`;

function elements(root: Document | Element, localName: string): Element[] {
	return Array.from(root.getElementsByTagNameNS('*', localName));
}

/** A relationship id attribute (`r:id`, `r:embed`) in the transitional or strict namespace. */
function relId(el: Element, localName = 'id'): string | undefined {
	for (const a of Array.from(el.attributes)) {
		if (a.localName === localName && (a.namespaceURI?.includes('relationships') || a.prefix === 'r')) return a.value;
	}
	return undefined;
}

const firstChild = (el: Element | undefined, localName: string): Element | undefined =>
	el ? Array.from(el.children ?? el.childNodes).find((n): n is Element => n.nodeType === 1 && (n as Element).localName === localName) : undefined;

async function readXml(r: Reader, path: string): Promise<Document | null> {
	const entry = r.zip.get(path) ?? r.zip.entries.find((e) => e.name.toLowerCase() === path.toLowerCase());
	if (!entry) return null;
	const doc = new r.Parser().parseFromString(await r.zip.readText(entry), 'application/xml');
	return doc.getElementsByTagName('parsererror').length ? null : doc;
}

async function readRels(r: Reader, partPath: string): Promise<Map<string, Relationship>> {
	const rels = new Map<string, Relationship>();
	const doc = await readXml(r, relsPathFor(partPath));
	if (!doc) return rels;
	for (const rel of elements(doc, 'Relationship')) {
		const id = rel.getAttribute('Id');
		if (!id) continue;
		const target = rel.getAttribute('Target') ?? '';
		const external = rel.getAttribute('TargetMode')?.toLowerCase() === 'external';
		rels.set(id, { type: rel.getAttribute('Type') ?? '', target: external ? target : resolvePartPath(dirname(partPath), target), external });
	}
	return rels;
}

const isChartRef = (el: Element) => el.localName === 'chart' && (el.namespaceURI === CHART_OOXML_NS || el.namespaceURI === STRICT_CHART_NS || el.namespaceURI === CHARTEX_NS);

/** The `cNvPr name` of the graphic frame around a chart reference, if any. */
function frameName(ref: Element): string | undefined {
	for (let el: Element | null = ref.parentElement; el; el = el.parentElement) {
		if (el.localName === 'graphicFrame') {
			const nv = elements(el, 'cNvPr')[0];
			return nv?.getAttribute('name') || undefined;
		}
	}
	return undefined;
}

/** Reads every chart a part references (`c:chart r:id`, `cx:chart r:id`) and adds it to `r.charts`. */
async function chartsInPart(r: Reader, root: Document | Element, rels: Map<string, Relationship>, place: (ref: Element) => Partial<OfficeFileChart>): Promise<void> {
	for (const ref of elements(root, 'chart')) {
		if (r.charts.length >= r.max) return;
		if (!isChartRef(ref)) continue;
		const rel = rels.get(relId(ref) ?? '');
		if (!rel || rel.external || r.seen.has(rel.target)) continue;
		const entry = r.zip.get(rel.target);
		if (!entry) continue;
		r.seen.add(rel.target);
		const read = chartFromOoxml(await r.zip.readText(entry), { DOMParser: r.Parser });
		const name = frameName(ref);
		r.charts.push({
			id: `chart-${r.charts.length + 1}`,
			path: rel.target,
			partKind: ref.namespaceURI === CHARTEX_NS ? 'chartex' : 'chart',
			...place(ref),
			...(name ? { name } : {}),
			title: read.spec.title,
			spec: read.spec,
			issues: read.issues.map((i) => i.message),
			unsupported: read.unsupported,
			lossless: read.lossless
		});
	}
}

/** `0` → `A`, `27` → `AB`. */
function columnName(index: number): string {
	let name = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

function anchorCell(marker: Element | undefined): string | undefined {
	const col = Number(firstChild(marker, 'col')?.textContent);
	const row = Number(firstChild(marker, 'row')?.textContent);
	return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 ? `${columnName(col)}${row + 1}` : undefined;
}

/** The anchor (`xdr:twoCellAnchor`, `xdr:oneCellAnchor`) a chart reference sits in. */
function drawingPlace(ref: Element): Partial<OfficeFileChart> {
	for (let el: Element | null = ref.parentElement; el; el = el.parentElement) {
		if (el.localName === 'twoCellAnchor' || el.localName === 'oneCellAnchor') {
			const anchor = anchorCell(firstChild(el, 'from'));
			const to = el.localName === 'twoCellAnchor' ? anchorCell(firstChild(el, 'to')) : undefined;
			return { ...(anchor ? { anchor } : {}), ...(anchor && to ? { range: `${anchor}:${to}` } : {}) };
		}
		if (el.localName === 'absoluteAnchor') return {};
	}
	return {};
}

async function readMainPart(r: Reader): Promise<{ path: string; doc: Document }> {
	const rootRels = await readRels(r, '');
	const main = [...rootRels.values()].find((rel) => /\/officeDocument$/.test(rel.type) && !rel.external);
	const doc = main ? await readXml(r, main.target) : null;
	if (!main || !doc) throw new OfficeChartsError('This is not an Office file: _rels/.rels names no main part (expected an .xlsx, .pptx or .docx file).');
	return { path: main.target, doc };
}

async function readXlsx(r: Reader, main: { path: string; doc: Document }): Promise<void> {
	const rels = await readRels(r, main.path);
	for (const sheet of elements(main.doc, 'sheet')) {
		const rel = rels.get(relId(sheet) ?? '');
		if (!rel || rel.external) continue;
		const doc = await readXml(r, rel.target);
		if (!doc) continue;
		const sheetName = sheet.getAttribute('name') ?? rel.target;
		const sheetRels = await readRels(r, rel.target);
		for (const drawingRef of elements(doc, 'drawing')) {
			const drawingRel = sheetRels.get(relId(drawingRef) ?? '');
			if (!drawingRel || drawingRel.external) continue;
			const drawing = await readXml(r, drawingRel.target);
			if (!drawing) continue;
			const drawingRels = await readRels(r, drawingRel.target);
			await chartsInPart(r, drawing, drawingRels, (ref) => ({ sheet: sheetName, ...drawingPlace(ref) }));
		}
	}
}

async function readPptx(r: Reader, main: { path: string; doc: Document }): Promise<void> {
	const rels = await readRels(r, main.path);
	const slides = elements(main.doc, 'sldId');
	for (let i = 0; i < slides.length; i++) {
		const rel = rels.get(relId(slides[i]) ?? '');
		if (!rel || rel.external) continue;
		const doc = await readXml(r, rel.target);
		if (!doc) continue;
		await chartsInPart(r, doc, await readRels(r, rel.target), () => ({ slide: i + 1 }));
	}
}

async function readDocx(r: Reader, main: { path: string; doc: Document }): Promise<void> {
	await chartsInPart(r, main.doc, await readRels(r, main.path), () => ({}));
}

async function open(bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions): Promise<{ r: Reader; main: { path: string; doc: Document }; format: OfficeChartFileFormat }> {
	const Parser = options.DOMParser ?? (globalThis as { DOMParser?: ParserCtor }).DOMParser;
	if (!Parser) throw new OfficeChartsError('Reading Office files needs a DOMParser. In Node, pass one (e.g. from jsdom or @xmldom/xmldom) as { DOMParser }.');
	let zip: ZipArchive;
	try {
		zip = await readZip(bytes, options);
	} catch (error) {
		throw new OfficeChartsError(`This is not an Office file: ${(error as Error).message}`, { cause: error });
	}
	const r: Reader = { zip, Parser, max: options.maxCharts ?? 500, charts: [], seen: new Set() };
	const main = await readMainPart(r);
	const root = main.doc.documentElement.localName;
	const format: OfficeChartFileFormat | undefined = root === 'workbook' ? 'xlsx' : root === 'presentation' ? 'pptx' : root === 'document' ? 'docx' : undefined;
	if (!format) throw new OfficeChartsError(`The main part ${main.path} is a <${root}>; expected an Excel workbook, PowerPoint presentation or Word document.`);
	return { r, main, format };
}

const READERS: Record<OfficeChartFileFormat, (r: Reader, main: { path: string; doc: Document }) => Promise<void>> = { xlsx: readXlsx, pptx: readPptx, docx: readDocx };

/**
 * Reads every chart in an Office file, detecting whether it is a workbook (charts on each
 * worksheet's or chart sheet's drawing, with the sheet name and anchor cell), a presentation
 * (charts on each slide, with the slide number) or a Word document (charts in the body).
 * DrawingML and Office 2016 chartex parts are both read with `chartFromOoxml`; data comes
 * from the cached values. Throws `OfficeChartsError` when the bytes are not an Office file.
 */
export async function extractOfficeCharts(bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions = {}): Promise<OfficeChartsResult> {
	const { r, main, format } = await open(bytes, options);
	await READERS[format](r, main);
	return { format, charts: r.charts };
}

async function extractAs(format: OfficeChartFileFormat, bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions): Promise<OfficeFileChart[]> {
	const result = await extractOfficeCharts(bytes, options);
	if (result.format !== format) throw new OfficeChartsError(`This is a .${result.format} file, not a .${format} file.`);
	return result.charts;
}

/** The charts in an Excel workbook (`xl/drawings/drawingN.xml` → `xl/charts/chartN.xml`), with sheet and anchor cell. */
export const extractXlsxCharts = (bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions = {}) => extractAs('xlsx', bytes, options);

/** The charts in a PowerPoint deck (`p:graphicFrame` → `ppt/charts/chartN.xml`), with their slide number. */
export const extractPptxCharts = (bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions = {}) => extractAs('pptx', bytes, options);

/** The charts in the body of a Word document (`word/charts/chartN.xml`). */
export const extractDocxCharts = (bytes: ArrayBuffer | ArrayBufferView, options: OfficeChartsReadOptions = {}) => extractAs('docx', bytes, options);

/** Where a chart sits, for labels: `Sheet1!B2`, `Slide 3`, `Document`. */
export function describeOfficeChartPlace(chart: OfficeFileChart): string {
	if (chart.sheet !== undefined) return chart.anchor ? `${chart.sheet}!${chart.anchor}` : chart.sheet;
	if (chart.slide !== undefined) return `Slide ${chart.slide}`;
	return 'Document';
}
