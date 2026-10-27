import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import { applyVideoEdits, createVideoEditorToolProvider, createVideoProject, describeVideoEditPlan, diffVideoProjects, planVideoEdits, VideoEditorController, type VideoEdit, type VideoProject } from '../src/video-editor';

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};
const project = () =>
	ok(createVideoProject({ width: 320, height: 180, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'a', kind: 'video', src: 'a.mp4', duration: 10000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c1', asset: 'a', start: 0, duration: 4000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c2', asset: 'a', in: 5000, start: 4000, duration: 3000 } }
	]);

describe('planVideoEdits', () => {
	it('works a plan out on a copy and summarises it, changing nothing', () => {
		const p = project();
		const r = planVideoEdits(p, { id: 'p1', title: 'Tighten', edits: [{ op: 'extract_range', from: 1000, to: 2000 }], ranges: [{ from: 1000, to: 2000, reason: 'pause' }] });
		if (!r.ok) throw new Error(r.error);
		expect(r.plan.summary).toEqual({ durationBefore: 7000, durationAfter: 6000, durationDelta: -1000, clipsAdded: ['c1-1'], clipsRemoved: [], clipsChanged: ['c1', 'c2'], newIssues: [], edits: 1 });
		expect(describeVideoEditPlan(r.plan)).toBe('Tighten (1 stretch, 1.0 s shorter): clips 1 added, 2 changed');
		expect(videoProjectLength(p)).toBe(7000);
		expect(planVideoEdits(p, { title: ' ', edits: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a title/) });
		expect(planVideoEdits(p, { title: 'x', edits: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/no edits/) });
		expect(planVideoEdits(p, { title: 'x', edits: [{ op: 'trim_clip', clip: 'zz', edge: 'end', to: 10 }] })).toMatchObject({ ok: false, error: expect.stringMatching(/zz/) });
	});

	it('diffs projects by clip id', () => {
		const a = project();
		const b = ok(a, { op: 'delete_clips', clips: ['c2'] });
		expect(diffVideoProjects(a, b)).toEqual({ durationBefore: 7000, durationAfter: 4000, durationDelta: -3000, clipsAdded: [], clipsRemoved: ['c2'], clipsChanged: [] });
	});
});

const videoProjectLength = (p: VideoProject) => Math.max(...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)), 0);

describe('controller plans', () => {
	it('proposes, applies as one undo step and closes the plan', () => {
		const c = new VideoEditorController({ clock: new ManualClock(), project: project() });
		const r = c.proposePlan({ title: 'Cut the middle', edits: [{ op: 'extract_range', from: 1000, to: 2000 }] });
		if (!r.ok) throw new Error(r.error);
		expect(r.plan.id).toBe('plan1');
		expect(c.getState().plans.map((p) => p.id)).toEqual(['plan1']);
		expect(c.getState().canUndo).toBe(false);
		expect(c.planPreview('plan1')!.tracks[0].clips.length).toBe(3);
		const applied = c.applyPlan('plan1');
		expect(applied).toMatchObject({ ok: true, stale: false });
		expect(c.getState().plans).toEqual([]);
		expect(c.getState().undoLabel).toBe('Cut the middle');
		c.undo();
		expect(videoProjectLength(c.getProject())).toBe(7000);
	});

	it('re-checks stale plans, refuses ones that no longer apply and keeps them open', () => {
		const c = new VideoEditorController({ clock: new ManualClock(), project: project() });
		const a = c.proposePlan({ title: 'Trim c2', edits: [{ op: 'trim_clip', clip: 'c2', edge: 'end', to: 6000 }] });
		const b = c.proposePlan({ title: 'Move c1', edits: [{ op: 'update_clip', clip: 'c1', set: { opacity: 0.5 } }] });
		if (!a.ok || !b.ok) throw new Error('plans');
		c.apply({ op: 'delete_clips', clips: ['c2'] });
		expect(c.isPlanStale(a.plan.id)).toBe(true);
		const refused = c.applyPlan(a.plan.id);
		expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/changed since plan "plan1" was made and it no longer applies/) });
		expect(c.getPlan(a.plan.id)).toBeDefined();
		expect(c.applyPlan(b.plan.id)).toMatchObject({ ok: true, stale: true });
		expect(c.discardPlan(a.plan.id)).toBe(true);
		expect(c.discardPlan(a.plan.id)).toBe(false);
		expect(c.applyPlan('nope')).toMatchObject({ ok: false, error: expect.stringMatching(/no open plan "nope"/) });
	});

	it('replaces a plan with the same id, keeps at most MAX_PLANS and refuses to apply while read-only', () => {
		const c = new VideoEditorController({ clock: new ManualClock(), project: project() });
		const edit: VideoEdit = { op: 'update_clip', clip: 'c1', set: { opacity: 0.4 } };
		c.proposePlan({ id: 'x', title: 'One', edits: [edit] });
		c.proposePlan({ id: 'x', title: 'Two', edits: [edit] });
		expect(c.getState().plans.map((p) => p.title)).toEqual(['Two']);
		for (let i = 0; i < VideoEditorController.MAX_PLANS + 3; i++) c.proposePlan({ title: `P${i}`, edits: [edit] });
		expect(c.getState().plans.length).toBe(VideoEditorController.MAX_PLANS);
		c.setReadOnly(true);
		expect(c.proposePlan({ title: 'Allowed', edits: [edit] }).ok).toBe(true);
		expect(c.applyPlan(c.getState().plans[0].id)).toMatchObject({ ok: false, error: 'The video project is read-only.' });
		c.discardPlans();
		expect(c.getState().plans).toEqual([]);
	});
});

describe('plan tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({ clock: new ManualClock(), project: project() });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller, { namespace: '' }));
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
			return r.structuredContent as any;
		};
		const fail = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			expect(r.isError, `${name} should fail`).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, registry, call, fail };
	};

	it('plan_video_edits proposes, list shows, apply applies; nothing changes before', async () => {
		const { controller, call } = setup();
		const r = await call('plan_video_edits', { title: 'Rough cut', description: 'Drop the second shot', ops: [{ op: 'delete_clips', clips: ['c2'], ripple: true }] });
		expect(r.plan).toMatchObject({ id: 'plan1', title: 'Rough cut', source: 'agent', stale: false, edits: 1, summary: { durationDelta: -3000, clipsRemoved: ['c2'] } });
		expect(r.hint).toMatch(/apply_video_edit_plan/);
		expect(videoProjectLength(controller.getProject())).toBe(7000);
		expect((await call('list_video_edit_plans')).plans.map((p: any) => p.id)).toEqual(['plan1']);
		const a = await call('apply_video_edit_plan', { plan: 'plan1' });
		expect(a).toMatchObject({ plan: 'plan1', title: 'Rough cut', stale: false, duration: 4000 });
		expect((await call('list_video_edit_plans')).plans).toEqual([]);
	});

	it('fails usefully and discards', async () => {
		const { call, fail } = setup();
		expect(await fail('plan_video_edits', { title: 'Bad', ops: [{ op: 'trim_clip', clip: 'nope', edge: 'end', to: 100 }] })).toMatch(/nope/);
		expect(await fail('plan_video_edits', { title: 'Swap', ops: [{ op: 'replace_project', project: {} }] })).toMatch(/op/);
		expect(await fail('plan_video_edits', { ops: [{ op: 'close_gaps', track: 'v1' }] })).toMatch(/title/);
		expect(await fail('apply_video_edit_plan', { plan: 'plan9' })).toMatch(/no open plan "plan9"/);
		await call('plan_video_edits', { title: 'Fade', ops: [{ op: 'update_clip', clip: 'c1', set: { fadeIn: 500 } }] });
		expect(await call('discard_video_edit_plan', { plan: 'plan1' })).toEqual({ discarded: 'plan1', open: [] });
		expect(await fail('discard_video_edit_plan', { plan: 'plan1' })).toMatch(/no open plan/);
	});

	it('hides the plan writers while read-only but keeps the list', () => {
		const { controller, registry } = setup();
		controller.setReadOnly(true);
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('list_video_edit_plans');
		for (const n of ['plan_video_edits', 'apply_video_edit_plan', 'discard_video_edit_plan', 'add_video_adjustment_clip', 'set_video_clip_mask']) expect(names).not.toContain(n);
	});
});
