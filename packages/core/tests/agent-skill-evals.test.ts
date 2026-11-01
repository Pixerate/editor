/**
 * Runs the evals that workflow skills ship in `skills/<name>/evals/*.json`.
 *
 * An eval is a task a model would be given (`prompt`), the document it starts from
 * (`fixture`), the checks that decide whether the job was done (`checks`: a read tool, its
 * arguments and what its result must match) and one known-good answer (`solution`: the tool
 * calls an expert would make). Here, without a model, each eval proves itself: at least one
 * check fails on the fixture, and every check passes after the solution. A model harness runs
 * the same files with the model in place of `solution`. The format is described in
 * `skills/README.md`.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry, baseToolName, createSpreadsheetToolProvider, createRichTextToolProvider } from '../src/agent';
import {
	callEvalTool,
	failedEvalChecks,
	imageEvalFixturePixels,
	listSkillEvals,
	matchesEvalExpectation as matches,
	type ImageEvalFixture as ImageFixture,
	type PaintEvalFixture as PaintFixture,
	type SkillEval,
	type SkillEvalCheck as Check,
	type SpreadsheetEvalFixture as SpreadsheetFixture,
	type VectorEvalFixture as VectorFixture,
	type VideoEvalFixture as VideoFixture,
	type ChartEvalFixture as ChartFixture,
	type DiagramEvalFixture as DiagramFixture,
	type RichTextEvalFixture as RichTextFixture,
	type AnimationEvalFixture as AnimationFixture
} from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { VectorEditorController, createVectorCommands } from '../src/vector';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { VideoEditorController, createVideoEditorToolProvider } from '../src/video-editor';
import { ChartController, createChartToolProvider } from '../src/chart';
import { DiagramController, createDiagramToolProvider } from '../src/diagram';
import { AnimationEditorController, createAnimationEditorToolProvider } from '../src/animation-editor';
import { SpreadsheetController, createRichTextPreset } from '../src';

const SKILLS_DIR = join(__dirname, '..', 'skills');

// The rich text editor needs a DOM.
const dom = new JSDOM();
globalThis.document = dom.window.document as any;
globalThis.window = dom.window as any;
(globalThis as any).Node = dom.window.Node;

function spreadsheet(f: SpreadsheetFixture): ToolRegistry {
	const columns = Math.max(...f.rows.map((r) => r.length));
	const sheet = new SpreadsheetController({
		document: {
			columns: Array.from({ length: columns }, (_, i) => ({ id: `c${i}`, key: String.fromCharCode(65 + i), title: String.fromCharCode(65 + i), type: 'freeform' as const })),
			rows: f.rows.map((_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
		}
	});
	f.rows.forEach((row, r) => row.forEach((v, c) => v !== null && v !== '' && sheet.setCellValue(`r${r}`, `c${c}`, String(v))));
	const registry = new ToolRegistry();
	registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
	return registry;
}

function image(f: ImageFixture): ToolRegistry {
	const { width: W, height: H } = f;
	const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
	const c = new ImageEditorController({ image: fake });
	c.setSamplePixels(imageEvalFixturePixels(f));
	const registry = new ToolRegistry();
	registry.register(createImageEditorToolProvider(c));
	return registry;
}

async function vector(f: VectorFixture): Promise<ToolRegistry> {
	const c = new VectorEditorController({ document: { width: f.width, height: f.height, nodes: [] } });
	const commands = new CommandRegistry();
	for (const spec of createVectorCommands(c)) commands.register(spec);
	const registry = new ToolRegistry();
	registry.register(createCommandToolProvider(commands));
	if (f.setup?.length) {
		const res = await registry.callTool('run_commands', { steps: f.setup });
		if (res.isError) throw new Error(`fixture setup: ${(res.content?.[0] as { text?: string })?.text}`);
	}
	c.clearSelection();
	return registry;
}

async function paint(f: PaintFixture): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(createPaintEditorToolProvider(new PaintEditorController({ width: f.width, height: f.height })));
	for (const step of f.setup ?? []) await call(registry, step);
	return registry;
}

async function video(f: VideoFixture): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(createVideoEditorToolProvider(new VideoEditorController()));
	for (const step of f.setup ?? []) await call(registry, step);
	return registry;
}

async function chart(f: ChartFixture): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(createChartToolProvider(new ChartController(), { id: 'chart' }));
	for (const step of f.setup ?? []) await call(registry, step);
	return registry;
}

async function diagram(f: DiagramFixture): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(createDiagramToolProvider(new DiagramController(), { id: 'diagram', renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) }));
	for (const step of f.setup ?? []) await call(registry, step);
	return registry;
}

function richText(f: RichTextFixture): ToolRegistry {
	const doc = new Editor({ extensions: createRichTextPreset({ chart: true }), content: f.html });
	const registry = new ToolRegistry();
	registry.register(createRichTextToolProvider(doc, { id: 'doc' }));
	return registry;
}

async function animation(f: AnimationFixture): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(createAnimationEditorToolProvider(new AnimationEditorController(), { id: 'animation' }));
	for (const step of f.setup ?? []) await call(registry, step);
	return registry;
}

const FIXTURES = { spreadsheet, image, vector, paint, video, chart, diagram, 'rich-text': richText, animation } as const;
const build = async (fixture: SkillEval['fixture']): Promise<ToolRegistry> => FIXTURES[fixture.editor](fixture as never);

/** Read-only tools, and `run_command` with a read-only command (`vector.list`), may check. */
async function readOnlyCheck(registry: ToolRegistry, check: Check): Promise<boolean> {
	const tool = registry.listTools().tools.find((t) => baseToolName(t.name) === check.tool);
	if (tool?.annotations?.readOnlyHint) return true;
	if (check.tool !== 'run_command') return false;
	const listed = (await registry.callTool('list_commands', {})).structuredContent as { commands: Array<{ id: string; readOnly?: boolean }> };
	return !!listed.commands.find((c) => c.id === check.args?.id)?.readOnly;
}

const caller = (registry: ToolRegistry) => (tool: string, args: Record<string, unknown>) => registry.callTool(tool, args);
const call = (registry: ToolRegistry, step: { tool: string; args?: Record<string, unknown> }) => callEvalTool(caller(registry), step);
const failedChecks = (registry: ToolRegistry, checks: Check[]) => failedEvalChecks(caller(registry), checks);

const evalFiles: Record<string, string> = {};
for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
	if (!e.isDirectory() || !existsSync(join(SKILLS_DIR, e.name, 'evals'))) continue;
	for (const f of readdirSync(join(SKILLS_DIR, e.name, 'evals'))) {
		evalFiles[`${e.name}/evals/${f}`] = readFileSync(join(SKILLS_DIR, e.name, 'evals', f), 'utf8');
	}
}
const evals = listSkillEvals(evalFiles).map((e) => [e.path, e.eval] as const);

describe('matches', () => {
	it('matches objects, arrays and operators', () => {
		expect(matches({ a: 1, b: 2 }, { a: 1 })).toBe(true);
		expect(matches([1, 2], [1])).toBe(false);
		expect(matches(5, { $min: 1, $max: 5 })).toBe(true);
		expect(matches([[1, 'a'], [2, 'b'], [null, '']], { $nonEmpty: { $length: 2, $column: [0, { $sum: 3 }] } })).toBe(true);
		expect(matches(['x', 'X'], { $distinct: { $length: 2 } })).toBe(true);
		expect(matches(undefined, { $expr: 'v[0] > 1' }), 'an expression that throws does not match').toBe(false);
		expect(matches(['a', 'a'], { $unique: true })).toBe(false);
		expect(matches({ width: 4, height: 4 }, { $expr: 'v.width === v.height' })).toBe(true);
		expect(() => matches(1, { $near: 1 })).toThrow(/Unknown eval operator/);
	});
});

describe.each(evals)('%s', (_, ev) => {
	it('is well formed', async () => {
		expect(ev.prompt.length).toBeGreaterThan(20);
		expect(Object.keys(FIXTURES)).toContain(ev.fixture.editor);
		expect(ev.checks.length).toBeGreaterThan(0);
		for (const c of ev.checks) expect(c.why, 'every check says what it is for').toBeTruthy();
		const registry = await build(ev.fixture);
		const tools = new Set(registry.listTools().tools.map((t) => baseToolName(t.name)));
		expect(ev.solution.map((s) => s.tool).filter((t) => !tools.has(t)), 'solution tools exist').toEqual([]);
		const writes: string[] = [];
		for (const c of ev.checks) if (!(await readOnlyCheck(registry, c))) writes.push(`${c.tool} ${JSON.stringify(c.args ?? {})}`);
		expect(writes, 'checks use read-only tools and commands').toEqual([]);
	});

	it('fails on the fixture and passes after the solution', async () => {
		const registry = await build(ev.fixture);
		expect((await failedChecks(registry, ev.checks)).length, 'some check fails before the job is done').toBeGreaterThan(0);
		for (const step of ev.solution) await call(registry, step);
		expect(await failedChecks(registry, ev.checks)).toEqual([]);
		// Wet paint and compositing run real simulations, slower on CI runners.
	}, 30_000);
});
