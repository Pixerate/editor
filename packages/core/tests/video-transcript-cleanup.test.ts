import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	createVideoDialogueToolProvider,
	createVideoEditorToolProvider,
	createVideoProject,
	detectVideoDisfluencies,
	findVideoRepetitions,
	TranscriptVideoController,
	VideoEditorController,
	videoCutsWithMargin,
	videoProjectDuration,
	videoTimelineTranscript,
	type VideoEdit,
	type VideoProject,
	type VideoTranscriptWord
} from '../src/video-editor';

/** "So um I I think we should we should ship it." with a long pause before "ship". */
const SPEECH: VideoTranscriptWord[] = [
	{ word: 'So', start: 0, end: 300 },
	{ word: 'um', start: 400, end: 700 },
	{ word: 'I', start: 800, end: 900 },
	{ word: 'I', start: 950, end: 1050 },
	{ word: 'think', start: 1100, end: 1400 },
	{ word: 'we', start: 1500, end: 1600 },
	{ word: 'should,', start: 1600, end: 1900 },
	{ word: 'we', start: 2000, end: 2100 },
	{ word: 'should', start: 2100, end: 2400 },
	{ word: 'ship', start: 4000, end: 4300 },
	{ word: 'it.', start: 4300, end: 4600 }
];

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};
const interview = () =>
	ok(createVideoProject({ width: 640, height: 360, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'talk', kind: 'video', src: 'talk.mp4', duration: 5000, transcript: SPEECH } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'v', asset: 'talk', start: 0, duration: 5000 } }
	]);

describe('finding disfluencies', () => {
	it('finds repeated words and phrases, longest first, covering the first saying', () => {
		const words = videoTimelineTranscript(interview());
		expect(findVideoRepetitions(words)).toEqual([
			{ from: 800, to: 950, text: 'I' },
			{ from: 1500, to: 2000, text: 'we should,' }
		]);
		expect(findVideoRepetitions(words, { maxGap: 10 })).toEqual([]);
		expect(findVideoRepetitions(words, { maxPhrase: 1 })).toEqual([{ from: 800, to: 950, text: 'I' }]);
	});

	it('lists fillers, pauses and repetitions in time order with the words they cover', () => {
		const words = videoTimelineTranscript(interview());
		const found = detectVideoDisfluencies(words, { pauses: { fps: 25 } });
		expect(found.map((d) => [d.kind, d.text, d.words])).toEqual([
			['filler', 'um', [1, 1]],
			['repetition', 'I', [2, 2]],
			['repetition', 'we should,', [5, 6]],
			['pause', '(pause after "should")', [8, 9]]
		]);
		expect(detectVideoDisfluencies(words, { kinds: ['pause'] }).length).toBe(1);
		expect(videoCutsWithMargin([{ from: 0, to: 100 }, { from: 0, to: 30 }], 20)).toEqual([{ from: 20, to: 80 }]);
	});
});

describe('TranscriptVideoController', () => {
	const setup = (options = {}) => {
		const editor = new VideoEditorController({ clock: new ManualClock(), project: interview() });
		const transcript = new TranscriptVideoController(editor, options);
		return { editor, transcript };
	};

	it('follows the playhead word by word and maps text offsets to times', () => {
		const { editor, transcript } = setup();
		const seen: number[] = [];
		transcript.subscribe((s) => seen.push(s.current));
		editor.seek(1200);
		expect(transcript.getState().current).toBe(4);
		transcript.seekToWord(9);
		expect(editor.getState().time).toBe(4000);
		expect(seen).toEqual([4, 9]);
		const { text } = transcript.getState();
		expect(text.startsWith('So um I I think')).toBe(true);
		expect(transcript.textOffset(4)).toBe(text.indexOf('think'));
		expect(transcript.wordAtOffset(text.indexOf('think') + 2)).toBe(4);
		expect(transcript.timeAtOffset(text.indexOf('ship'))).toBe(4000);
		expect(transcript.getState().flags[1]).toEqual(['filler']);
		expect(transcript.getState().flags[8]).toEqual(['pause']);
	});

	it('deletes selected words as one undo step, or proposes them with planFirst', () => {
		const { editor, transcript } = setup();
		expect(transcript.deleteSelection()).toEqual({ ok: false, error: 'Select the words to delete first.' });
		transcript.select(4, 2);
		expect(transcript.getState().selection).toEqual([2, 4]);
		const r = transcript.deleteSelection();
		expect(r.ok && r.applied).toBeTruthy();
		expect(editor.getState().undoLabel).toBe('Delete 3 words');
		expect(transcript.getState().words.map((w) => w.word).slice(0, 3)).toEqual(['So', 'um', 'we']);
		expect(transcript.getState().selection).toBeNull();
		editor.undo();
		const planned = setup({ planFirst: true });
		planned.transcript.select(1);
		const p = planned.transcript.deleteSelection();
		expect(p.ok && p.plan?.title).toBe('Delete "um"');
		expect(planned.editor.getState().plans.length).toBe(1);
		expect(videoProjectDuration(planned.editor.getProject())).toBe(5000);
	});

	it('removes one disfluency at once, and plans a whole cleanup for review', () => {
		const { editor, transcript } = setup();
		const r = transcript.removeDisfluency(0);
		expect(r.ok).toBe(true);
		expect(editor.getState().undoLabel).toBe('Remove "um"');
		expect(transcript.removeDisfluency(99)).toMatchObject({ ok: false, error: expect.stringMatching(/no disfluency 99/) });
		const plan = transcript.planCleanup();
		expect(plan.ok && plan.plan?.title).toBe('Clean up 1 pause, 2 repetitions');
		expect(plan.ok && plan.plan?.summary.durationDelta).toBeLessThan(0);
		expect(transcript.planCleanup(['filler'])).toMatchObject({ ok: false, error: 'No filler found.' });
	});

	it('refuses cuts while the editor is read-only, and stops on destroy', () => {
		const { editor, transcript } = setup();
		editor.setReadOnly(true);
		expect(transcript.getState().editable).toBe(false);
		transcript.select(1);
		expect(transcript.deleteSelection()).toMatchObject({ ok: false, error: 'The video project is read-only.' });
		transcript.destroy();
		editor.setReadOnly(false);
		expect(transcript.getState().editable).toBe(false);
	});
});

describe('dialogue tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({ clock: new ManualClock(), project: interview() });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller, { namespace: '' }));
		registry.register(createVideoDialogueToolProvider(controller, { namespace: '' }));
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

	it('find_video_disfluencies lists what to tidy with totals, changing nothing', async () => {
		const { controller, call, fail } = setup();
		const r = await call('find_video_disfluencies');
		expect(r.disfluencies.map((d: any) => d.kind)).toEqual(['filler', 'repetition', 'repetition', 'pause']);
		expect(r.totals.filler).toEqual({ count: 1, time: 300 });
		expect(r.removable).toBeGreaterThan(1500);
		expect(controller.getState().canUndo).toBe(false);
		expect((await call('find_video_disfluencies', { kinds: ['filler'], fillers: ['so'] })).disfluencies.map((d: any) => d.text)).toEqual(['So']);
		expect(await fail('find_video_disfluencies', { kinds: ['cough'] })).toMatch(/kinds/);
		expect(await fail('find_video_disfluencies', { track: 'a1' })).toMatch(/No clip on track "a1"/);
	});

	it('plan_video_dialogue_cleanup proposes one plan, honouring exclude and margin, then applies as one step', async () => {
		const { controller, call, fail } = setup();
		const r = await call('plan_video_dialogue_cleanup', { exclude: [800], margin: 20 });
		expect(r.plan.title).toBe('Clean up 1 filler, 1 pause, 1 repetition');
		expect(r.plan.cuts).toBe(3);
		expect(videoProjectDuration(controller.getProject())).toBe(5000);
		const listed = await call('list_video_edit_plans');
		expect(listed.plans[0].ranges.map((x: any) => x.reason)).toEqual(['filler', 'repetition', 'pause']);
		await call('apply_video_edit_plan', { plan: r.plan.id });
		expect(videoProjectDuration(controller.getProject())).toBe(5000 + r.plan.summary.durationDelta);
		expect(controller.getState().undoLabel).toBe(r.plan.title);
		expect(await fail('plan_video_dialogue_cleanup', { kinds: ['filler'], fillers: ['banana'] })).toMatch(/Nothing to clean up/);
	});

	it('hides the planning tool while read-only', () => {
		const { controller, registry } = setup();
		controller.setReadOnly(true);
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('find_video_disfluencies');
		expect(names).not.toContain('plan_video_dialogue_cleanup');
	});
});
