import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, checkBrush, createBrushLibrary, createBrushLibraryToolProvider, VECTOR_PROFILE } from '../src/brushes';
import { base64ToBytes, decodePng } from '../src/raster/png';
import { ToolRegistry } from '../src/tools';
import { renderVectorBrushPreview } from '../src/vector';

function setup() {
	const library = createBrushLibrary();
	const tools = new ToolRegistry();
	tools.register(createBrushLibraryToolProvider(library, { profile: VECTOR_PROFILE, renderPreview: renderVectorBrushPreview, id: 'vectorbrushes' }));
	return { library, tools };
}

/** The decoded preview and how many of its pixels are painted (alpha > 0), and how many differ from the two bands. */
function inspect(data: string) {
	const png = decodePng(base64ToBytes(data));
	let painted = 0;
	const colours = new Set<string>();
	for (let i = 0; i < png.data.length; i += 4) {
		if (png.data[i + 3] > 0) painted++;
		colours.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]},${png.data[i + 3]}`);
	}
	return { png, painted, colours: colours.size };
}

describe('renderVectorBrushPreview through preview_brush', () => {
	it.each(['gouache', 'watercolor-wash'])('previews wet paint %s as a settled vector brushstroke', async (id) => {
		const { tools } = setup();
		const r = await tools.callTool('vectorbrushes__preview_brush', { id, width: 160, height: 64, color: '#1d4ed8' });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toEqual({ id, width: 160, height: 64 });
		const image = r.content[0] as { type: string; data: string; mimeType: string };
		expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
		const { png, painted } = inspect(image.data);
		expect([png.width, png.height]).toEqual([160, 64]);
		// Transparent around a stroke that crosses the preview.
		expect(painted).toBeGreaterThan(400);
		expect(painted).toBeLessThan(160 * 64);
	}, 30_000);

	it.each(['mixer-brush', 'smudge'])('previews backdrop medium %s', async (id) => {
		const { tools } = setup();
		const r = await tools.callTool('vectorbrushes__preview_brush', { id, width: 160, height: 64, color: '#1d4ed8' });
		expect(r.isError).toBeFalsy();
		const { png, painted, colours } = inspect((r.content[0] as { data: string }).data);
		expect([png.width, png.height]).toEqual([160, 64]);
		expect(painted).toBeGreaterThan(400);
		// More than the bands (or the background): the stroke changed something.
		expect(colours).toBeGreaterThan(2);
	}, 30_000);

	it('shows smudge dragging the two bands into each other', async () => {
		const { tools } = setup();
		const r = await tools.callTool('vectorbrushes__preview_brush', { id: 'smudge', width: 160, height: 64, color: '#1d4ed8' });
		const { png } = inspect((r.content[0] as { data: string }).data);
		const at = (x: number, y: number) => Array.from(png.data.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
		// The corners keep the bands: the paint above, ochre below.
		expect(at(0, 0)).toEqual([0x1d, 0x4e, 0xd8, 255]);
		expect(at(0, 63)).toEqual([232, 196, 64, 255]);
	}, 30_000);

	it('previews dry brushes as the canvas swatch does', async () => {
		const { tools } = setup();
		const r = await tools.callTool('vectorbrushes__preview_brush', { id: 'charcoal-stick', width: 120, height: 40 });
		expect(r.isError).toBeFalsy();
		expect(decodePng(base64ToBytes((r.content[0] as { data: string }).data)).width).toBeGreaterThan(60);
	});

	it('refuses an unknown id and a brush the vector host cannot paint, saying why', async () => {
		const { tools } = setup();
		const unknown = await tools.callTool('vectorbrushes__preview_brush', { id: 'no-such-brush' });
		expect(unknown.isError).toBe(true);
		const bad = await tools.callTool('vectorbrushes__preview_brush', { id: 'gouache', width: 8 });
		expect(bad.isError).toBe(true);
		const refused = BRUSH_PRESETS.find((b) => !checkBrush(b, VECTOR_PROFILE).ok)!;
		const r = await tools.callTool('vectorbrushes__preview_brush', { id: refused.id });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.content)).toMatch(/can't paint a brushstroke/);
		await expect(renderVectorBrushPreview(refused, { width: 64, height: 32, color: '#000000' })).rejects.toThrow(/Use one of: /);
	});
});
