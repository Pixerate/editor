// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ToolRegistry,
	captureOutputSize,
	cloneElementWithStyles,
	createCaptureToolProvider,
	createElementCaptureSurface,
	elementToSvg,
	rasterizeElement,
	toCapturedImageData,
	unionCaptureRects,
	type CaptureRenderRequest,
	type CaptureSurface,
	type RasterizeElementOptions
} from '../src/tools';
import { canvasNodeCaptureRect, createCanvasCaptureToolProvider, type CanvasNode } from '../src/canvas';
import { ImageEditorController, createImageCaptureSurface, createImageEditorToolProvider } from '../src/image-editor';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function fakeSurface(overrides: Partial<CaptureSurface> = {}) {
	const requests: CaptureRenderRequest[] = [];
	const surface: CaptureSurface = {
		units: 'canvas units',
		viewport: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		content: () => ({ x: 100, y: 50, width: 400, height: 200 }),
		selection: () => ({ rect: { x: 100, y: 50, width: 50, height: 50 }, ids: ['a'] }),
		items: {
			region: 'nodes',
			noun: 'node',
			source: 'list_nodes',
			bounds: (ids) => ({
				rect: ids.includes('a') ? { x: 100, y: 50, width: 50, height: 50 } : null,
				missing: ids.filter((id) => !['a', 'b'].includes(id))
			})
		},
		overlays: 'selection boxes',
		render: (request) => {
			requests.push(request);
			return PNG;
		},
		...overrides
	};
	const registry = new ToolRegistry();
	registry.register(createCaptureToolProvider(surface, { id: 'cap' }));
	return { registry, requests };
}

describe('capture_view tool', () => {
	it('has a strict schema with every argument described', () => {
		const { registry } = fakeSurface();
		const tool = registry.getTool('capture_view')!;
		expect(tool.title).toBe('Capture a screenshot');
		expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(tool.inputSchema.properties!)).toEqual(['region', 'ids', 'rect', 'padding', 'maxEdge', 'format', 'quality', 'includeOverlays']);
		expect((tool.inputSchema.properties!.region as any).enum).toEqual(['viewport', 'content', 'selection', 'nodes', 'rect']);
		for (const [key, prop] of Object.entries(tool.inputSchema.properties!)) expect((prop as any).description, key).toBeTruthy();
	});

	it('leaves out options the surface does not support', () => {
		const { registry } = fakeSurface({ viewport: undefined, selection: undefined, items: undefined, overlays: undefined });
		const schema = registry.getTool('capture_view')!.inputSchema;
		expect((schema.properties!.region as any).enum).toEqual(['content', 'rect']);
		expect(schema.properties).not.toHaveProperty('ids');
		expect(schema.properties).not.toHaveProperty('includeOverlays');
	});

	it('captures the viewport by default and returns the image, the rect and the scale', async () => {
		const { registry, requests } = fakeSurface();
		const result = await registry.callTool('capture_view', {});
		expect(result.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
		expect(result.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Captured viewport at 1024×768 px') });
		expect(result.structuredContent).toEqual({
			region: 'viewport',
			rect: { x: 0, y: 0, width: 800, height: 600 },
			units: 'canvas units',
			width: 1024,
			height: 768,
			scale: 1.28,
			mimeType: 'image/png'
		});
		expect(requests[0]).toMatchObject({ region: 'viewport', format: 'png', quality: 0.85, includeOverlays: false });
	});

	it('pads content and selection, frames nodes by id and echoes the ids', async () => {
		const { registry } = fakeSurface();
		const content = await registry.callTool('capture_view', { region: 'content', padding: 10, maxEdge: 420 });
		expect(content.structuredContent).toMatchObject({ rect: { x: 90, y: 40, width: 420, height: 220 }, width: 420, height: 220, scale: 1 });
		const selection = await registry.callTool('capture_view', { region: 'selection' });
		expect(selection.structuredContent).toMatchObject({ rect: { x: 84, y: 34, width: 82, height: 82 }, ids: ['a'] });
		const nodes = await registry.callTool('capture_view', { region: 'nodes', ids: ['a'], padding: 0 });
		// Small regions stop at maxScale (2 px per unit).
		expect(nodes.structuredContent).toMatchObject({ rect: { x: 100, y: 50, width: 50, height: 50 }, width: 100, height: 100, scale: 2, ids: ['a'] });
	});

	it('captures a rect as JPEG with overlays', async () => {
		const { registry, requests } = fakeSurface();
		const result = await registry.callTool('capture_view', {
			region: 'rect',
			rect: { x: -20, y: 10, width: 2000, height: 1000 },
			format: 'jpeg',
			quality: 0.5,
			includeOverlays: true
		});
		expect(result.structuredContent).toMatchObject({ width: 1024, height: 512, scale: 0.51 });
		expect(requests[0]).toMatchObject({ format: 'jpeg', quality: 0.5, includeOverlays: true, rect: { x: -20, y: 10, width: 2000, height: 1000 } });
	});

	it('fails with errors that say how to fix the call', async () => {
		const { registry, requests } = fakeSurface({ selection: () => ({ rect: null }) });
		const call = async (args: Record<string, unknown>) => {
			const r = await registry.callTool('capture_view', args);
			expect(r.isError).toBe(true);
			return (r.content[0] as { text: string }).text;
		};
		expect(await call({ region: 'rect' })).toMatch(/Region "rect" needs "rect"/);
		expect(await call({ rect: { x: 0, y: 0, width: 1, height: 1 } })).toMatch(/"rect" only applies with region "rect"/);
		expect(await call({ region: 'content', ids: ['a'] })).toMatch(/"ids" only applies with region "nodes"/);
		expect(await call({ region: 'nodes' })).toMatch(/needs "ids"/);
		expect(await call({ region: 'nodes', ids: ['a', 'zz', 'yy'] })).toBe('Unknown node id(s): zz, yy. Read the current ids with list_nodes.');
		expect(await call({ region: 'nodes', ids: ['b'] })).toMatch(/have no size yet/);
		expect(await call({ region: 'selection' })).toMatch(/Nothing is selected/);
		expect(await call({ region: 'everything' })).toMatch(/Invalid arguments/);
		expect(await call({ region: 'rect', rect: { x: 0, y: 0, width: 0, height: 5 } })).toMatch(/Invalid arguments/);
		expect(await call({ maxEdge: 10 })).toMatch(/Invalid arguments/);
		expect(await call({ extra: true })).toMatch(/Invalid arguments/);
		expect(requests).toEqual([]);
	});

	it('reports an empty surface and an unmounted viewport', async () => {
		const { registry } = fakeSurface({ content: () => null, viewport: () => null });
		expect((await registry.callTool('capture_view', { region: 'content' })).content[0]).toMatchObject({ text: expect.stringMatching(/surface is empty/) });
		expect((await registry.callTool('capture_view', {})).content[0]).toMatchObject({ text: expect.stringMatching(/not on screen/) });
	});

	it('turns render failures and empty images into tool errors', async () => {
		const failing = fakeSurface({ render: () => { throw new Error('No canvas here.'); } });
		expect((await failing.registry.callTool('capture_view', {})).content[0]).toMatchObject({ text: 'No canvas here.' });
		const empty = fakeSurface({ render: () => 'data:,' });
		expect((await empty.registry.callTool('capture_view', {})).isError).toBe(true);
		const raw = fakeSurface({ render: () => ({ data: 'AAA', mimeType: 'image/jpeg' }) });
		expect((await raw.registry.callTool('capture_view', {})).content[0]).toEqual({ type: 'image', data: 'AAA', mimeType: 'image/jpeg' });
	});
});

describe('capture helpers', () => {
	it('sizes output to maxEdge and maxScale', () => {
		expect(captureOutputSize({ x: 0, y: 0, width: 4000, height: 1000 }, 1000)).toEqual({ width: 1000, height: 250, scale: 0.25 });
		expect(captureOutputSize({ x: 0, y: 0, width: 10, height: 5 }, 1000, 4)).toEqual({ width: 40, height: 20, scale: 4 });
	});

	it('unions rects and parses data URLs', () => {
		expect(unionCaptureRects([null, { x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }])).toEqual({ x: 0, y: -5, width: 25, height: 15 });
		expect(unionCaptureRects([])).toBeNull();
		expect(toCapturedImageData('data:image/jpeg;base64,QUJD', 'image/png')).toEqual({ data: 'QUJD', mimeType: 'image/jpeg' });
		expect(toCapturedImageData('QUJD', 'image/png')).toEqual({ data: 'QUJD', mimeType: 'image/png' });
	});
});

describe('DOM capture', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('clones with inline styles, leaving out excluded elements and copying form values', () => {
		document.body.innerHTML =
			'<div id="root" style="color: rgb(255, 0, 0)"><p>Hi</p><span class="agent-presence">cursor</span><input value="a"><script>x()</script></div>';
		(document.querySelector('input') as HTMLInputElement).value = 'typed';
		const clone = cloneElementWithStyles(document.getElementById('root')!, ['.agent-presence']);
		expect(clone.querySelector('.agent-presence')).toBeNull();
		expect(clone.querySelector('script')).toBeNull();
		expect(clone.querySelector('input')!.getAttribute('value')).toBe('typed');
		expect(clone.getAttribute('style')).toContain('color:rgb(255, 0, 0)');
		const svg = elementToSvg(clone, 120, 40);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="120" height="40"/);
		expect(svg).toContain('<foreignObject');
		expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
	});

	it('explains that rasterizing needs a canvas', async () => {
		document.body.innerHTML = '<div id="root">x</div>';
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(rasterizeElement(document.getElementById('root')!, { width: 10, height: 10 })).rejects.toThrow(/needs a browser DOM/);
	});

	it('draws the styled clone through an image onto a canvas', async () => {
		document.body.innerHTML = '<div id="root" style="background-color: rgb(0, 0, 255)">x</div>';
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
		const fills: string[] = [];
		const context = {
			fillStyle: '',
			fillRect: vi.fn(function (this: { fillStyle: string }) { fills.push(this.fillStyle); }),
			drawImage: vi.fn()
		};
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
		const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJD');
		const url = await rasterizeElement(document.getElementById('root')!, { width: 100, height: 50, pixelWidth: 200, pixelHeight: 100, format: 'jpeg', quality: 0.6 });
		expect(url).toBe('data:image/jpeg;base64,QUJD');
		expect(decodeURIComponent(loaded[0])).toContain('<foreignObject');
		expect(fills).toEqual(['rgb(0, 0, 255)']);
		expect(context.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 200, 100);
		expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6);
	});

	it('element surface shifts the clone to the requested rect and drops overlays', async () => {
		document.body.innerHTML = '<div id="root"><p>Body</p><span class="agent-presence">cursor</span></div>';
		const el = document.getElementById('root')!;
		Object.defineProperties(el, {
			clientWidth: { value: 300 }, clientHeight: { value: 200 }, scrollWidth: { value: 300 }, scrollHeight: { value: 900 }, scrollTop: { value: 400 }
		});
		const calls: RasterizeElementOptions[] = [];
		const surface = createElementCaptureSurface({
			element: () => el,
			rasterize: async (_el, options) => {
				calls.push(options);
				return PNG;
			}
		});
		const registry = new ToolRegistry();
		registry.register(createCaptureToolProvider(surface, { id: 'doc' }));
		const result = await registry.callTool('capture_view', {});
		expect(result.structuredContent).toMatchObject({ rect: { x: 0, y: 400, width: 300, height: 200 }, units: 'CSS pixels' });
		expect(calls[0].exclude).toContain('.agent-presence');
		const clone = el.cloneNode(true) as HTMLElement;
		calls[0].prepare!(clone);
		expect((clone.firstElementChild as HTMLElement).style.transform).toBe('translate(0px, -400px)');
		const content = await registry.callTool('capture_view', { region: 'content', padding: 0, includeOverlays: true });
		expect(content.structuredContent).toMatchObject({ rect: { x: 0, y: 0, width: 300, height: 900 } });
		expect(calls[1].exclude).not.toContain('.agent-presence');
	});
});

describe('canvas capture', () => {
	const nodes: CanvasNode[] = [
		{ id: 'group', position: { x: 100, y: 100 }, data: {}, measured: { width: 300, height: 200 } },
		{ id: 'child', parentId: 'group', position: { x: 20, y: 30 }, data: {}, measured: { width: 50, height: 40 }, selected: true },
		{ id: 'loose', position: { x: -50, y: 0 }, data: {}, width: 10, height: 10 },
		{ id: 'hidden', position: { x: 5000, y: 5000 }, data: {}, width: 10, height: 10, hidden: true }
	];

	function mountFlow() {
		document.body.innerHTML = `
			<div class="react-flow" id="flow">
				<div class="react-flow__renderer"><div class="react-flow__pane">
					<div class="react-flow__viewport xyflow__viewport" style="transform: translate(10px, 20px) scale(2)">
						<div class="react-flow__nodes"><div class="react-flow__node">A</div></div>
						<div class="react-flow__nodesselection">box</div>
					</div>
					<div class="react-flow__selection">drag box</div>
				</div></div>
				<svg class="react-flow__background"></svg>
				<div class="react-flow__panel react-flow__controls">+</div>
				<div class="guides">screen-space layer</div>
			</div>`;
		const el = document.getElementById('flow')!;
		Object.defineProperties(el, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
		return el;
	}

	it('measures nodes with their parents and skips hidden ones', () => {
		expect(canvasNodeCaptureRect(nodes[1], nodes)).toEqual({ x: 120, y: 130, width: 50, height: 40 });
		expect(canvasNodeCaptureRect(nodes[3], nodes)).toBeNull();
	});

	it('maps the viewport, content, selection and nodes into canvas units', async () => {
		const el = mountFlow();
		const calls: RasterizeElementOptions[] = [];
		const registry = new ToolRegistry();
		registry.register(
			createCanvasCaptureToolProvider({
				namespace: 'canvas',
				element: el,
				getViewport: () => ({ x: 10, y: 20, zoom: 2 }),
				getNodes: () => nodes,
				rasterize: async (_el, options) => {
					calls.push(options);
					return PNG;
				}
			})
		);
		const viewport = await registry.callTool('canvas__capture_view', {});
		expect(viewport.structuredContent).toMatchObject({ region: 'viewport', rect: { x: -5, y: -10, width: 400, height: 300 } });
		// The viewport is drawn as on screen: no prepare step; chrome and overlays excluded.
		expect(calls[0]).toMatchObject({ width: 800, height: 600, pixelWidth: 800, pixelHeight: 600 });
		expect(calls[0].prepare).toBeUndefined();
		expect(calls[0].exclude).toEqual(expect.arrayContaining(['.react-flow__panel', '.react-flow__nodesselection', '.agent-presence']));

		const content = await registry.callTool('canvas__capture_view', { region: 'content', padding: 0 });
		expect(content.structuredContent).toMatchObject({ rect: { x: -50, y: 0, width: 450, height: 300 } });
		const selection = await registry.callTool('canvas__capture_view', { region: 'selection', padding: 0 });
		expect(selection.structuredContent).toMatchObject({ rect: { x: 120, y: 130, width: 50, height: 40 }, ids: ['child'], scale: 2 });
		const missing = await registry.callTool('canvas__capture_view', { region: 'nodes', ids: ['loose', 'nope'] });
		expect(missing.content[0]).toMatchObject({ text: 'Unknown node id(s): nope. Read the current ids with the canvas state.' });

		const framed = await registry.callTool('canvas__capture_view', { region: 'nodes', ids: ['loose'], padding: 5, includeOverlays: true });
		expect(framed.structuredContent).toMatchObject({ rect: { x: -55, y: -5, width: 20, height: 20 }, width: 40, height: 40, scale: 2 });
		const last = calls[calls.length - 1];
		expect(last.exclude).not.toContain('.react-flow__nodesselection');
		expect(last.exclude).toContain('.react-flow__controls');
		// Re-framing moves the viewport transform and drops screen-space siblings.
		const clone = el.cloneNode(true) as HTMLElement;
		last.prepare!(clone);
		const vp = clone.querySelector<HTMLElement>('.react-flow__viewport')!;
		expect(vp.style.transform).toBe('translate(110px, 10px) scale(2)');
		expect(vp.querySelector('.react-flow__nodesselection')).not.toBeNull();
		expect(clone.querySelector('.react-flow__background')).toBeNull();
		expect(clone.querySelector('.guides')).toBeNull();
		expect(clone.querySelector('.react-flow__selection')).toBeNull();
	});

	it('refuses to capture an unmounted canvas', async () => {
		const registry = new ToolRegistry();
		registry.register(createCanvasCaptureToolProvider({ element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => nodes }));
		const viewport = await registry.callTool('capture_view', {});
		expect(viewport.content[0]).toMatchObject({ text: expect.stringMatching(/not on screen/) });
		const content = await registry.callTool('capture_view', { region: 'content' });
		expect(content.content[0]).toMatchObject({ text: 'The canvas is not mounted, so there is nothing to capture.' });
	});
});

describe('image editor capture_view', () => {
	function setup(width = 400, height = 300) {
		const controller = new ImageEditorController();
		(controller as any).state.imageDimensions = { width, height };
		const registry = new ToolRegistry();
		registry.register(createImageEditorToolProvider(controller, { id: 'img' }));
		return { controller, registry };
	}

	it('is part of the image editor tools, in natural pixels without a viewport', () => {
		const { registry } = setup();
		const tool = registry.getTool('capture_view')!;
		expect((tool.inputSchema.properties!.region as any).enum).toEqual(['content', 'selection', 'rect']);
		expect(tool.description).toContain('image pixels');
		expect(tool.inputSchema.properties).toHaveProperty('includeOverlays');
	});

	it('frames the whole image without padding and zooms into small rects up to 8×', async () => {
		const { controller } = setup();
		const surface = createImageCaptureSurface(controller);
		expect(surface.content()).toEqual({ x: 0, y: 0, width: 400, height: 300 });
		const registry = new ToolRegistry();
		const requests: CaptureRenderRequest[] = [];
		registry.register(createCaptureToolProvider({ ...surface, render: (r) => (requests.push(r), PNG) }, { defaultPadding: 0 }));
		await registry.callTool('capture_view', {});
		expect(requests[0]).toMatchObject({ region: 'content', rect: { x: 0, y: 0, width: 400, height: 300 }, width: 1024, height: 768 });
		await registry.callTool('capture_view', { region: 'rect', rect: { x: 10, y: 10, width: 20, height: 10 } });
		expect(requests[1]).toMatchObject({ width: 160, height: 80, scale: 8 });
	});

	it('needs a selection for the selection region and an image to render', async () => {
		const { registry } = setup();
		const noSelection = await registry.callTool('capture_view', { region: 'selection' });
		expect(noSelection.content[0]).toMatchObject({ text: expect.stringMatching(/Nothing is selected/) });
		const noImage = await registry.callTool('capture_view', {});
		expect(noImage.isError).toBe(true);
		expect(noImage.content[0]).toMatchObject({ text: 'No image is loaded, so there is nothing to capture.' });
	});

	it('crops the source view to the rect and shades unselected pixels', async () => {
		const { controller, registry } = setup(100, 50);
		await registry.callTool('select_region', { shape: 'rect', x: 10, y: 10, width: 20, height: 20 });
		const view = document.createElement('canvas');
		view.width = 100;
		view.height = 50;
		const renderSourceView = vi.spyOn(controller, 'renderSourceView').mockResolvedValue(view);
		const drawn: unknown[][] = [];
		const context = {
			imageSmoothingEnabled: true,
			drawImage: (...args: unknown[]) => drawn.push(args),
			createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
			putImageData: vi.fn(),
			fillRect: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			strokeRect: vi.fn(),
			setLineDash: vi.fn()
		};
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
		const result = await registry.callTool('capture_view', { region: 'selection', padding: 5, includeOverlays: true });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ rect: { x: 5, y: 5, width: 30, height: 30 }, scale: 8, width: 240, height: 240 });
		expect(renderSourceView).toHaveBeenCalledWith({ scale: 1 });
		expect(context.imageSmoothingEnabled).toBe(false);
		expect(drawn[0]).toEqual([view, 5, 5, 30, 30, 0, 0, 240, 240]);
		// Second draw: the selection shade over the same rect.
		expect(drawn[1].slice(1)).toEqual([5, 5, 30, 30, 0, 0, 240, 240]);
		vi.restoreAllMocks();
	});
});
