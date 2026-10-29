/**
 * `checkEffectProvider`: a conformance check any provider can run in its own tests, so editors
 * can rely on the contract (strict control schemas, valid defaults, typed errors, renderers that
 * return the size they were asked for).
 */

import { isEffectError } from './errors.js';
import { createEffectPixels, effectValueErrors, isEffectPixels } from './helpers.js';
import { EFFECT_KINDS, EFFECT_USES, type EffectDescription, type EffectPixels, type EffectProvider, type EffectSummary } from './types.js';

export interface EffectConformanceIssue {
	effectId?: string;
	message: string;
}

export interface EffectConformanceOptions {
	/** Effects to check in depth (default: every listed effect). */
	ids?: readonly string[];
	/** Also create renderers and render one small frame of each pixel effect (default true). */
	render?: boolean;
	/** Renderer size for the render check (default 8). */
	size?: number;
	/** Also check authoring when supportsAuthoring is true (default true). */
	authoring?: boolean;
}

const codeOf = (e: unknown) => (isEffectError(e) ? e.code : e instanceof Error ? `untyped ${e.name}: ${e.message}` : String(e));

async function rejectsWith(code: string, run: () => unknown): Promise<string | null> {
	try {
		await run();
		return `did not fail (expected ${code})`;
	} catch (e) {
		const got = codeOf(e);
		return got === code ? null : `failed with ${got} (expected ${code})`;
	}
}

function checkSummary(e: EffectSummary, issues: EffectConformanceIssue[]) {
	const at = (message: string) => issues.push({ effectId: e.id, message });
	if (!e.id || typeof e.id !== 'string') at('summary has no id');
	if (!e.name) at('summary has no name');
	if (!EFFECT_KINDS.includes(e.kind)) at(`kind "${e.kind}" is not one of ${EFFECT_KINDS.join(', ')}`);
	if (!e.category) at('summary has no category');
	if (!Array.isArray(e.uses) || !e.uses.length) at('summary has no uses');
	for (const u of e.uses ?? []) if (!EFFECT_USES.includes(u)) at(`use "${u}" is not one of ${EFFECT_USES.join(', ')}`);
	if (typeof e.transparent !== 'boolean') at('transparent is not a boolean');
	if (typeof e.loop !== 'boolean') at('loop is not a boolean');
	if (e.duration !== undefined && !(e.duration > 0)) at('duration must be a positive number of ms when present');
	if (e.backgroundOpacity !== undefined && (typeof e.backgroundOpacity !== 'string' || !e.backgroundOpacity)) at('backgroundOpacity must name a control when present');
}

function checkDescription(id: string, d: EffectDescription, issues: EffectConformanceIssue[]) {
	const at = (message: string) => issues.push({ effectId: id, message });
	if (d.id !== id) at(`describe("${id}") returned id "${d.id}"`);
	const c = d.controls;
	if (!c || c.type !== 'object') at('controls is not an object schema');
	if (c?.additionalProperties !== false) at('controls must set additionalProperties: false');
	for (const [name, schema] of Object.entries(c?.properties ?? {})) {
		if (!schema.description || !String(schema.description).trim()) at(`control "${name}" has no description`);
		if (!(name in (d.defaults ?? {}))) at(`control "${name}" has no default`);
	}
	for (const name of Object.keys(d.defaults ?? {})) if (!(name in (c?.properties ?? {}))) at(`default "${name}" is not a control`);
	if (d.backgroundOpacity !== undefined) {
		const control = c?.properties?.[d.backgroundOpacity];
		if (!control) at(`backgroundOpacity "${d.backgroundOpacity}" is not a control`);
		else if (control.type !== 'number' || control.minimum !== 0 || control.maximum !== 1) at(`backgroundOpacity "${d.backgroundOpacity}" must be a number control from 0 to 1`);
	}
	for (const e of effectValueErrors(d, d.defaults)) at(`default ${e.path}: ${e.message}`);
	for (const p of d.presets ?? []) for (const e of effectValueErrors(d, p.values)) at(`preset "${p.name}" ${e.path}: ${e.message}`);
	for (const input of d.inputs ?? []) {
		if (!input.name || !input.description) at('every input needs a name and a description');
		if (input.kind !== 'image' && input.kind !== 'audio') at(`input "${input.name}" has kind "${input.kind}"`);
	}
	if (d.uses.includes('filter') && !d.inputs.some((i) => i.name === 'source')) at('a filter must read an input named "source"');
	if (d.uses.includes('transition') && !(d.inputs.some((i) => i.name === 'from') && d.inputs.some((i) => i.name === 'to'))) {
		at('a transition must read inputs named "from" and "to"');
	}
}

function grey(size: number): EffectPixels {
	const p = createEffectPixels(size, size);
	p.data.fill(128);
	return p;
}

async function checkRender(provider: EffectProvider, d: EffectDescription, size: number, issues: EffectConformanceIssue[]) {
	const at = (message: string) => issues.push({ effectId: d.id, message });
	const inputs = Object.fromEntries(d.inputs.filter((i) => i.kind === 'image').map((i) => [i.name, grey(size)]));
	let renderer;
	try {
		renderer = await provider.createRenderer(d.id, { width: size, height: size });
	} catch (e) {
		// A vector effect may need the host's help to become pixels (a Worker has no DOM to lay out SVG).
		if (!(d.kind === 'vector' && codeOf(e) === 'unsupported')) at(`createRenderer failed: ${codeOf(e)}`);
		return;
	}
	try {
		const out = await renderer.render({ time: 0, inputs });
		if (!isEffectPixels(out)) at('render did not return EffectPixels');
		else if (out.width !== size || out.height !== size || out.data.length !== size * size * 4) at(`render returned ${out.width}×${out.height}, not ${size}×${size}`);
	} catch (e) {
		at(`render failed: ${codeOf(e)}`);
	}
	const bad = await rejectsWith('invalid_values', () => renderer.render({ time: 0, inputs, values: { __not_a_control__: 1 } }));
	if (bad) at(`render with an unknown control ${bad}`);
	renderer.dispose();
	const after = await rejectsWith('disposed', () => renderer.render({ time: 0, inputs }));
	if (after) at(`render after dispose ${after}`);
}

/** Runs the contract checks against `provider` and returns every issue found (empty when it conforms). */
export async function checkEffectProvider(provider: EffectProvider, options: EffectConformanceOptions = {}): Promise<EffectConformanceIssue[]> {
	const issues: EffectConformanceIssue[] = [];
	const top = (message: string) => issues.push({ message });
	if (!provider.id) top('provider has no id');
	const caps = provider.capabilities;
	for (const k of ['supportsWorker', 'supportsFloat', 'supportsMask', 'supportsHostImages', 'supportsVector'] as const) {
		if (typeof caps?.[k] !== 'boolean') top(`capabilities.${k} is not a boolean`);
	}
	if (caps?.supportsAuthoring !== undefined && typeof caps.supportsAuthoring !== 'boolean') top('capabilities.supportsAuthoring is not a boolean');
	if (caps?.supportsVector && typeof provider.applyVectorEffect !== 'function') top('supportsVector is set but applyVectorEffect is missing');
	if (caps?.supportsAuthoring && typeof provider.openAuthoring !== 'function') top('supportsAuthoring is set but openAuthoring is missing');

	const list = await provider.list();
	const ids = new Set<string>();
	for (const e of list) {
		if (ids.has(e.id)) top(`duplicate id "${e.id}"`);
		ids.add(e.id);
		checkSummary(e, issues);
	}
	const all = await provider.search('');
	if (all.length !== list.length) top(`search("") returned ${all.length} effects, list() ${list.length}`);
	const firstUse = list[0]?.uses[0];
	if (firstUse) {
		const filtered = await provider.search('', { use: firstUse });
		if (filtered.some((e) => !e.uses.includes(firstUse))) top(`search("", { use: "${firstUse}" }) returned effects without that use`);
	}
	const unknown = await rejectsWith('unknown_effect', () => provider.describe('__no_such_effect__'));
	if (unknown) top(`describe of an unknown id ${unknown}`);
	const unknownRenderer = await rejectsWith('unknown_effect', () => provider.createRenderer('__no_such_effect__', { width: 4, height: 4 }));
	if (unknownRenderer) top(`createRenderer of an unknown id ${unknownRenderer}`);

	const size = options.size ?? 8;
	for (const id of options.ids ?? [...ids]) {
		let d: EffectDescription;
		try {
			d = await provider.describe(id);
		} catch (e) {
			issues.push({ effectId: id, message: `describe failed: ${codeOf(e)}` });
			continue;
		}
		checkDescription(id, d, issues);
		if (options.render !== false && d.kind !== 'motion') await checkRender(provider, d, size, issues);
		if ((d.kind === 'vector' || d.kind === 'motion') && caps.supportsVector && provider.applyVectorEffect) {
			try {
				const m = await provider.applyVectorEffect(id, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect id="r" width="10" height="10"/></svg>');
				if (typeof m.svg !== 'string' || !m.svg.includes('<svg')) issues.push({ effectId: id, message: 'applyVectorEffect returned no SVG' });
				if (!(m.duration >= 0)) issues.push({ effectId: id, message: 'applyVectorEffect returned no duration' });
			} catch (e) {
				// The probe target is a bare <rect>; an effect that needs more (a path to follow, a fill colour) may refuse it.
				if (codeOf(e) !== 'unsupported') issues.push({ effectId: id, message: `applyVectorEffect failed: ${codeOf(e)}` });
			}
			const bad = await rejectsWith('invalid_values', () => provider.applyVectorEffect!(id, '<svg xmlns="http://www.w3.org/2000/svg"/>', { __not_a_control__: 1 }));
			if (bad) issues.push({ effectId: id, message: `applyVectorEffect with an unknown control ${bad}` });
		}
	}

	if (caps?.supportsAuthoring && options.authoring !== false && typeof provider.openAuthoring === 'function') {
		const targetEffect = (await Promise.all((options.ids ?? [...ids]).map((id) => provider.describe(id)))).find(
			(d) => d.kind !== 'motion' && d.kind !== 'vector'
		);
		if (targetEffect) {
			try {
				const session = await provider.openAuthoring({ effectId: targetEffect.id });
				const s1 = session.getState();
				const s2 = session.getState();
				if (s1 !== s2) {
					issues.push({ effectId: targetEffect.id, message: 'session.getState() returned different objects without changes' });
				}
				checkDescription(targetEffect.id, s1.description, issues);

				const badRes = session.setValue('__no_such_control__', 123);
				if (badRes.ok) {
					issues.push({ effectId: targetEffect.id, message: 'setValue with unknown control did not fail' });
				} else if (session.getState() !== s1) {
					issues.push({ effectId: targetEffect.id, message: 'setValue with unknown control changed state' });
				}

				// Check valid setValue and undo
				const firstKey = Object.keys(targetEffect.defaults)[0];
				if (firstKey) {
					const val = targetEffect.defaults[firstKey];
					session.setValue(firstKey, val);
					if (!session.getState().canUndo) {
						issues.push({ effectId: targetEffect.id, message: 'setValue did not enable canUndo' });
					}
					const undone = session.undo();
					if (!undone) {
						issues.push({ effectId: targetEffect.id, message: 'undo() returned false' });
					}
				}

				// exportDocument survives roundtrip
				const doc = session.exportDocument();
				const cloned = JSON.parse(JSON.stringify(doc));
				const restored = await provider.openAuthoring({ document: cloned });
				if (JSON.stringify(restored.getState().values) !== JSON.stringify(session.getState().values)) {
					issues.push({ effectId: targetEffect.id, message: 'reopening exported document gave different values' });
				}
				restored.dispose();

				if (s1.sourceLanguage !== null && typeof session.setSource !== 'function') {
					issues.push({ effectId: targetEffect.id, message: 'sourceLanguage is not null but setSource is missing' });
				}

				try {
					session.dispose();
				} catch (e) {
					issues.push({ effectId: targetEffect.id, message: `session.dispose() threw: ${codeOf(e)}` });
				}
			} catch (e) {
				issues.push({ effectId: targetEffect.id, message: `authoring check failed: ${codeOf(e)}` });
			}
		}
	}

	return issues;
}
