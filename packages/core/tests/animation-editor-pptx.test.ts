// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AnimationEditorController, compileMotionScene, createAnimationEditorToolProvider, createMotionScene, fromPptxAnimation, motionFrameAt } from '../src/animation-editor';
import { writeZip } from '../src/export/zip-writer';
import { ToolRegistry } from '../src/tools';

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const E = 9525; // EMU per pixel
const xfrm = (x: number, y: number, w: number, h: number, extra = '') => `<a:xfrm${extra}><a:off x="${x * E}" y="${y * E}"/><a:ext cx="${w * E}" cy="${h * E}"/></a:xfrm>`;
const sp = (id: number, name: string, geom: string, x: number, y: number, w: number, h: number, fill: string, text = '') =>
	`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}</p:spPr>${text ? `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`;
const effect = (id: number, cls: string, preset: number, sub: number, spid: number, kind: string, dur: number, extra = '', inner = '') =>
	`<p:par><p:cTn id="${id}" presetID="${preset}" presetClass="${cls}" presetSubtype="${sub}" nodeType="${kind}"${extra}><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="${id + 100}" dur="${dur}"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:set>${inner}</p:childTnLst></p:cTn></p:par>`;

async function pptx(): Promise<Uint8Array> {
	const tree = [
		sp(2, 'Title Box', 'rect', 40, 40, 200, 80, '<a:solidFill><a:srgbClr val="EF4444"/></a:solidFill>', 'Hello'),
		sp(3, 'Badge', 'ellipse', 300, 60, 60, 60, '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln>'),
		`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Pair"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${400 * E}" y="${200 * E}"/><a:ext cx="${100 * E}" cy="${50 * E}"/><a:chOff x="0" y="0"/><a:chExt cx="${200 * E}" cy="${100 * E}"/></a:xfrm></p:grpSpPr>${sp(5, 'Left', 'diamond', 0, 0, 100, 100, '<a:solidFill><a:srgbClr val="22C55E"/></a:solidFill>')}</p:grpSp>`,
		`<p:pic><p:nvPicPr><p:cNvPr id="6" name="Photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:spPr/></p:pic>`
	].join('');
	const timing = [
		effect(10, 'entr', 2, 4, 2, 'clickEffect', 500, ' decel="100000"'),
		effect(11, 'entr', 10, 0, 3, 'withEffect', 400),
		effect(12, 'emph', 26, 0, 3, 'clickEffect', 600, ' repeatCount="2000"'),
		effect(13, 'path', 64, 0, 3, 'afterEffect', 1000, '', '<p:animMotion origin="layout" path="M 0 0 L 0.25 0 E"><p:cBhvr><p:cTn id="300" dur="1000"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animMotion>'),
		effect(14, 'exit', 22, 8, 4, 'withEffect', 500),
		effect(15, 'entr', 99, 0, 2, 'clickEffect', 300)
	].join('');
	return writeZip(
		[
			{ name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
			{ name: 'ppt/presentation.xml', data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="${640 * E}" cy="${360 * E}"/></p:presentation>` },
			{ name: 'ppt/_rels/presentation.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="theme" Target="theme/theme1.xml"/><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/></Relationships>' },
			{ name: 'ppt/theme/theme1.xml', data: `<?xml version="1.0"?><a:theme ${P}><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>` },
			{ name: 'ppt/slides/slide1.xml', data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst>${timing}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>` }
		],
		{ compression: 'store' }
	);
}

describe('PowerPoint animation import', () => {
	it('reads the slide\'s shapes into the artwork', async () => {
		const { scene, notes, slides } = await fromPptxAnimation(await pptx());
		expect(slides).toBe(1);
		expect(scene.artwork).toMatchObject({ width: 640, height: 360, background: '#ffffff' });
		const ids = scene.artwork.nodes.map((n) => n.id);
		expect(ids).toEqual(['title-box-2', 'badge-3', 'pair-4', 'badge-3-path-1']);
		const badge = scene.artwork.nodes[1] as any;
		expect(badge).toMatchObject({ fill: '#4472c4', stroke: '#111111', strokeWidth: 2.6666666666666665, transform: [1, 0, 0, 1, 300, 60] });
		const pair = scene.artwork.nodes[2] as any;
		expect(pair.children[0]).toMatchObject({ id: 'left-5', transform: [1, 0, 0, 1, 400, 200] });
		expect(pair.children[0].subpaths[0].anchors.map((a: any) => [a.x, a.y])).toEqual([[25, 0], [50, 25], [25, 50], [0, 25]]);
		for (const said of [/"Title Box" has text \("Hello"\)/, /"Photo" is a picture/, /entr effect 99 on "title-box-2" has no match here; it fades in instead/]) expect(notes.join('\n')).toMatch(said);
	});

	it('turns the animation pane into a shot per click', async () => {
		const { scene, issues } = await fromPptxAnimation(await pptx());
		expect(scene.trigger).toBe('click');
		expect(scene.shots.map((s) => s.id)).toEqual(['click-1', 'click-2', 'click-3']);
		expect(scene.shots[0].run).toEqual([
			{ type: 'enter', style: 'slide', targets: ['title-box-2'], duration: 500, ease: { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0, y2: 1 }, direction: 'up', distance: 213 },
			{ type: 'enter', style: 'fade', targets: ['badge-3'], duration: 400, with: 'previous' }
		]);
		expect(scene.shots[1].run).toEqual([
			{ type: 'pulse', targets: ['badge-3'], duration: 600, repeat: 2 },
			{ type: 'follow', targets: ['badge-3'], duration: 1000, path: 'badge-3-path-1' },
			{ type: 'exit', style: 'wipe', targets: ['pair-4'], duration: 500, direction: 'left', with: 'previous' }
		]);
		expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
		// The motion path runs a quarter of the slide to the right from the badge's centre.
		const route = scene.artwork.nodes[3] as any;
		expect(route.subpaths[0].anchors.map((a: any) => [a.x, a.y])).toEqual([[330, 90], [490, 90]]);
		const t = compileMotionScene(scene);
		const end = motionFrameAt(scene, t.shots[1].commandsEnd).document;
		expect((end.nodes[1] as any).transform[4]).toBeCloseTo(460, 0);
	});

	it('refuses what it cannot read, saying why, and imports through the agent tool', async () => {
		await expect(fromPptxAnimation(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PowerPoint file/);
		await expect(fromPptxAnimation(await pptx(), { slide: 3 })).rejects.toThrow(/no slide 3; the file has 1 slide/);
		const controller = new AnimationEditorController({ scene: createMotionScene({ width: 10, height: 10, nodes: [] }, { name: 'x' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const data = Buffer.from(await pptx()).toString('base64');
		const dry = (await registry.callTool('import_pptx_animation', { data, dry_run: true })).structuredContent as any;
		expect(dry).toMatchObject({ dry_run: true, slides: 1, shots: [{ id: 'click-1', commands: 2 }, { id: 'click-2', commands: 3 }, { id: 'click-3', commands: 1 }] });
		expect(controller.getScene().name).toBe('x');
		const done = await registry.callTool('import_pptx_animation', { data });
		expect(done.isError).toBeFalsy();
		expect(controller.getScene().name).toBe('slide-1');
		const bad = await registry.callTool('import_pptx_animation', { data: 'bm90IGEgemlw' });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toMatch(/not a PowerPoint file[\s\S]*Nothing was changed/);
	});
});
