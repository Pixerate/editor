/**
 * Keeps the agent skills in `packages/core/skills` in step with the tools.
 *
 * Every editor domain ships a `skills/<name>/SKILL.md` (Agent Skills format) that tells a
 * model when and how to use each of its tools. A skill lists its tools and command ids as
 * the first cell of its reference tables (`| \`get_chart\` | ... |`), and this test checks
 * that list against the live providers in both directions: a new tool fails until a skill
 * documents it, and a renamed or removed tool fails until the skill drops it. A new
 * `create*ToolProvider` or `create*Commands` factory fails until it is mapped to a skill
 * below.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Editor } from '@tiptap/core';
import { TOOL_DISCOVERY_TOOLS, createAgentPlayback, createPlaybackToolProvider, createStyleResolver, createStyleToolProvider, memoryStyleStore } from '../src/tools';
import {
	ToolRegistry,
	baseToolName,
	createRichTextToolProvider,
	createSpreadsheetToolProvider,
	createEditorMcpToolProvider,
	createCanvasComponentToolProvider,
	type AgentToolProvider
} from '../src/agent';
import {
	CommandRegistry,
	createCommandToolProvider,
	createHistoryCommands,
	createArrangeCommands,
	createShapeCommands,
	createDrawCommands,
	createComponentCommands,
	createSpreadsheetCommands,
	createCanvasAnimationCommands,
	type CommandSpec
} from '../src/commands';
import { ImageEditorController, createImageEditorDocument, createImageEditorToolProvider, createImageEffectsToolProvider, createImageSegmentationToolProvider } from '../src/image-editor';
import { PaintEditorController, createPaintEditorDocument, createPaintEditorToolProvider, createPaintEffectsToolProvider } from '../src/paint-editor';
import { createGenerationToolProvider, createGenerationHistoryToolProvider, createGenerationRecordStore } from '../src/generation';
import { createDocumentToolProvider, createEditorDocumentStore, createMemoryStorage } from '../src/persistence';
import { TokenStore, createTokensEditorDocument, createTokensStyleToolProvider, tokensStyleDomain } from '../src/tokens';
import { createSpreadsheetEditorDocument } from '../src/spreadsheet';
import { ChartController, createChartEditorDocument, createChartToolProvider, createOfficeChartToolProvider, createChartCommands, createChartStyleToolProvider, chartStyleDomain } from '../src/chart';
import { DiagramController, createDiagramEditorDocument, createDiagramToolProvider } from '../src/diagram';
import { canvasExplosionToolTarget, createCanvasCaptureToolProvider, createCanvasEditorDocument, createCanvasEffectsController, createCanvasEffectsToolProvider, createCanvasExplosionStateController, createCanvasExplosionToolProvider } from '../src/canvas';
import { HistoryManager } from '../src/history';
import { AnimationEditorController, createAnimationEditorDocument, createAnimationEditorToolProvider, createAnimationEffectsToolProvider } from '../src/animation-editor';
import { VideoEditorController, createVideoEditorDocument, createVideoEditorToolProvider, createVideoEffectsToolProvider, createVideoDialogueToolProvider, createVideoMusicToolProvider } from '../src/video-editor';
import { VectorEditorController, createVectorEditorDocument, createVectorEffectsToolProvider, createVectorCommands, createVectorGenerationToolProvider } from '../src/vector';
import { ParametersController, createParameterCommands, createParametersEditorDocument } from '../src/parameters';
import { createColorToolProvider } from '../src/color';
import { createTypographyToolProvider, createFontPickerToolProvider, FontPickerModel } from '../src/typography';
import { GradientController, createGradientToolProvider } from '../src/gradient';
import { createEffectAuthoringToolProvider, createFakeEffectProvider } from '../src/effects';
import { createRichTextPreset, createRichTextEditorDocument, SpreadsheetController, createFindReplaceCommands, createTableCommands } from '../src';

const ROOT = join(__dirname, '..');
const SKILLS_DIR = join(ROOT, 'skills');

// The per-skill tests are generated from the providers at collection time, before any
// `beforeAll` runs, so the DOM the rich text editor needs is set up here.
const dom = new JSDOM();
globalThis.document = dom.window.document as any;
globalThis.window = dom.window as any;
(globalThis as any).Node = dom.window.Node;
// As in a browser: some tools (e.g. `import_chart_ooxml`) only register when a DOMParser exists.
(globalThis as any).DOMParser = dom.window.DOMParser;

/** Command factories only read their target when a command runs, so a stub lists their ids. */
const stub: any = new Proxy(() => stub, { get: () => stub, apply: () => stub });

const toolNames = (provider: AgentToolProvider, filter: (name: string) => boolean = () => true) => {
	const registry = new ToolRegistry();
	registry.register(provider);
	return registry.listTools().tools.map((t) => baseToolName(t.name)).filter(filter);
};
const commandIds = (specs: CommandSpec[]) => specs.map((s) => s.id);

/**
 * Which tools and command ids each skill documents. Add a new provider or command set to the
 * skill for its domain (or a new skill), and list its factory in `FACTORIES` below.
 */
/** A store, so the document tools list their save / open tools too. */
const documentStore = () => createEditorDocumentStore({ storage: createMemoryStorage() });

function expectedBySkill(): Record<string, string[]> {
	const doc = new Editor({ extensions: createRichTextPreset({ chart: true }), content: '<p>x</p>' });
	const sheet = new SpreadsheetController({
		document: {
			columns: [{ id: 'c0', key: 'A', title: 'A', type: 'freeform' as const }],
			rows: [{ id: 'r0', index: 0, type: 'freeform' as const }]
		}
	});
	const editorMcp = createEditorMcpToolProvider({
		id: 'editor',
		getSnapshot: () => ({}) as any,
		applySteps: () => {},
		captureView: () => ({ data: '', mimeType: 'image/png' })
	});
	const shared = ['get_editor_state', 'view_editor'];
	const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore() }], domains: [chartStyleDomain, tokensStyleDomain] });
	const result: Record<string, string[]> = {
		'pixerate-agent-tools': [
			...toolNames(createCommandToolProvider(new CommandRegistry())),
			// Served by the MCP bridge (`createToolBridge`), which needs a socket server to list.
			'list_editors',
			// Added by discovery views (`registry.view({ discovery })`), not by a provider.
			...TOOL_DISCOVERY_TOOLS,
			...commandIds(createHistoryCommands(stub)),
			...toolNames(createPlaybackToolProvider(createAgentPlayback())),
			...toolNames(createStyleToolProvider(styles))
		],
		'pixerate-rich-text': [
			...toolNames(createRichTextToolProvider(doc, { id: 'doc' })),
			...toolNames(editorMcp, (n) => n.startsWith('prompt_') || shared.includes(n)),
			...commandIds(createFindReplaceCommands(doc)),
			...commandIds(createTableCommands(doc)),
			...toolNames(createDocumentToolProvider(createRichTextEditorDocument(doc), { store: documentStore() }))
		],
		'pixerate-spreadsheet': [
			...toolNames(createSpreadsheetToolProvider(sheet, { id: 'sheet' })),
			...commandIds(createSpreadsheetCommands(stub)),
			...toolNames(createDocumentToolProvider(createSpreadsheetEditorDocument(sheet), { store: documentStore() }))
		],
		'pixerate-canvas': [
			...toolNames(editorMcp, (n) => n.startsWith('canvas_') || shared.includes(n)),
			...toolNames(createCanvasComponentToolProvider({ addVariant: () => {}, removeVariant: () => {} } as any)),
			...toolNames(createCanvasEffectsToolProvider(createCanvasEffectsController({ getNodes: () => [], setNodes: () => {} }))),
			...toolNames(createCanvasCaptureToolProvider({ element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => [] })),
			...toolNames(createCanvasExplosionToolProvider(canvasExplosionToolTarget(createCanvasExplosionStateController(), { getNodes: () => [] }))),
			...commandIds(createArrangeCommands(stub)),
			...commandIds(createShapeCommands(stub)),
			...commandIds(createDrawCommands(stub)),
			...commandIds(createComponentCommands(stub)),
			...commandIds(createCanvasAnimationCommands(stub)),
			...toolNames(createDocumentToolProvider(createCanvasEditorDocument({ getNodes: () => [], setNodes: () => {}, getEdges: () => [], setEdges: () => {}, history: new HistoryManager() }), { store: documentStore() }))
		],
		'pixerate-vector': [...commandIds(createVectorCommands(new VectorEditorController())), ...toolNames(createVectorEffectsToolProvider(new VectorEditorController(), { id: 'vector-effects' })), ...toolNames(createVectorGenerationToolProvider(new VectorEditorController(), { models: [], generate: () => ({ svg: '' }) })), ...toolNames(createDocumentToolProvider(createVectorEditorDocument(new VectorEditorController()), { store: documentStore() }))],
		'pixerate-chart': [
			...toolNames(createChartToolProvider(new ChartController(), { id: 'chart' })),
			...toolNames(createOfficeChartToolProvider({ id: 'office', files: () => [], controller: new ChartController() })),
			...commandIds(createChartCommands(new ChartController())),
			...toolNames(createChartStyleToolProvider(new ChartController(), styles)),
			...toolNames(createDocumentToolProvider(createChartEditorDocument(new ChartController()), { history: false, store: documentStore() }))
		],
		'pixerate-diagram': [
			...toolNames(createDiagramToolProvider(new DiagramController(), { id: 'diagram', renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) })),
			// The diagram's own provider has undo_diagram / redo_diagram, so its document tools leave them out.
			...toolNames(createDocumentToolProvider(createDiagramEditorDocument(new DiagramController()), { history: false, store: documentStore() }))
		],
		'pixerate-image-editor': [
			...toolNames(createImageEditorToolProvider(new ImageEditorController(), { id: 'img' })),
			...toolNames(createImageEffectsToolProvider(new ImageEditorController(), { id: 'img-effects' })),
			// Its tools are listed only while a segmentation provider is set.
			...toolNames(createImageSegmentationToolProvider(new ImageEditorController({ segmentation: { segment: async () => [] } }), { id: 'img-segmentation' })),
			...toolNames(createDocumentToolProvider(createImageEditorDocument(new ImageEditorController()), { history: false, store: documentStore() }))
		],
		'pixerate-paint-editor': [
			...toolNames(createPaintEditorToolProvider(new PaintEditorController({ width: 64, height: 64 }), { id: 'paint' })),
			...toolNames(createPaintEffectsToolProvider(new PaintEditorController({ width: 64, height: 64 }), { id: 'paint-effects' })),
			...toolNames(createDocumentToolProvider(createPaintEditorDocument(new PaintEditorController({ width: 64, height: 64 })), { history: false, store: documentStore() }))
		],
		'pixerate-animation-editor': [
			...toolNames(createAnimationEditorToolProvider(new AnimationEditorController(), { id: 'animation' })),
			...toolNames(createAnimationEffectsToolProvider(new AnimationEditorController(), { id: 'animation-effects' })),
			...toolNames(createDocumentToolProvider(createAnimationEditorDocument(new AnimationEditorController()), { history: false, store: documentStore() }))
		],
		'pixerate-video-editor': [
			...toolNames(createVideoEditorToolProvider(new VideoEditorController(), { id: 'video' })),
			...toolNames(createVideoEffectsToolProvider(new VideoEditorController(), { id: 'video-effects' })),
			...toolNames(createDocumentToolProvider(createVideoEditorDocument(new VideoEditorController()), { history: false, store: documentStore() }))
		],
		'pixerate-talking-head-edit': toolNames(createVideoDialogueToolProvider(new VideoEditorController(), { id: 'video-dialogue' })),
		'pixerate-bgm-alignment': toolNames(createVideoMusicToolProvider(new VideoEditorController(), { id: 'video-music' })),
		// Workflow skills own no provider (see WORKFLOWS); they have no tool table.
		'pixerate-image-selection-masking': [],
		'pixerate-spreadsheet-clean-import': [],
		'pixerate-image-photo-correction': [],
		'pixerate-image-product-photo': [],
		'pixerate-image-portrait-retouch': [],
		'pixerate-vector-icon-set': [],
		'pixerate-vector-logo': [],
		'pixerate-vector-illustration': [],
		'pixerate-paint-watercolour': [],
		'pixerate-paint-oil-impasto': [],
		'pixerate-paint-sketch-to-finish': [],
		'pixerate-video-social-cut': [],
		'pixerate-video-colour-grade': [],
		'pixerate-video-montage': [],
		'pixerate-chart-choose-and-build': [],
		'pixerate-chart-annotate': [],
		'pixerate-spreadsheet-analysis': [],
		'pixerate-spreadsheet-financial-model': [],
		'pixerate-diagram-process-flow': [],
		'pixerate-diagram-architecture': [],
		'pixerate-rich-text-report': [],
		'pixerate-rich-text-revise': [],
		'pixerate-animation-motion-graphics': [],
		'pixerate-animation-logo-reveal': [],
		'pixerate-generation-budgeted-batch': [],
		'pixerate-effect-look-development': [],
		'pixerate-accessibility-audit': [],
		'pixerate-brand-application': [],
		'pixerate-canvas-design-system-components': [],
		'pixerate-canvas-layout': [],
		'pixerate-generation': [
			...toolNames(createGenerationToolProvider({ models: [], generate: () => ({}), estimate: () => ({}) } as any)),
			...toolNames(createGenerationHistoryToolProvider({ store: createGenerationRecordStore({ storage: createMemoryStorage() }) }))
		],
		'pixerate-tokens': [
			...toolNames(createDocumentToolProvider(createTokensEditorDocument(new TokenStore()), { store: documentStore() })),
			...toolNames(createTokensStyleToolProvider(new TokenStore(), styles))
		],
		'pixerate-parameters': [
			...commandIds(createParameterCommands(stub)),
			// parameters.undo / parameters.redo are commands, so the document tools leave undo out.
			...toolNames(
				createDocumentToolProvider(createParametersEditorDocument(new ParametersController({ schema: { fields: [] } })), { history: false, store: documentStore() })
			)
		],
		'pixerate-effect-authoring': (() => {
			const authoringSession = createFakeEffectProvider().openAuthoring!({ effectId: 'fake.invert' }) as any;
			authoringSession.setSource = async () => ({ ok: true, issues: [] });
			const authoringProvider = createEffectAuthoringToolProvider({
				session: () => authoringSession,
				capture: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
			});
			return toolNames(authoringProvider);
		})(),
		'pixerate-color': [...toolNames(createColorToolProvider()), ...toolNames(createGradientToolProvider(new GradientController()))],
		'pixerate-typography': [...toolNames(createTypographyToolProvider()), ...toolNames(createFontPickerToolProvider(new FontPickerModel()))]
	};
	doc.destroy();
	return result;
}

/** Every tool provider and command factory in `src`, mapped to the skill that documents it. */
const FACTORIES: Record<string, string> = {
	createCommandToolProvider: 'pixerate-agent-tools',
	createHistoryCommands: 'pixerate-agent-tools',
	createPlaybackToolProvider: 'pixerate-agent-tools',
	createRichTextToolProvider: 'pixerate-rich-text',
	createEditorMcpToolProvider: 'pixerate-rich-text, pixerate-canvas',
	createFindReplaceCommands: 'pixerate-rich-text',
	createTableCommands: 'pixerate-rich-text',
	createFormatCommands: 'pixerate-rich-text',
	createSpreadsheetToolProvider: 'pixerate-spreadsheet',
	createSpreadsheetCommands: 'pixerate-spreadsheet',
	createCanvasComponentToolProvider: 'pixerate-canvas',
	createArrangeCommands: 'pixerate-canvas',
	createShapeCommands: 'pixerate-canvas',
	createDrawCommands: 'pixerate-canvas',
	createComponentCommands: 'pixerate-canvas',
	createCanvasAnimationCommands: 'pixerate-canvas',
	createVectorCommands: 'pixerate-vector',
	createVectorEffectsToolProvider: 'pixerate-vector',
	createVectorGenerationToolProvider: 'pixerate-vector',
	createChartToolProvider: 'pixerate-chart',
	createOfficeChartToolProvider: 'pixerate-chart',
	createChartCommands: 'pixerate-chart',
	createChartStyleToolProvider: 'pixerate-chart',
	createTokensStyleToolProvider: 'pixerate-tokens',
	createStyleToolProvider: 'pixerate-agent-tools',
	createDiagramToolProvider: 'pixerate-diagram',
	// The shared document tools (get / load / undo / redo / save / open), named per editor kind.
	createDocumentToolProvider:
		'pixerate-diagram, pixerate-chart, pixerate-animation-editor, pixerate-video-editor, pixerate-parameters, pixerate-vector, pixerate-spreadsheet, pixerate-rich-text, pixerate-tokens, pixerate-canvas, pixerate-image-editor, pixerate-paint-editor',
	createImageEditorToolProvider: 'pixerate-image-editor',
	createImageEffectsToolProvider: 'pixerate-image-editor',
	createImageSegmentationToolProvider: 'pixerate-image-editor',
	createPaintEditorToolProvider: 'pixerate-paint-editor',
	createPaintEffectsToolProvider: 'pixerate-paint-editor',
	createAnimationEditorToolProvider: 'pixerate-animation-editor',
	createAnimationEffectsToolProvider: 'pixerate-animation-editor',
	createVideoEditorToolProvider: 'pixerate-video-editor',
	createVideoEffectsToolProvider: 'pixerate-video-editor',
	createVideoDialogueToolProvider: 'pixerate-talking-head-edit',
	createVideoMusicToolProvider: 'pixerate-bgm-alignment',
	// The shared effect tools; each editor that hosts them documents them in its own skill.
	createEffectToolProvider: 'pixerate-video-editor, pixerate-image-editor, pixerate-animation-editor, pixerate-vector, pixerate-canvas, pixerate-paint-editor',
	createGenerationToolProvider: 'pixerate-generation',
	createGenerationHistoryToolProvider: 'pixerate-generation',
	createParameterCommands: 'pixerate-parameters',
	createColorToolProvider: 'pixerate-color',
	createGradientToolProvider: 'pixerate-color',
	createTypographyToolProvider: 'pixerate-typography',
	createFontPickerToolProvider: 'pixerate-typography',
	createEffectAuthoringToolProvider: 'pixerate-effect-authoring',
	// Generic `capture_view`; hosts document it in the skill for the surface they capture.
	createCaptureToolProvider: 'pixerate-canvas, pixerate-image-editor',
	createCanvasCaptureToolProvider: 'pixerate-canvas',
	createCanvasEffectsToolProvider: 'pixerate-canvas',
	createCanvasExplosionToolProvider: 'pixerate-canvas'
};

/**
 * Workflow skills: one job end to end, built on a reference skill's tools. Each declares
 * `metadata.kind: workflow` and `metadata.reference`, and lists the tools it uses under
 * `## Tools used` as bullets starting with backticked names, which must all exist in the
 * reference skill. Its evals (`evals/*.json`) run in `agent-skill-evals.test.ts`.
 */
const WORKFLOWS: Record<string, string> = {
	'pixerate-image-selection-masking': 'pixerate-image-editor',
	'pixerate-spreadsheet-clean-import': 'pixerate-spreadsheet',
	'pixerate-image-photo-correction': 'pixerate-image-editor',
	'pixerate-image-product-photo': 'pixerate-image-editor',
	'pixerate-image-portrait-retouch': 'pixerate-image-editor',
	'pixerate-vector-icon-set': 'pixerate-vector',
	'pixerate-vector-logo': 'pixerate-vector',
	'pixerate-vector-illustration': 'pixerate-vector',
	'pixerate-paint-watercolour': 'pixerate-paint-editor',
	'pixerate-paint-oil-impasto': 'pixerate-paint-editor',
	'pixerate-paint-sketch-to-finish': 'pixerate-paint-editor',
	'pixerate-video-social-cut': 'pixerate-video-editor',
	'pixerate-video-colour-grade': 'pixerate-video-editor',
	'pixerate-video-montage': 'pixerate-video-editor',
	'pixerate-chart-choose-and-build': 'pixerate-chart',
	'pixerate-chart-annotate': 'pixerate-chart',
	'pixerate-spreadsheet-analysis': 'pixerate-spreadsheet',
	'pixerate-spreadsheet-financial-model': 'pixerate-spreadsheet',
	'pixerate-diagram-process-flow': 'pixerate-diagram',
	'pixerate-diagram-architecture': 'pixerate-diagram',
	'pixerate-rich-text-report': 'pixerate-rich-text',
	'pixerate-rich-text-revise': 'pixerate-rich-text',
	'pixerate-animation-motion-graphics': 'pixerate-animation-editor',
	'pixerate-animation-logo-reveal': 'pixerate-animation-editor',
	'pixerate-generation-budgeted-batch': 'pixerate-generation',
	'pixerate-effect-look-development': 'pixerate-effect-authoring',
	'pixerate-accessibility-audit': 'pixerate-color',
	'pixerate-brand-application': 'pixerate-color',
	'pixerate-canvas-design-system-components': 'pixerate-canvas',
	'pixerate-canvas-layout': 'pixerate-canvas'
};

/** Workflow skills aim for this many body lines, and fail above `WORKFLOW_MAX_LINES`. */
const WORKFLOW_TARGET_LINES = 200;
const WORKFLOW_MAX_LINES = 250;

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
	);
}

interface Skill {
	dir: string;
	frontmatter: Record<string, string>;
	body: string;
	documented: string[];
}

function readSkill(dir: string): Skill {
	const text = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!match) throw new Error(`skills/${dir}/SKILL.md has no YAML frontmatter.`);
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
		if (kv) frontmatter[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
	}
	const documented = [...match[2].matchAll(/^\|\s*`([A-Za-z0-9_.-]+)`\s*\|/gm)].map((m) => m[1]);
	return { dir, frontmatter, body: match[2], documented };
}

describe('agent skills', () => {
	const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
	const expected = expectedBySkill();

	it('has a skill for every domain and no orphans', () => {
		expect(dirs.sort()).toEqual(Object.keys(expected).sort());
	});

	it('maps every tool provider and command factory in src to a skill', () => {
		const unmapped: string[] = [];
		for (const file of walk(join(ROOT, 'src'))) {
			for (const m of readFileSync(file, 'utf8').matchAll(/export function (create\w+(?:ToolProvider|Commands))\b/g)) {
				if (!FACTORIES[m[1]]) unmapped.push(`${m[1]} (${relative(ROOT, file)})`);
			}
		}
		expect(unmapped, 'Add each factory to FACTORIES and its tools to a SKILL.md').toEqual([]);
	});

	it('ships the skills in the npm package', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
		expect(pkg.files).toContain('skills');
	});

	describe.each(Object.entries(WORKFLOWS))('workflow %s', (name, reference) => {
		it('declares its kind and reference skill', () => {
			const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
			const front = /^---\n([\s\S]*?)\n---\n/.exec(text)![1];
			expect(front).toMatch(/^metadata:\n(?:\s+.*\n)*?\s+kind: workflow$/m);
			expect(front).toMatch(new RegExp(`^\\s+reference: ${reference}$`, 'm'));
			expect(expected[reference], `reference skill ${reference}`).toBeDefined();
		});

		it('uses only tools its reference skill documents', () => {
			const { body } = readSkill(name);
			const section = /^## Tools used\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
			expect(section, 'a ## Tools used section').not.toBeNull();
			const used = [...section![1].matchAll(/^- (.*?):/gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z][A-Za-z0-9_.]*)`/g)].map((n) => n[1]!));
			expect(used.length).toBeGreaterThan(0);
			const known = new Set(expected[reference]);
			expect(used.filter((n) => !known.has(n)), `tools not in ${reference}`).toEqual([]);
		});

		it('names only real tools and commands in its prose', () => {
			const { body } = readSkill(name);
			const known = new Set(Object.values(expected).flat());
			// Dotted names are commands only in a command namespace (`spreadsheet.unhideAll`, not `sheet.rows`).
			const namespaces = new Set([...known].filter((n) => n.includes('.')).map((n) => n.split('.')[0]));
			const named = [...body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+\.[a-z][A-Za-z]+)`/g)].map((m) => m[1]!).filter((n) => !n.includes('.') || namespaces.has(n.split('.')[0]!));
			expect([...new Set(named.filter((n) => !known.has(n)))], 'backticked names that are no tool or command').toEqual([]);
		});

		it('stays short and is listed by its reference skill', () => {
			const { body } = readSkill(name);
			const lines = body.split('\n').length;
			if (lines > WORKFLOW_TARGET_LINES) console.warn(`${name}: ${lines} body lines; workflow skills aim for ${WORKFLOW_TARGET_LINES}.`);
			expect(lines, 'workflow skill body lines').toBeLessThanOrEqual(WORKFLOW_MAX_LINES);
			expect(readSkill(reference).body, `${reference} names ${name} under ## Workflow skills`).toMatch(new RegExp(`^## Workflow skills\\n(?:(?!^## )[\\s\\S])*?\`${name}\``, 'm'));
		});

		it('ships evals', () => {
			const dir = join(SKILLS_DIR, name, 'evals');
			const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
			expect(files.length, `${name}/evals/*.json`).toBeGreaterThanOrEqual(3);
		});
	});

	it('lists every skill in skills/README.md', () => {
		const readme = readFileSync(join(SKILLS_DIR, 'README.md'), 'utf8');
		const reference = /^## Reference skills\n([\s\S]*?)^## /m.exec(readme)?.[1] ?? '';
		const workflow = /^## Workflow skills\n([\s\S]*?)^## /m.exec(readme)?.[1] ?? '';
		const row = (n: string) => `| [\`${n}\`](${n}/SKILL.md) |`;
		const missing = dirs.filter((n) => !(WORKFLOWS[n] ? workflow : reference + workflow).includes(row(n)));
		expect(missing, 'add a row to the right table in skills/README.md').toEqual([]);
	});

	describe.each(Object.keys(expected))('%s', (name) => {
		it('has valid Agent Skills frontmatter', () => {
			expect(existsSync(join(SKILLS_DIR, name, 'SKILL.md'))).toBe(true);
			const skill = readSkill(name);
			expect(skill.frontmatter.name).toBe(name);
			expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(name.length).toBeLessThanOrEqual(64);
			const description = skill.frontmatter.description ?? '';
			expect(description.length, 'description').toBeGreaterThan(80);
			expect(description.length, 'description').toBeLessThanOrEqual(1024);
			expect(description).not.toMatch(/[<>]/);
			// Progressive disclosure: keep SKILL.md short, move detail to references/.
			expect(skill.body.split('\n').length, 'SKILL.md body lines').toBeLessThanOrEqual(500);
		});

		it('names only skills that exist', () => {
			const named = [...readSkill(name).body.matchAll(/`(pixerate-[a-z0-9-]+)`/g)].map((m) => m[1]!);
			expect([...new Set(named.filter((n) => !dirs.includes(n)))]).toEqual([]);
		});

		it('documents exactly the tools and commands its providers expose', () => {
			const skill = readSkill(name);
			const want = new Set(expected[name]);
			const have = new Set(skill.documented);
			const missing = [...want].filter((n) => !have.has(n));
			const stale = [...have].filter((n) => !want.has(n));
			expect({ missing, stale }).toEqual({ missing: [], stale: [] });
			expect(skill.documented.length, 'a tool is listed twice').toBe(have.size);
		});
	});
});
