/**
 * `checkEffectProvider`: a conformance check any provider can run in its own tests, so editors
 * can rely on the contract (strict control schemas, valid defaults, typed errors, renderers that
 * return the size they were asked for).
 */

import { isEffectError } from './errors.js';
import { createEffectPixels, effectValueErrors, isCameraView, isEffectPixels } from './helpers.js';
import { CAMERA_MOVE_ROLES, EFFECT_KINDS, EFFECT_USES, type CameraView, type EffectDescription, type EffectPixels, type EffectProvider, type EffectSummary } from './types.js';

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
	if (e.kind === 'camera') {
		if (e.uses?.length !== 1 || e.uses[0] !== 'camera') at('a camera effect must have exactly the use "camera"');
		const m = e.camera;
		if (!m) at('a camera effect needs camera: { role, durationMs }');
		else {
			if (!CAMERA_MOVE_ROLES.includes(m.role)) at(`camera.role "${m.role}" is not one of ${CAMERA_MOVE_ROLES.join(', ')}`);
			if (!(Number.isFinite(m.durationMs) && m.durationMs >= 0)) at('camera.durationMs must be a number of ms ≥ 0');
			if (m.cut !== undefined && !(m.cut >= 0 && m.cut <= 1)) at('camera.cut must be 0–1 when present');
			if (e.duration !== undefined && e.duration !== m.durationMs) at(`duration ${e.duration} differs from camera.durationMs ${m.durationMs}`);
		}
	} else {
		if (e.uses?.includes('camera')) at('only camera effects may have the use "camera"');
		if (e.camera !== undefined) at('only camera effects may have camera');
	}
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
		// A vector effect may need the host's help to become pixels (a Worker has no DOM to lay out SVG); a camera move has none.
		if (!((d.kind === 'vector' || d.kind === 'camera') && codeOf(e) === 'unsupported')) at(`createRenderer failed: ${codeOf(e)}`);
		else if (!(e instanceof Error && e.message.trim())) at('createRenderer refused without saying why');
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

const sameView = (a: CameraView, b: CameraView) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: CameraView, b: CameraView) =>
	(['zoom', 'scrollX', 'scrollY', 'tilt', 'turn', 'roll', 'perspective', 'blur', 'blurAngle'] as const).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) <= 1e-6 * Math.max(1, Math.abs(a[k] ?? 0)));

/** A probe stage and two framings: the whole stage, then its top-left quarter at 2×. */
const STAGE = { width: 320, height: 180 };
const WIDE: CameraView = { zoom: 1, scrollX: 0, scrollY: 0 };
const CLOSE: CameraView = { zoom: 2, scrollX: 0, scrollY: 0 };

async function checkCamera(provider: EffectProvider, d: EffectDescription, issues: EffectConformanceIssue[]) {
	const at = (message: string) => issues.push({ effectId: d.id, message });
	const camera = d.camera!;
	const to = camera.role === 'hold' ? WIDE : CLOSE;
	const ms = camera.durationMs || 1000;
	const ctx = (u: number) => ({ from: WIDE, to, u, ms, stage: STAGE });
	const views: CameraView[] = [];
	for (const u of [0, 0.25, 0.5, 0.75, 1]) {
		try {
			const view = provider.cameraView!(d.id, ctx(u));
			if ((view as unknown) instanceof Promise) {
				at('cameraView must be synchronous; it returned a Promise');
				return;
			}
			if (!isCameraView(view)) at(`cameraView at u ${u} is not a CameraView (zoom > 0, finite scrollX and scrollY): ${JSON.stringify(view)}`);
			else views.push(view);
			const again = provider.cameraView!(d.id, ctx(u));
			if (isCameraView(view) && !sameView(view, again)) at(`cameraView is not pure: two calls at u ${u} gave different views`);
		} catch (e) {
			at(`cameraView at u ${u} failed: ${codeOf(e)}`);
		}
	}
	const bad = await rejectsWith('invalid_values', () => provider.cameraView!(d.id, ctx(0.5), { __not_a_control__: 1 }));
	if (bad) at(`cameraView with an unknown control ${bad}`);
	if (provider.sampleCameraMove && views.length === 5) {
		try {
			const sample = await provider.sampleCameraMove(d.id, { from: WIDE, to, ms, stage: STAGE, fps: 10 });
			const keys = sample?.keys;
			if (!Array.isArray(keys) || keys.length < 2) at('sampleCameraMove returned fewer than two keys');
			else {
				if (keys.some((k, i) => !isCameraView(k.view) || !Number.isFinite(k.t) || (i > 0 && k.t < keys[i - 1].t))) at('sampleCameraMove keys must be CameraViews in time order');
				if (keys[0].t !== 0 || keys[keys.length - 1].t !== ms) at(`sampleCameraMove keys must run from 0 to ${ms} ms, got ${keys[0].t} to ${keys[keys.length - 1].t}`);
				else if (!near(keys[0].view, views[0]) || !near(keys[keys.length - 1].view, views[4])) at('sampleCameraMove disagrees with cameraView at the start or end of the move');
				if (camera.cut !== undefined && sample.cut === undefined) at('sampleCameraMove gave no cut for a move that cuts');
			}
		} catch (e) {
			at(`sampleCameraMove failed: ${codeOf(e)}`);
		}
	}
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
	if (caps?.supportsCamera !== undefined && typeof caps.supportsCamera !== 'boolean') top('capabilities.supportsCamera is not a boolean');
	if (caps?.supportsCamera && typeof provider.cameraView !== 'function') top('supportsCamera is set but cameraView is missing');
	if (provider.sampleCameraMove && typeof provider.cameraView !== 'function') top('sampleCameraMove is present but cameraView is missing');

	const list = await provider.list();
	const ids = new Set<string>();
	for (const e of list) {
		if (ids.has(e.id)) top(`duplicate id "${e.id}"`);
		ids.add(e.id);
		checkSummary(e, issues);
	}
	if (!caps?.supportsCamera && list.some((e) => e.kind === 'camera')) top('the catalog lists camera effects but capabilities.supportsCamera is not set');
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
	if (caps?.supportsCamera && provider.cameraView) {
		const probe = { from: WIDE, to: CLOSE, u: 0.5, ms: 1000, stage: STAGE };
		const unknownCamera = await rejectsWith('unknown_effect', () => provider.cameraView!('__no_such_effect__', probe));
		if (unknownCamera) top(`cameraView of an unknown id ${unknownCamera}`);
		const notCamera = list.find((e) => e.kind !== 'camera');
		const wrongKind = notCamera && (await rejectsWith('unsupported', () => provider.cameraView!(notCamera.id, probe)));
		if (wrongKind) issues.push({ effectId: notCamera!.id, message: `cameraView of a ${notCamera!.kind} effect ${wrongKind}` });
	}

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
		if (d.kind === 'camera' && d.camera && caps.supportsCamera && provider.cameraView) await checkCamera(provider, d, issues);
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
			(d) => d.kind !== 'motion' && d.kind !== 'vector' && d.kind !== 'camera'
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
