// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureContextLostError, cloneElementWithStyles, compositeCapture, findPicture, registerCaptureSource } from '../src/tools';

/** A fake browser image and 2-D context, recording what rasterizing draws. */
function fakeDrawing() {
	const loaded: string[] = [];
	class FakeImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(value: string) {
			loaded.push(value);
			queueMicrotask(() => this.onload?.());
		}
	}
	vi.spyOn(window, 'Image', 'get').mockReturnValue(FakeImage as never);
	const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
	const realGetContext = HTMLCanvasElement.prototype.getContext;
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
		return type === '2d' ? (context as never) : (realGetContext.call(this, type as '2d') as never);
	} as never);
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD');
	const svg = () => decodeURIComponent(loaded[loaded.length - 1]!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
	return { context, svg, FakeImage };
}

/** A picture: a canvas with an SVG overlay and an HTML label on top, in that order. */
function picture() {
	document.body.innerHTML =
		'<div id="pic" data-picture style="position:relative;width:200px;height:100px;background-color:rgb(255,255,255)">' +
		'<canvas id="gl" aria-label="3-D chart" width="200" height="100" style="position:absolute;left:0;top:0"></canvas>' +
		'<svg id="overlay" width="200" height="100" style="position:absolute;left:0;top:0;opacity:0.5"><circle cx="20" cy="20" r="5" fill="red"/></svg>' +
		'<span id="label" style="position:absolute;left:10px;top:80px">Q1</span>' +
		'<span class="agent-presence">cursor</span>' +
		'</div>';
	const root = document.getElementById('pic')!;
	Object.defineProperties(root, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
	return { root, canvas: document.getElementById('gl') as HTMLCanvasElement };
}

describe('capture sources', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('draws a registered canvas again at the capture scale, in place, keeping the layers in order', () => {
		const { root, canvas } = picture();
		const scales: number[] = [];
		const stop = registerCaptureSource(canvas, ({ scale }) => {
			scales.push(scale);
			return `data:image/png;base64,AT${scale}X`;
		});
		const clone = cloneElementWithStyles(root, [], { scale: 2 });
		expect(scales).toEqual([2]);
		expect([...clone.children].map((c) => c.tagName.toLowerCase())).toEqual(['img', 'svg', 'span', 'span']);
		expect(clone.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AT2X');
		expect(clone.querySelector('svg')!.getAttribute('style')).toContain('opacity:0.5');
		stop();
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,PLAIN');
		expect(cloneElementWithStyles(root, [], { scale: 2 }).querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,PLAIN');
	});

	it('takes a canvas from a source, and reports a lost context instead of a blank picture', () => {
		const { root, canvas } = picture();
		const other = document.createElement('canvas');
		vi.spyOn(other, 'toDataURL').mockReturnValue('data:image/png;base64,T1RIRVI=');
		const stop = registerCaptureSource(canvas, () => other);
		expect(cloneElementWithStyles(root).querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,T1RIRVI=');
		stop();
		registerCaptureSource(canvas, () => ({ lost: true, reason: 'the browser took it back' }));
		expect(() => cloneElementWithStyles(root)).toThrow(CaptureContextLostError);
		expect(() => cloneElementWithStyles(root)).toThrow("The picture can't be captured: 3-D chart lost its WebGL context (the browser took it back). Draw it again once the context is restored, then capture.");
	});

	it('notices a lost WebGL context on a canvas with no source', () => {
		const { root, canvas } = picture();
		vi.spyOn(canvas, 'getContext').mockImplementation(((type: string) => (type === 'webgl2' ? { isContextLost: () => true } : null)) as never);
		expect(() => cloneElementWithStyles(root)).toThrow(/3-D chart lost its WebGL context\. Draw it again/);
	});
});

describe('compositeCapture', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('draws the picture at 1× and 2×, re-rendering sources at the output scale and leaving overlays out', async () => {
		const { root, canvas } = picture();
		const { context, svg } = fakeDrawing();
		const scales: number[] = [];
		registerCaptureSource(canvas, ({ scale }) => {
			scales.push(scale);
			return 'data:image/png;base64,R0w=';
		});
		const one = await compositeCapture(root);
		expect(one).toMatchObject({ image: 'data:image/png;base64,QUJD', mimeType: 'image/png', width: 200, height: 100, scale: 1 });
		const two = await compositeCapture(root, { scale: 2 });
		expect(two).toMatchObject({ width: 400, height: 200, scale: 2 });
		expect(scales).toEqual([1, 2]);
		expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 400, 200);
		// The text, the SVG and the canvas picture are all in what was drawn; the agent cursor is not.
		const drawn = svg();
		expect(drawn).toContain('>Q1<');
		expect(drawn).toContain('<circle');
		expect(drawn).toContain('src="data:image/png;base64,R0w="');
		expect(drawn).not.toContain('cursor');
		expect(context.fillRect).toHaveBeenCalled();
	});

	it('fits a largest side, and gives a Blob or JPEG when asked', async () => {
		const { root } = picture();
		fakeDrawing();
		const fitted = await compositeCapture(root, { scale: 4, maxSide: 300 });
		expect(fitted).toMatchObject({ width: 300, height: 150, scale: 1.5 });
		const blob = await compositeCapture(root, { output: 'blob' });
		expect(blob.image).toBeInstanceOf(Blob);
		expect((blob.image as Blob).type).toBe('image/png');
		expect(await (blob.image as Blob).text()).toBe('ABC');
		expect((await compositeCapture(root, { format: 'jpeg' })).mimeType).toBe('image/jpeg');
	});

	it('rejects a lost context and bad options with messages that say what to do', async () => {
		const { root, canvas } = picture();
		fakeDrawing();
		registerCaptureSource(canvas, () => ({ lost: true }));
		await expect(compositeCapture(root)).rejects.toThrow(CaptureContextLostError);
		await expect(compositeCapture(root, { scale: 0 })).rejects.toThrow('scale must be a positive number (got 0).');
		await expect(compositeCapture(root, { maxSide: 0 })).rejects.toThrow('maxSide must be at least 1 pixel (got 0).');
	});

	it('finds the picture container by the page contract', () => {
		picture();
		expect(findPicture(document)?.id).toBe('pic');
		document.body.innerHTML = '<div></div>';
		expect(findPicture(document)).toBeNull();
	});
});
