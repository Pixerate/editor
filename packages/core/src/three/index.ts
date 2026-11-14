/**
 * `@pixerate/editor/three`: charts drawn in 3-D with three.js (#795). three.js is an optional
 * peer dependency; only this entry imports it.
 *
 * `createChart3dScene` builds the scene for a chart from `layoutChart3d` (boxes for bars,
 * extruded ribbons for lines and areas, a floor and a back wall with the value gridlines, a soft
 * key light and a sky / ground fill) and a camera fitted to it from the chart's `view3d`. It needs
 * no WebGL, so it can be built and checked anywhere. `renderChart3d` draws it on a canvas, only
 * when asked (no animation loop), so the same chart gives the same pixels. Labels are not drawn
 * in WebGL: `labels()` gives each category, tick and title position in CSS px for an HTML or SVG
 * overlay, so text stays crisp and selectable.
 *
 * People can point at the marks (#808): `pick(x, y)` maps CSS px back to the bar, or the line or
 * area point, under them; `focus(selection)` keeps the focused marks' colours and dims the rest
 * towards the background; `anchor(selection)` places a tooltip (`chartTooltipFor`); and
 * `nextChart3dFocus` / `describeChartSelectionIn` give the flat chart's keyboard walk and wording.
 */
import * as THREE from 'three';
import { DEFAULT_CHART_THEME } from '../chart/spec.js';
import { chart3dMarkInFocus, layoutChart3d, type Chart3dLayout } from '../chart/layout3d.js';
import type { ChartSelection, ChartSpec, ChartTheme } from '../chart/types.js';
import { registerCaptureSource } from '../tools/dom-capture.js';

export interface Chart3dOptions {
	/** Size in CSS px. */
	width: number;
	height: number;
	/** Chart colours (default the chart editor's light theme). */
	theme?: Partial<ChartTheme>;
	/** Room around the chart for labels, as a fraction of the shorter side (default 0.12). */
	padding?: number;
}

/** A label for the overlay, in CSS px from the top left. */
export interface Chart3dLabel {
	kind: 'category' | 'tick' | 'title';
	text: string;
	x: number;
	y: number;
	/** How the text sits on the point. */
	anchor: 'start' | 'middle' | 'end';
	/** For category labels: the category's index. */
	index?: number;
	/** The label belongs to the focused selection (its category), so an overlay can highlight it. */
	focused?: boolean;
}

/** What `pick` found: the bar, or the line or area point, under the pointer. */
export type Chart3dPick = Extract<ChartSelection, { kind: 'point' }>;

export interface Chart3dFocusOptions {
	/** How far marks out of focus fade towards the background, 0–1 (default 0.7). */
	dim?: number;
}

export interface Chart3dScene {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	layout: Chart3dLayout;
	/** The overlay labels for the current size. */
	labels(): Chart3dLabel[];
	/** Changes the size (the camera's aspect and fit follow). */
	resize(width: number, height: number): void;
	/** The bar, or the line or area point, under (x, y) in CSS px from the top left, or null. */
	pick(x: number, y: number): Chart3dPick | null;
	/**
	 * Keeps the marks in `selection` (a point, series or category) in their colours and fades the
	 * rest towards the background; null shows every mark as it is. Takes effect on the next render.
	 */
	focus(selection: ChartSelection | null, options?: Chart3dFocusOptions): void;
	/** The focus last set. */
	getFocus(): ChartSelection | null;
	/** Where a tooltip for a point goes: the top of its bar or its point on the line, in CSS px. */
	anchor(selection: ChartSelection): { x: number; y: number } | null;
	/** Frees the geometries and materials. */
	dispose(): void;
}

/** The camera's field of view, degrees: a long lens, so the sides do not splay. */
export const CHART_3D_FOV = 30;

const color = (css: string, fallback: string) => {
	try {
		return new THREE.Color(css);
	} catch {
		return new THREE.Color(fallback);
	}
};

/** A ribbon through `points` (x, y) with thickness `z0..z1`: a line as a band, an area down to the floor. */
function ribbonGeometry(points: { x: number; y: number }[], z0: number, z1: number, kind: 'line' | 'area', thickness: number): THREE.BufferGeometry {
	const shape = new THREE.Shape();
	if (kind === 'area') {
		shape.moveTo(points[0].x, 0);
		for (const p of points) shape.lineTo(p.x, p.y);
		shape.lineTo(points[points.length - 1].x, 0);
	} else {
		// A band of `thickness` around the line.
		shape.moveTo(points[0].x, points[0].y + thickness / 2);
		for (const p of points.slice(1)) shape.lineTo(p.x, p.y + thickness / 2);
		for (const p of [...points].reverse()) shape.lineTo(p.x, p.y - thickness / 2);
	}
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
	geometry.translate(0, 0, z0);
	return geometry;
}

/** The scene and fitted camera for `spec` (its `view3d`, or Office's default view). */
export function createChart3dScene(spec: ChartSpec, options: Chart3dOptions): Chart3dScene {
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const layout = layoutChart3d(spec);
	const scene = new THREE.Scene();
	const disposables: { dispose(): void }[] = [];
	// The layout's z runs back into the picture; three.js' camera sees +x on its left when it looks
	// along +z, so the chart goes in a group mirrored in z and the camera looks along -z.
	const chart = new THREE.Group();
	chart.scale.z = -1;
	chart.name = 'chart';
	scene.add(chart);
	const add = <T extends THREE.Object3D>(o: T) => {
		chart.add(o);
		return o;
	};
	const world = (x: number, y: number, z: number) => new THREE.Vector3(x, y, -z);
	const material = (css: string) => {
		const m = new THREE.MeshStandardMaterial({ color: color(css, '#888888'), roughness: 0.8, metalness: 0 });
		disposables.push(m);
		return m;
	};

	// Light: a soft key from the upper left and a sky / ground fill.
	scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
	const key = new THREE.DirectionalLight(0xffffff, 1.4);
	key.position.copy(world(-layout.width, layout.height * 2.5, -(layout.depth * 3 + layout.width)));
	scene.add(key);

	// Floor and back wall, with the value gridlines on the wall.
	const floorGeometry = new THREE.PlaneGeometry(layout.width, layout.depth + 0.4);
	disposables.push(floorGeometry);
	const floor = add(new THREE.Mesh(floorGeometry, material(theme.grid)));
	floor.rotation.x = -Math.PI / 2;
	floor.position.set(layout.width / 2, 0, (layout.depth + 0.4) / 2 - 0.2);
	const wallGeometry = new THREE.PlaneGeometry(layout.width, layout.height);
	disposables.push(wallGeometry);
	const wallMaterial = material(theme.surface);
	wallMaterial.side = THREE.DoubleSide;
	const wall = add(new THREE.Mesh(wallGeometry, wallMaterial));
	wall.position.set(layout.width / 2, layout.height / 2, layout.depth + 0.2);
	const gridPoints: number[] = [];
	for (const t of layout.ticks) gridPoints.push(0, t.y, layout.depth + 0.19, layout.width, t.y, layout.depth + 0.19);
	if (gridPoints.length) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
		const m = new THREE.LineBasicMaterial({ color: color(theme.axis, '#999999') });
		disposables.push(g, m);
		add(new THREE.LineSegments(g, m)).name = 'gridlines';
	}

	// Bars as boxes; lines and areas as extruded ribbons. Each is a mark that can be picked and
	// focused, with its own material and its colour at rest.
	const marks: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; base: THREE.Color; seriesId: string; index?: number; ribbon?: (typeof layout.ribbons)[number] }[] = [];
	for (const b of layout.boxes) {
		const g = new THREE.BoxGeometry(b.x1 - b.x0, Math.max(1e-4, b.y1 - b.y0), b.z1 - b.z0);
		disposables.push(g);
		const m = material(b.color);
		const mesh = add(new THREE.Mesh(g, m));
		mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
		mesh.name = `bar-${b.seriesId}-${b.index}`;
		mesh.userData = { seriesId: b.seriesId, index: b.index };
		marks.push({ mesh, material: m, base: m.color.clone(), seriesId: b.seriesId, index: b.index });
	}
	const ribbonThickness = layout.height * 0.02;
	for (const r of layout.ribbons) {
		if (r.points.length < 2) continue;
		const g = ribbonGeometry(r.points, r.z0, r.z1, r.kind, ribbonThickness);
		disposables.push(g);
		const m = material(r.color);
		const mesh = add(new THREE.Mesh(g, m));
		mesh.name = `${r.kind}-${r.seriesId}`;
		mesh.userData = { seriesId: r.seriesId };
		marks.push({ mesh, material: m, base: m.color.clone(), seriesId: r.seriesId, ribbon: r });
	}
	const fadeTo = color(theme.background === 'transparent' ? theme.surface : theme.background, '#ffffff');
	let focused: ChartSelection | null = null;

	// The camera: around the chart's centre, from the view's azimuth and elevation.
	const camera = new THREE.PerspectiveCamera(CHART_3D_FOV, Math.max(1e-3, options.width / options.height), 0.01, 1000);
	const centre = world(layout.width / 2, layout.height / 2, layout.depth / 2);
	const corners = [0, layout.width].flatMap((x) => [0, layout.height].flatMap((y) => [0, layout.depth + 0.2].map((z) => world(x, y, z))));
	let size = { width: options.width, height: options.height };
	const fit = () => {
		camera.aspect = Math.max(1e-3, size.width / size.height);
		const az = (layout.view.azimuth * Math.PI) / 180;
		const el = (layout.view.elevation * Math.PI) / 180;
		// Azimuth 0 looks straight at the front; it turns the chart to the right as it grows.
		const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
		const padding = options.padding ?? 0.12;
		// Step back until every corner of the chart's box is inside the frame, less the padding.
		let distance = Math.max(layout.width, layout.height, layout.depth);
		for (let i = 0; i < 40; i++) {
			camera.position.copy(centre).addScaledVector(dir, distance);
			camera.lookAt(centre);
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld();
			const worst = Math.max(...corners.map((c) => {
				const p = c.clone().project(camera);
				return Math.max(Math.abs(p.x), Math.abs(p.y));
			}));
			const limit = 1 - padding * 2;
			if (Math.abs(worst - limit) < 0.005) break;
			distance *= worst / limit;
		}
	};
	fit();

	const toScreen = (v: THREE.Vector3) => {
		const p = v.clone().project(camera);
		return { x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height };
	};
	const raycaster = new THREE.Raycaster();
	const focusedIndex = () => (focused?.kind === 'point' || focused?.kind === 'category' ? focused.index : null);
	return {
		scene,
		camera,
		layout,
		labels() {
			const out: Chart3dLabel[] = [];
			const at = focusedIndex();
			layout.categories.forEach((c, index) => {
				const p = toScreen(world(c.x, 0, -0.25));
				out.push({ kind: 'category', text: c.label, x: p.x, y: p.y + 4, anchor: 'middle', index, ...(at === index ? { focused: true } : {}) });
			});
			for (const t of layout.ticks) {
				const p = toScreen(world(0, t.y, layout.depth + 0.2));
				out.push({ kind: 'tick', text: t.label, x: p.x - 6, y: p.y, anchor: 'end' });
			}
			if (spec.title) out.push({ kind: 'title', text: spec.title, x: size.width / 2, y: Math.max(14, size.height * 0.05), anchor: 'middle' });
			return out;
		},
		resize(width, height) {
			size = { width, height };
			fit();
		},
		pick(x, y) {
			if (!(size.width > 0 && size.height > 0)) return null;
			scene.updateMatrixWorld();
			raycaster.setFromCamera(new THREE.Vector2((x / size.width) * 2 - 1, 1 - (y / size.height) * 2), camera);
			const hit = raycaster.intersectObjects(marks.map((m) => m.mesh), false)[0];
			if (!hit) return null;
			const mark = marks.find((m) => m.mesh === hit.object)!;
			if (mark.index !== undefined) return { kind: 'point', seriesId: mark.seriesId, index: mark.index };
			// A ribbon: the point nearest the hit along the categories (x is not mirrored).
			const points = mark.ribbon!.points;
			const nearest = points.reduce((best, p) => (Math.abs(p.x - hit.point.x) < Math.abs(best.x - hit.point.x) ? p : best), points[0]!);
			return { kind: 'point', seriesId: mark.seriesId, index: nearest.index };
		},
		focus(selection, options = {}) {
			focused = selection;
			const dim = Math.min(1, Math.max(0, options.dim ?? 0.7));
			for (const m of marks) {
				const lit = chart3dMarkInFocus(selection, m.seriesId, m.index);
				m.material.color.copy(m.base);
				if (!lit) m.material.color.lerp(fadeTo, dim);
			}
		},
		getFocus: () => focused,
		anchor(selection) {
			if (selection.kind !== 'point') return null;
			const box = layout.boxes.find((b) => b.seriesId === selection.seriesId && b.index === selection.index);
			if (box) return toScreen(world((box.x0 + box.x1) / 2, Math.max(box.y0, box.y1), (box.z0 + box.z1) / 2));
			const ribbon = layout.ribbons.find((r) => r.seriesId === selection.seriesId);
			const point = ribbon?.points.find((p) => p.index === selection.index);
			if (!ribbon || !point) return null;
			return toScreen(world(point.x, ribbon.kind === 'area' ? point.y : point.y + ribbonThickness / 2, (ribbon.z0 + ribbon.z1) / 2));
		},
		dispose() {
			for (const d of disposables) d.dispose();
		}
	};
}

export interface Chart3dRenderer {
	/** The chart's 3-D layout (for `nextChart3dFocus` and the like). */
	readonly layout: Chart3dLayout;
	/** Draws the chart once (call after a change; there is no animation loop). */
	render(): void;
	/** The canvas as a PNG data URL (call `render` first). */
	capture(): string;
	/**
	 * The chart drawn again at `scale` output pixels per CSS pixel, as a PNG data URL, leaving the
	 * canvas as it was. `compositeCapture` calls it through the canvas's capture source. Throws when
	 * the WebGL context is lost.
	 */
	captureAt(scale: number): string;
	/** The WebGL context is lost (the browser took it back); draw again once it is restored. */
	readonly contextLost: boolean;
	resize(width: number, height: number): void;
	/** The overlay labels for the current size. */
	labels(): Chart3dLabel[];
	/** The bar, or the line or area point, under (x, y) in CSS px, or null (see `Chart3dScene.pick`). */
	pick(x: number, y: number): Chart3dPick | null;
	/** Focuses a selection, dimming the rest; call `render` after (see `Chart3dScene.focus`). */
	focus(selection: ChartSelection | null, options?: Chart3dFocusOptions): void;
	getFocus(): ChartSelection | null;
	/** Where a tooltip for a point goes, in CSS px. */
	anchor(selection: ChartSelection): { x: number; y: number } | null;
	dispose(): void;
}

/**
 * Draws `spec` in 3-D on `canvas` with WebGL. Throws when the browser has no WebGL. The background
 * is the theme's (transparent when it is `transparent`); the picture keeps its drawing buffer so
 * `capture` works after `render`.
 */
export function renderChart3d(canvas: HTMLCanvasElement, spec: ChartSpec, options: Chart3dOptions & { pixelRatio?: number }): Chart3dRenderer {
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: theme.background === 'transparent', preserveDrawingBuffer: true });
	renderer.setPixelRatio(options.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1));
	renderer.setSize(options.width, options.height, false);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	if (theme.background !== 'transparent') renderer.setClearColor(color(theme.background, '#ffffff'), 1);
	const view = createChart3dScene(spec, options);
	let size = { width: options.width, height: options.height };
	let lost = false;
	const onLost = (event: Event) => {
		event.preventDefault();
		lost = true;
	};
	const onRestored = () => {
		lost = false;
	};
	canvas.addEventListener('webglcontextlost', onLost);
	canvas.addEventListener('webglcontextrestored', onRestored);
	const captureAt = (scale: number) => {
		if (lost || renderer.getContext().isContextLost()) throw new Error('The 3-D chart lost its WebGL context; draw it again once the context is restored.');
		const ratio = renderer.getPixelRatio();
		renderer.setPixelRatio(scale);
		renderer.setSize(size.width, size.height, false);
		renderer.render(view.scene, view.camera);
		const url = canvas.toDataURL('image/png');
		renderer.setPixelRatio(ratio);
		renderer.setSize(size.width, size.height, false);
		renderer.render(view.scene, view.camera);
		return url;
	};
	const unregister = registerCaptureSource(canvas, ({ scale }) => {
		if (lost || renderer.getContext().isContextLost()) return { lost: true, reason: 'the browser took it back' };
		return captureAt(scale);
	});
	return {
		layout: view.layout,
		render: () => renderer.render(view.scene, view.camera),
		capture: () => canvas.toDataURL('image/png'),
		captureAt,
		get contextLost() {
			return lost || renderer.getContext().isContextLost();
		},
		resize(width, height) {
			size = { width, height };
			renderer.setSize(width, height, false);
			view.resize(width, height);
		},
		labels: () => view.labels(),
		pick: (x, y) => view.pick(x, y),
		focus: (selection, focusOptions) => view.focus(selection, focusOptions),
		getFocus: () => view.getFocus(),
		anchor: (selection) => view.anchor(selection),
		dispose() {
			unregister();
			canvas.removeEventListener('webglcontextlost', onLost);
			canvas.removeEventListener('webglcontextrestored', onRestored);
			view.dispose();
			renderer.dispose();
		}
	};
}

/**
 * Draws `spec` in 3-D as a PNG with its labels (browser only: WebGL and a 2-D canvas), e.g. for
 * the chart tools' `render3d` hook. Returns the base64 PNG without the `data:` prefix.
 */
export function renderChart3dImage(spec: ChartSpec, options: Chart3dOptions & { pixelRatio?: number; document?: Document }): { data: string; mimeType: 'image/png' } {
	const doc = options.document ?? globalThis.document;
	if (!doc) throw new Error('renderChart3dImage needs a browser document (WebGL and a 2-D canvas).');
	const ratio = options.pixelRatio ?? 2;
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const gl = doc.createElement('canvas');
	gl.width = Math.round(options.width * ratio);
	gl.height = Math.round(options.height * ratio);
	const view = renderChart3d(gl, spec, { ...options, pixelRatio: ratio });
	try {
		view.render();
		const out = doc.createElement('canvas');
		out.width = gl.width;
		out.height = gl.height;
		const ctx = out.getContext('2d');
		if (!ctx) throw new Error('renderChart3dImage could not get a 2-D canvas context.');
		ctx.drawImage(gl, 0, 0);
		ctx.scale(ratio, ratio);
		ctx.textBaseline = 'middle';
		for (const l of view.labels()) {
			ctx.font = l.kind === 'title' ? '600 15px system-ui, sans-serif' : '12px system-ui, sans-serif';
			ctx.fillStyle = l.kind === 'tick' ? theme.mutedText : theme.text;
			ctx.textAlign = l.anchor === 'middle' ? 'center' : l.anchor === 'end' ? 'right' : 'left';
			ctx.fillText(l.text, l.x, l.y);
		}
		return { data: out.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), mimeType: 'image/png' };
	} finally {
		view.dispose();
	}
}

export { layoutChart3d, CHART_3D_TYPES, chart3dMarkSeries, chart3dMarkInFocus, nextChart3dFocus, type Chart3dLayout, type Chart3dBox, type Chart3dRibbon } from '../chart/layout3d.js';
export { describeChartSelectionIn } from '../chart/interaction.js';
export { chartTooltipFor, type ChartTooltip } from '../chart/tooltip.js';
