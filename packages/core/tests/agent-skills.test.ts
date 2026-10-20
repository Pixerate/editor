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
import {
	ToolRegistry,
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
import { ImageEditorController, createImageEditorToolProvider, createImageEffectsToolProvider } from '../src/image-editor';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { createGenerationToolProvider, createGenerationHistoryToolProvider, createGenerationRecordStore } from '../src/generation';
import { createMemoryStorage } from '../src/persistence';
import { ChartController, createChartToolProvider, createOfficeChartToolProvider, createChartCommands } from '../src/chart';
import { DiagramController, createDiagramToolProvider } from '../src/diagram';
import { createCanvasCaptureToolProvider } from '../src/canvas';
import { AnimationEditorController, createAnimationEditorToolProvider, createAnimationEffectsToolProvider } from '../src/animation-editor';
import { VideoEditorController, createVideoEditorToolProvider, createVideoEffectsToolProvider } from '../src/video-editor';
import { VectorEditorController, createVectorEffectsToolProvider, createVectorCommands } from '../src/vector';
import { createParameterCommands } from '../src/parameters';
import { createRichTextPreset, SpreadsheetController, createFindReplaceCommands, createTableCommands } from '../src';

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
	return registry.listTools().tools.map((t) => t.name).filter(filter);
};
const commandIds = (specs: CommandSpec[]) => specs.map((s) => s.id);

/**
 * Which tools and command ids each skill documents. Add a new provider or command set to the
 * skill for its domain (or a new skill), and list its factory in `FACTORIES` below.
 */
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
	const result: Record<string, string[]> = {
		'pixerate-agent-tools': [
			...toolNames(createCommandToolProvider(new CommandRegistry())),
			// Served by the MCP bridge (`createToolBridge`), which needs a socket server to list.
			'list_editors',
			...commandIds(createHistoryCommands(stub))
		],
		'pixerate-rich-text': [
			...toolNames(createRichTextToolProvider(doc, { id: 'doc' })),
			...toolNames(editorMcp, (n) => n.startsWith('prompt_') || shared.includes(n)),
			...commandIds(createFindReplaceCommands(doc)),
			...commandIds(createTableCommands(doc))
		],
		'pixerate-spreadsheet': [
			...toolNames(createSpreadsheetToolProvider(sheet, { id: 'sheet' })),
			...commandIds(createSpreadsheetCommands(stub))
		],
		'pixerate-canvas': [
			...toolNames(editorMcp, (n) => n.startsWith('canvas_') || shared.includes(n)),
			...toolNames(createCanvasComponentToolProvider({ addVariant: () => {}, removeVariant: () => {} } as any)),
			...toolNames(createCanvasCaptureToolProvider({ element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => [] })),
			...commandIds(createArrangeCommands(stub)),
			...commandIds(createShapeCommands(stub)),
			...commandIds(createDrawCommands(stub)),
			...commandIds(createComponentCommands(stub)),
			...commandIds(createCanvasAnimationCommands(stub))
		],
		'pixerate-vector': [...commandIds(createVectorCommands(new VectorEditorController())), ...toolNames(createVectorEffectsToolProvider(new VectorEditorController(), { id: 'vector-effects' }))],
		'pixerate-chart': [
			...toolNames(createChartToolProvider(new ChartController(), { id: 'chart' })),
			...toolNames(createOfficeChartToolProvider({ id: 'office', files: () => [], controller: new ChartController() })),
			...commandIds(createChartCommands(new ChartController()))
		],
		'pixerate-diagram': toolNames(
			createDiagramToolProvider(new DiagramController(), { id: 'diagram', renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) })
		),
		'pixerate-image-editor': [
			...toolNames(createImageEditorToolProvider(new ImageEditorController(), { id: 'img' })),
			...toolNames(createImageEffectsToolProvider(new ImageEditorController(), { id: 'img-effects' }))
		],
		'pixerate-paint-editor': toolNames(createPaintEditorToolProvider(new PaintEditorController({ width: 64, height: 64 }), { id: 'paint' })),
		'pixerate-animation-editor': [
			...toolNames(createAnimationEditorToolProvider(new AnimationEditorController(), { id: 'animation' })),
			...toolNames(createAnimationEffectsToolProvider(new AnimationEditorController(), { id: 'animation-effects' }))
		],
		'pixerate-video-editor': [
			...toolNames(createVideoEditorToolProvider(new VideoEditorController(), { id: 'video' })),
			...toolNames(createVideoEffectsToolProvider(new VideoEditorController(), { id: 'video-effects' }))
		],
		'pixerate-generation': [
			...toolNames(createGenerationToolProvider({ models: [], generate: () => ({}), estimate: () => ({}) } as any)),
			...toolNames(createGenerationHistoryToolProvider({ store: createGenerationRecordStore({ storage: createMemoryStorage() }) }))
		],
		'pixerate-parameters': commandIds(createParameterCommands(stub))
	};
	doc.destroy();
	return result;
}

/** Every tool provider and command factory in `src`, mapped to the skill that documents it. */
const FACTORIES: Record<string, string> = {
	createCommandToolProvider: 'pixerate-agent-tools',
	createHistoryCommands: 'pixerate-agent-tools',
	createRichTextToolProvider: 'pixerate-rich-text',
	createEditorMcpToolProvider: 'pixerate-rich-text, pixerate-canvas',
	createFindReplaceCommands: 'pixerate-rich-text',
	createTableCommands: 'pixerate-rich-text',
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
	createChartToolProvider: 'pixerate-chart',
	createOfficeChartToolProvider: 'pixerate-chart',
	createChartCommands: 'pixerate-chart',
	createDiagramToolProvider: 'pixerate-diagram',
	createImageEditorToolProvider: 'pixerate-image-editor',
	createImageEffectsToolProvider: 'pixerate-image-editor',
	createPaintEditorToolProvider: 'pixerate-paint-editor',
	createAnimationEditorToolProvider: 'pixerate-animation-editor',
	createAnimationEffectsToolProvider: 'pixerate-animation-editor',
	createVideoEditorToolProvider: 'pixerate-video-editor',
	createVideoEffectsToolProvider: 'pixerate-video-editor',
	// The shared effect tools; each editor that hosts them documents them in its own skill.
	createEffectToolProvider: 'pixerate-video-editor, pixerate-image-editor, pixerate-animation-editor, pixerate-vector',
	createGenerationToolProvider: 'pixerate-generation',
	createGenerationHistoryToolProvider: 'pixerate-generation',
	createParameterCommands: 'pixerate-parameters',
	// Generic `capture_view`; hosts document it in the skill for the surface they capture.
	createCaptureToolProvider: 'pixerate-canvas, pixerate-image-editor',
	createCanvasCaptureToolProvider: 'pixerate-canvas'
};

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
