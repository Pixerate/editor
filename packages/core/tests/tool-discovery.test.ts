import { describe, it, expect, vi } from 'vitest';
import {
	ToolRegistry,
	createMcpServer,
	toolsetInstructions,
	searchTools,
	listSkills,
	parseSkillFrontmatter,
	TOOL_DISCOVERY_TOOLS,
	type AgentTool,
	type AgentToolProvider
} from '../src/tools';
import { loadSkillFiles, defaultSkillsDir } from '../src/bridge';

const tool = (name: string, description: string, readOnly: boolean): AgentTool => ({
	name,
	title: name.replace(/_/g, ' '),
	description,
	annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
	inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'A value.' } }, additionalProperties: false },
	handler: (args, ctx) => ({ tool: ctx.name, value: args.value ?? null })
});

const chart = (): AgentToolProvider => ({
	id: 'chart',
	title: 'Chart editor',
	description: 'One chart: data, series and trendlines.',
	skill: 'pixerate-chart',
	tools: [
		tool('get_chart', 'Returns the chart spec and data.', true),
		tool('add_chart_trendline', 'Adds a trendline (linear, exponential, moving average) to a series.', false),
		tool('set_chart_values', 'Sets data values of a series.', false)
	]
});

const video = (): AgentToolProvider => ({
	id: 'video',
	title: 'Video editor',
	description: 'Tracks, clips and transitions.',
	skill: 'pixerate-video-editor',
	tools: [
		tool('get_video_project', 'Returns the tracks, clips and assets of the video project.', true),
		tool('add_video_clip', 'Adds a clip to a track at a time.', false),
		tool('find_video_silences', 'Finds silent ranges in the audio of a clip.', true)
	]
});

const SKILLS = {
	'pixerate-chart/SKILL.md': '---\nname: pixerate-chart\ndescription: How to edit charts.\n---\n\n# Charts\n\nUse `get_chart` first.\n',
	'pixerate-chart/references/presets.md': '# Presets\n',
	'pixerate-video-editor/SKILL.md': '---\nname: pixerate-video-editor\ndescription: "How to edit video."\n---\n\n# Video\n'
};

const setup = () => {
	const registry = new ToolRegistry();
	registry.register(chart());
	registry.register(video());
	return registry;
};

const names = (source: { listTools(): { tools: { name: string }[] } }) => source.listTools().tools.map((t) => t.name);
const data = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as any;
const text = (result: { content: any[] }) => result.content[0]?.text as string;

describe('registry.view() scoping', () => {
	it('shows and calls only the allowed toolsets, and follows setToolsets', async () => {
		const registry = setup();
		const view = registry.view({ toolsets: ['chart'] });
		expect(names(view)).toEqual(['chart__get_chart', 'chart__add_chart_trendline', 'chart__set_chart_values']);
		expect(view.toolsets().map((s) => s.name)).toEqual(['chart']);
		expect(data(await view.callTool('get_chart', { value: 'x' }))).toEqual({ tool: 'chart__get_chart', value: 'x' });

		const hidden = await view.callTool('video__add_video_clip');
		expect(hidden.isError).toBe(true);
		expect(text(hidden)).toBe('Tool "video__add_video_clip" is not available: its toolset "video" is not available to this agent.');
		expect(view.hasTool('video__add_video_clip')).toBe(false);

		const listener = vi.fn();
		const off = view.onListChanged(listener);
		view.setToolsets(['video']);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0].map((t: any) => t.name)).toEqual(['video__get_video_project', 'video__add_video_clip', 'video__find_video_silences']);
		view.setToolsets((set) => set.name === 'video');
		expect(listener).toHaveBeenCalledTimes(1); // same listing, no notification
		off();
	});

	it('read-only views list read tools and refuse writes with the reason', async () => {
		const view = setup().view({ readOnly: true });
		expect(names(view)).toEqual(['chart__get_chart', 'video__get_video_project', 'video__find_video_silences']);
		const refused = await view.callTool('chart__set_chart_values', { value: '1' });
		expect(refused.isError).toBe(true);
		expect(data(refused).error.code).toBe('unknown_tool');
		expect(text(refused)).toMatch(/not available: it changes content and this agent has read-only access/);
	});

	it('follows the registry: providers that mount or unmount change the view', async () => {
		vi.useFakeTimers();
		try {
			const registry = new ToolRegistry();
			registry.register(chart());
			const view = registry.view();
			const listener = vi.fn();
			view.onListChanged(listener);
			const off = registry.register(video());
			vi.runAllTimers();
			expect(listener).toHaveBeenCalledTimes(1);
			off();
			vi.runAllTimers();
			expect(listener).toHaveBeenCalledTimes(2);
			view.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('discovery views', () => {
	it('lists only the discovery tools until the agent enables more', async () => {
		const view = setup().view({ discovery: { skills: SKILLS } });
		expect(names(view)).toEqual([...TOOL_DISCOVERY_TOOLS]);
		for (const def of view.listTools().tools) {
			expect(def.title, def.name).toBeTruthy();
			expect(def.description, def.name).toBeTruthy();
			expect(Object.keys(def.annotations ?? {}).sort(), def.name).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
			expect(def.inputSchema.additionalProperties, def.name).toBe(false);
			for (const [key, prop] of Object.entries(def.inputSchema.properties ?? {})) expect((prop as any).description, `${def.name}.${key}`).toBeTruthy();
		}

		const listed = data(await view.callTool('list_toolsets'));
		expect(listed).toEqual({
			toolsets: [
				{ name: 'chart', title: 'Chart editor', description: 'One chart: data, series and trendlines.', skill: 'pixerate-chart', tools: 3, enabled: 'none' },
				{ name: 'video', title: 'Video editor', description: 'Tracks, clips and transitions.', skill: 'pixerate-video-editor', tools: 3, enabled: 'none' }
			],
			skills: ['pixerate-chart', 'pixerate-video-editor']
		});
	});

	it('searches, enables single tools and whole toolsets, and announces the change', async () => {
		const view = setup().view({ discovery: true });
		expect(names(view)).not.toContain('get_skill');
		const listener = vi.fn();
		view.onListChanged(listener);

		const found = data(await view.callTool('search_tools', { query: 'add a trendline to the chart' }));
		expect(found.results[0]).toMatchObject({ name: 'chart__add_chart_trendline', toolset: 'chart', readOnly: false, enabled: false });
		expect(found.results[0].summary).toBe('Adds a trendline (linear, exponential, moving average) to a series.');
		expect(found.next).toMatch(/enable_tools/);

		const silence = data(await view.callTool('search_tools', { query: 'silent audio', toolset: 'video', limit: 1 }));
		expect(silence.results.map((r: any) => r.name)).toEqual(['video__find_video_silences']);

		const added = data(await view.callTool('enable_tools', { tools: ['chart__add_chart_trendline'], toolsets: ['video'] }));
		expect(added).toEqual({
			added: ['chart__add_chart_trendline', 'video__get_video_project', 'video__add_video_clip', 'video__find_video_silences'],
			listed: 4
		});
		expect(listener).toHaveBeenCalledTimes(1);
		expect(names(view).slice(TOOL_DISCOVERY_TOOLS.length - 1)).toEqual([
			'chart__add_chart_trendline',
			'video__get_video_project',
			'video__add_video_clip',
			'video__find_video_silences'
		]);
		expect(data(await view.callTool('list_toolsets')).toolsets.map((s: any) => s.enabled)).toEqual(['some', 'all']);

		const removed = data(await view.callTool('disable_tools', { toolsets: ['video'] }));
		expect(removed).toEqual({ removed: ['video__get_video_project', 'video__add_video_clip', 'video__find_video_silences'], listed: 1 });

		// Allowed tools that are not listed can still be called by name.
		expect(data(await view.callTool('video__get_video_project', { value: 'v' }))).toEqual({ tool: 'video__get_video_project', value: 'v' });
	});

	it('fails usefully and changes nothing for bad selections', async () => {
		const view = setup().view({ discovery: { enabled: ['chart'] } });
		const before = names(view);
		const bad = await view.callTool('enable_tools', { tools: ['chart__get_chart', 'nope'], toolsets: ['sheet'] });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toBe(
			'Unknown tool "nope". List the tools again; the editor that had it may have closed or become read-only. Call search_tools to find the right tool. Unknown toolset "sheet". Nothing was changed. Call list_toolsets or search_tools for valid names.'
		);
		expect(names(view)).toEqual(before);
		expect(text(await view.callTool('enable_tools', {}))).toBe('Pass at least one name in `tools` or `toolsets`.');
		expect(data(await view.callTool('enable_tools', { tools: [1] })).error.code).toBe('invalid_arguments');
		expect(text(await view.callTool('search_tools', { query: 'x', toolset: 'sheet' }))).toBe('Unknown toolset "sheet". Call list_toolsets for the names.');
		expect(data(await view.callTool('search_tools', { query: 'zzzz' })).hint).toMatch(/No tool matched/);
		// Bare names are accepted where they are unique.
		expect(data(await view.callTool('enable_tools', { tools: ['find_video_silences'] })).added).toEqual(['video__find_video_silences']);
	});

	it('serves skills with a note on how names are prefixed here', async () => {
		const view = setup().view({ discovery: { skills: SKILLS } });
		const skill = await view.callTool('get_skill', { name: 'pixerate-chart' });
		expect(text(skill)).toBe(
			'> Tool names in this skill are bare. Here they are prefixed by toolset: `chart__` (e.g. `chart__get_chart`). A bare name also works when only one toolset has it.\n' +
				'> Reference files (call get_skill with `file`): references/presets.md.\n\n' +
				SKILLS['pixerate-chart/SKILL.md']
		);
		expect(data(skill)).toEqual({ name: 'pixerate-chart', file: 'SKILL.md', toolsets: ['chart'], references: ['references/presets.md'] });
		expect(text(await view.callTool('get_skill', { name: 'pixerate-chart', file: 'references/presets.md' }))).toMatch(/^> Tool names[^\n]*\n\n# Presets/);
		expect(text(await view.callTool('get_skill', { name: 'pixerate-chart', file: 'nope.md' }))).toBe(
			'Skill "pixerate-chart" has no file "nope.md". Its files: references/presets.md.'
		);
		expect(data(await view.callTool('get_skill', { name: 'pixerate-sheet' })).error.code).toBe('invalid_arguments');
	});

	it('a read-only discovery view only finds and enables read tools', async () => {
		const view = setup().view({ readOnly: true, discovery: true });
		const found = data(await view.callTool('search_tools', { query: 'trendline' }));
		expect(found.results.map((r: any) => r.name)).not.toContain('chart__add_chart_trendline');
		expect(text(await view.callTool('enable_tools', { tools: ['chart__add_chart_trendline'] }))).toMatch(/read-only access/);
	});
});

describe('searchTools', () => {
	it('ranks rare words above common ones and favours exact names', () => {
		const registry = setup();
		const { tools } = registry.listTools();
		const sets = registry.toolsets();
		expect(searchTools(tools, sets, 'trendline')[0].name).toBe('chart__add_chart_trendline');
		expect(searchTools(tools, sets, 'add_video_clip')[0].name).toBe('video__add_video_clip');
		expect(searchTools(tools, sets, 'clips')[0].toolset).toBe('video');
		expect(searchTools(tools, sets, 'the of and')).toEqual([]);
	});
});

describe('MCP server skills and instructions', () => {
	const rpc = (server: ReturnType<typeof createMcpServer>, method: string, params: Record<string, unknown> = {}) =>
		server.handle({ jsonrpc: '2.0', id: 1, method, params }) as Promise<any>;

	it('describes the toolsets and serves skills as resources and prompts', async () => {
		const view = setup().view({ discovery: true });
		const server = createMcpServer(view, { name: 't', version: '1', instructions: toolsetInstructions, skills: SKILLS });
		const init = (await rpc(server, 'initialize', { protocolVersion: '2025-06-18' })).result;
		expect(init.capabilities).toEqual({ tools: { listChanged: true }, resources: {}, prompts: {} });
		expect(init.instructions).toBe(
			[
				'Tools are grouped into toolsets, one per open editor or feature, and named `<toolset>__<tool>`. Only some are listed at first: call list_toolsets to see them all, search_tools to find a tool for a task, and enable_tools to add what you need.',
				'',
				'Toolsets:',
				'- chart - Chart editor: One chart: data, series and trendlines. (skill: pixerate-chart), 3 tools',
				'- video - Video editor: Tracks, clips and transitions. (skill: pixerate-video-editor), 3 tools',
				'',
				'Read the skill a toolset names before using it (an MCP resource or prompt when the server offers skills).'
			].join('\n')
		);
		expect((await rpc(server, 'tools/list')).result.tools.map((t: any) => t.name)).toEqual(['list_toolsets', 'search_tools', 'enable_tools', 'disable_tools']);

		const resources = (await rpc(server, 'resources/list')).result.resources;
		expect(resources).toEqual([
			{ uri: 'skill://pixerate-chart/SKILL.md', name: 'pixerate-chart', description: 'How to edit charts.', mimeType: 'text/markdown' },
			{ uri: 'skill://pixerate-chart/references/presets.md', name: 'pixerate-chart/references/presets.md', mimeType: 'text/markdown' },
			{ uri: 'skill://pixerate-video-editor/SKILL.md', name: 'pixerate-video-editor', description: 'How to edit video.', mimeType: 'text/markdown' }
		]);
		const read = (await rpc(server, 'resources/read', { uri: 'skill://pixerate-chart/references/presets.md' })).result;
		expect(read.contents).toEqual([{ uri: 'skill://pixerate-chart/references/presets.md', mimeType: 'text/markdown', text: '# Presets\n' }]);
		expect((await rpc(server, 'resources/read', { uri: 'skill://nope/SKILL.md' })).error.code).toBe(-32602);

		expect((await rpc(server, 'prompts/list')).result.prompts).toEqual([
			{ name: 'pixerate-chart', description: 'How to edit charts.' },
			{ name: 'pixerate-video-editor', description: 'How to edit video.' }
		]);
		const prompt = (await rpc(server, 'prompts/get', { name: 'pixerate-chart' })).result;
		expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: '# Charts\n\nUse `get_chart` first.' } }]);
		expect((await rpc(server, 'prompts/get', { name: 'nope' })).error.code).toBe(-32602);
	});

	it('has no resources or prompts without skills', async () => {
		const server = createMcpServer(setup(), { name: 't', version: '1', instructions: 'Hi.' });
		const init = (await rpc(server, 'initialize')).result;
		expect(init.capabilities).toEqual({ tools: { listChanged: true } });
		expect(init.instructions).toBe('Hi.');
		expect((await rpc(server, 'resources/list')).error.code).toBe(-32601);
		expect((await rpc(server, 'prompts/list')).error.code).toBe(-32601);
	});
});

describe('shipped skills', () => {
	it('loads every skill and reference file from the package', () => {
		expect(defaultSkillsDir()).toMatch(/packages[\\/]core[\\/]skills$/);
		const files = loadSkillFiles();
		const skills = listSkills(files);
		expect(skills.map((s) => s.name)).toContain('pixerate-agent-tools');
		expect(skills.find((s) => s.name === 'pixerate-vector')?.references).toEqual(['references/commands.md', 'references/pitfalls.md']);
		for (const skill of skills) {
			expect(skill.description.length, skill.name).toBeGreaterThan(20);
			expect(parseSkillFrontmatter(files[`${skill.name}/SKILL.md`]).name).toBe(skill.name);
		}
		expect(Object.keys(files)).not.toContain('README.md');
	});
});
