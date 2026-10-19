import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	createVideoEditorToolProvider,
	createVideoProject,
	findVideoFillers,
	findVideoTranscriptPauses,
	findVideoTranscriptText,
	mergeVideoRanges,
	parseVideoProject,
	parseVideoTranscript,
	VideoEditorController,
	videoRemoveRangesEdits,
	videoTimelineTranscript,
	videoTranscriptTrack,
	videoWordAt,
	type VideoEdit,
	type VideoProject,
	type VideoTranscriptWord
} from '../src/video-editor';

/** "So um I think, you know, we should ship it." with a long pause before "we". */
const SPEECH: VideoTranscriptWord[] = [
	{ word: 'So', start: 0, end: 300 },
	{ word: 'um', start: 400, end: 700 },
	{ word: 'I', start: 800, end: 900 },
	{ word: 'think,', start: 900, end: 1200 },
	{ word: 'you', start: 1300, end: 1450 },
	{ word: 'know,', start: 1450, end: 1700 },
	{ word: 'we', start: 3000, end: 3200 },
	{ word: 'should', start: 3200, end: 3500 },
	{ word: 'ship', start: 3500, end: 3800 },
	{ word: 'it.', start: 3800, end: 4000 }
];

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};
const interview = () =>
	ok(createVideoProject({ width: 640, height: 360, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'talk', kind: 'video', src: 'talk.mp4', duration: 5000, transcript: SPEECH } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'v', asset: 'talk', start: 1000, duration: 4000 } }
	]);

describe('parseVideoTranscript', () => {
	it('reads Whisper-style JSON in seconds, word lists in ms, and keeps the order', () => {
		const whisper = JSON.stringify({ text: 'Hi there', segments: [{ start: 0, end: 1, text: 'Hi there', words: [{ word: ' there', start: 0.5, end: 0.9 }, { word: ' Hi', start: 0.1, end: 0.4 }] }] });
		expect(parseVideoTranscript(whisper)).toEqual({ words: [{ word: 'Hi', start: 100, end: 400 }, { word: 'there', start: 500, end: 900 }], approximate: false });
		expect(parseVideoTranscript('{"words":[{"word":"a","start":1.25,"end":1.5}]}').words).toEqual([{ word: 'a', start: 1250, end: 1500 }]);
		expect(parseVideoTranscript([{ word: 'x', start: 10, end: 20 }]).words).toEqual([{ word: 'x', start: 10, end: 20 }]);
		// Segments without word timings are spread across each segment.
		expect(parseVideoTranscript({ segments: [{ start: 0, end: 1, text: 'one two' }] })).toEqual({ words: [{ word: 'one', start: 0, end: 500 }, { word: 'two', start: 500, end: 1000 }], approximate: true });
	});

	it('reads SubRip and WebVTT, spreading each cue', () => {
		const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello <i>big</i>\r\nworld\r\n\r\n2\r\n00:00:03,500 --> 00:00:04,000\r\nBye\r\n';
		expect(parseVideoTranscript(srt)).toEqual({
			words: [{ word: 'Hello', start: 1000, end: 1333 }, { word: 'big', start: 1333, end: 1667 }, { word: 'world', start: 1667, end: 2000 }, { word: 'Bye', start: 3500, end: 4000 }],
			approximate: true
		});
		const vtt = 'WEBVTT\n\nNOTE made by hand\n\n00:01.000 --> 00:02.000 align:start\nHi you\n';
		expect(parseVideoTranscript(vtt).words).toEqual([{ word: 'Hi', start: 1000, end: 1500 }, { word: 'you', start: 1500, end: 2000 }]);
	});

	it('says what is wrong', () => {
		expect(() => parseVideoTranscript('{nope')).toThrow('not valid JSON');
		expect(() => parseVideoTranscript('just some text')).toThrow('No words found');
		expect(() => parseVideoTranscript('{"words":[{"word":"a"}]}')).toThrow('Word 1 needs a word and numeric start and end.');
		expect(() => parseVideoTranscript('00:00:01,000 --> soon\nHi')).toThrow('"soon" is not a cue time');
		expect(() => parseVideoProject({ width: 640, height: 360, assets: [{ id: 'a', kind: 'audio', src: 'a.wav', transcript: [{ word: 'x', start: 5, end: 2 }] }], tracks: [] })).toThrow('assets[0].transcript[0].end must be at least 5.');
		expect(() => parseVideoProject({ width: 640, height: 360, assets: [{ id: 'a', kind: 'image', src: 'a.png', transcript: [] }], tracks: [] })).toThrow('is only for video and audio assets');
	});
});

describe('the timeline transcript', () => {
	it('maps words through in points, speed and cuts, keeping a word where its middle plays', () => {
		const p = interview();
		const words = videoTimelineTranscript(p);
		expect(words.map((w) => w.word).join(' ')).toBe('So um I think, you know, we should ship it.');
		expect(words[0]).toEqual({ word: 'So', start: 1000, end: 1300, clip: 'v', track: 'v1', index: 0 });
		// Trim the head past "So" (its middle, 150 ms, is cut) and double the speed.
		const q = ok(p, [{ op: 'trim_clip', clip: 'v', edge: 'start', to: 1350 }, { op: 'update_clip', clip: 'v', set: { speed: 2 } }]);
		const fast = videoTimelineTranscript(q);
		expect(fast[0]).toMatchObject({ word: 'um', start: 1375, end: 1525 });
		expect(fast.at(-1)!.word).toBe('it.');
		expect(videoWordAt(fast, 1400)).toBe(0);
		expect(videoWordAt(fast, 1360)).toBe(-1);
		expect(videoWordAt(fast, 1349)).toBe(-1);
	});

	it('reads audio tracks first, or the track asked for', () => {
		const p = ok(interview(), [{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 'a', asset: 'talk', in: 3000, duration: 1000 } }]);
		expect(videoTranscriptTrack(p)).toBe('a1');
		expect(videoTimelineTranscript(p).map((w) => w.word)).toEqual(['we', 'should', 'ship', 'it.']);
		expect(videoTimelineTranscript(p, { track: 'v1' })).toHaveLength(10);
		expect(() => videoTimelineTranscript(p, { track: 'zz' })).toThrow('There is no track "zz"');
		expect(videoTimelineTranscript(createVideoProject())).toEqual([]);
	});

	it('finds phrases, fillers and pauses as timeline ranges', () => {
		const words = videoTimelineTranscript(interview());
		expect(findVideoTranscriptText(words, 'SHIP it')).toEqual([{ from: 4500, to: 5000, text: 'ship it.' }]);
		expect(findVideoTranscriptText(words, 'think')).toEqual([{ from: 1900, to: 2200, text: 'think,' }]);
		expect(() => findVideoTranscriptText(words, '  ')).toThrow('at least one word');
		expect(findVideoFillers(words)).toEqual([
			{ from: 1400, to: 1700, text: 'um' },
			{ from: 2300, to: 2700, text: 'you know,' }
		]);
		expect(findVideoFillers(words, ['so'])).toEqual([{ from: 1000, to: 1300, text: 'So' }]);
		expect(findVideoTranscriptPauses(words)).toEqual([{ from: 2850, to: 3850, text: '(pause after "know,")' }]);
		// Snapped inward to 25 fps frames (40 ms).
		expect(findVideoTranscriptPauses(words, { keep: 130, fps: 25 })).toEqual([{ from: 2840, to: 3840, text: '(pause after "know,")' }]);
		expect(findVideoTranscriptPauses(words, { min: 2000 })).toEqual([]);
	});

	it('cuts ranges out last first, so the transcript closes up', () => {
		expect(mergeVideoRanges([{ from: 50, to: 60 }, { from: 0, to: 10 }, { from: 10, to: 20 }, { from: 5, to: 5 }])).toEqual([{ from: 0, to: 20 }, { from: 50, to: 60 }]);
		const p = interview();
		const words = videoTimelineTranscript(p);
		const edits = videoRemoveRangesEdits([...findVideoFillers(words), ...findVideoTranscriptPauses(words)]);
		expect(edits.map((e) => (e as { from: number }).from)).toEqual([2850, 2300, 1400]);
		const tight = ok(p, edits);
		expect(videoTimelineTranscript(tight).map((w) => w.word).join(' ')).toBe('So I think, we should ship it.');
		expect(tight.tracks[0].clips).toHaveLength(4);
	});
});

describe('transcript tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({ clock: new ManualClock() });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
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
		return { controller, call, fail };
	};

	it('attach a transcript, read it, and tighten the edit by text in one undo step each', async () => {
		const { controller, call, fail } = setup();
		await call('add_video_asset', { id: 'talk', kind: 'video', src: 'talk.mp4', duration: 5000 });
		expect(await fail('get_video_transcript')).toContain('attach a transcript');
		const set = await call('set_video_transcript', { asset: 'talk', text: JSON.stringify({ words: SPEECH.map((w) => ({ word: w.word, start: w.start / 1000, end: w.end / 1000 })) }) });
		expect(set).toMatchObject({ asset: 'talk', words: 10, approximate: false, first: { word: 'So' } });
		await call('add_video_clip', { track: 'v1', clip: { type: 'media', id: 'v', asset: 'talk', start: 1000, duration: 4000 } });
		const project = await call('get_video_project');
		expect(project.assets[0]).toMatchObject({ id: 'talk', transcriptWords: 10 });
		expect(project.assets[0].transcript).toBeUndefined();

		const read = await call('get_video_transcript', { limit: 3 });
		expect(read).toMatchObject({ track: 'v1', text: 'So um I', more: true });
		expect(read.words[1]).toEqual({ word: 'um', start: 1400, end: 1700, clip: 'v' });
		expect((await call('find_video_transcript_text', { query: 'ship it' })).matches).toEqual([{ from: 4500, to: 5000, text: 'ship it.' }]);
		const fillers = await call('find_video_fillers');
		expect(fillers.total).toBe(700);
		const pauses = await call('find_video_pauses');
		expect(pauses.pauses).toHaveLength(1);

		const cut = await call('remove_video_ranges', { ranges: [...pauses.pauses, ...fillers.fillers] });
		// The pause is snapped inward to the project's 30 fps frames.
		expect(cut.removed).toBe(3);
		expect(cut.time).toBeCloseTo(fillers.total + pauses.total, 0);
		expect(cut.duration).toBeCloseTo(5000 - cut.time, 0);
		expect((await call('get_video_transcript')).text).toBe('So I think, we should ship it.');
		expect(controller.getState().undoLabel).toBe('Cut 3 stretches');
		controller.undo();
		expect((await call('get_video_transcript')).text).toBe('So um I think, you know, we should ship it.');
	});

	it('say what is wrong with a request', async () => {
		const { call, fail } = setup();
		await call('add_video_asset', { id: 'talk', kind: 'audio', src: 'talk.wav', duration: 1000 });
		await call('add_video_asset', { id: 'pic', kind: 'image', src: 'p.png' });
		expect(await fail('set_video_transcript', { asset: 'talk' })).toContain('Pass either "text"');
		expect(await fail('set_video_transcript', { asset: 'talk', text: 'x', words: [{ word: 'a', start: 0, end: 1 }] })).toContain('not both');
		expect(await fail('set_video_transcript', { asset: 'pic', words: [{ word: 'a', start: 0, end: 1 }] })).toContain('is an image');
		expect(await fail('set_video_transcript', { asset: 'nope', words: [{ word: 'a', start: 0, end: 1 }] })).toContain('There is no asset "nope"');
		expect(await fail('set_video_transcript', { asset: 'talk', text: 'hello' })).toContain('No words found');
		const late = await call('set_video_transcript', { asset: 'talk', words: [{ word: 'a', start: 0, end: 4000 }] });
		expect(late.warning).toMatch(/past the asset's 1000 ms/);
		expect(await fail('remove_video_ranges', { ranges: [{ from: 500, to: 100 }] })).toContain('Range 1 is empty or backwards');
		expect(await fail('find_video_transcript_text', { query: 'a', track: 'zz' })).toContain('There is no track "zz"');
		const cleared = await call('update_video_asset', { asset: 'talk', remove: ['transcript'] });
		expect(cleared.asset.transcriptWords).toBeUndefined();
	});
});
