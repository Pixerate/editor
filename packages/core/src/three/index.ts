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
import { chartContrastRatio } from '../chart/color.js';
import { chart3dMarkInFocus, layoutChart3d, type Chart3dLayout } from '../chart/layout3d.js';
import { layoutChartParticles, settleFrame, type ChartParticlesLayout, type ChartParticlesOptions } from '../chart/particles.js';
import { chart3dStyleColors, resolveChart3dStyle, type Chart3dMaterial, type Chart3dStyle, type Chart3dStyleInput } from '../chart/style3d.js';
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
	/**
	 * House style for 3-D (#810): the chart profile's `three` section (materials, light preset,
	 * shadows, contact darkening, background). Absent: the defaults, unchanged from unstyled 3-D.
	 */
	style?: Chart3dStyleInput;
	/**
	 * Draw the first series as particles (#806) instead of bars: each category a layer of grains
	 * that settle on top of each other, one grain per `unit`. `setProgress` drops them in.
	 */
	particles?: ChartParticlesOptions & { /** An outline of the container (default true). */ outline?: boolean };
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
export type Chart3dPick = Extract<ChartSelection, { kind: 'point' }> & { /** With particles: the grain under the pointer. */ instance?: number };

export interface Chart3dFocusOptions {
	/** How far marks out of focus fade towards the background, 0–1 (default 0.7). */
	dim?: number;
}

export interface Chart3dScene {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	layout: Chart3dLayout;
	/** The 3-D style in use, every part resolved. */
	style: Chart3dStyle;
	/** The colour behind the chart (the style's, else the theme's). */
	background: string;
	/** With `particles`: the pile (which category each layer is, the settled grains, the notes). */
	particles?: ChartParticlesLayout;
	/** With `particles`: drops the grains in to progress `p` (frame-pure; 1 at rest). Takes effect on the next render. */
	setProgress(p: number): void;
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
	const pile = options.particles ? layoutChartParticles(spec, options.particles) : undefined;
	const base3d = layoutChart3d(spec);
	// Particles: the container takes the bars' place; the camera fits it and the pile above it.
	const layout = pile
		? (() => {
				const { width, depth } = pile.settled.container;
				const top = pile.settled.levels * pile.settled.cell;
				return { ...base3d, width, depth, height: Math.max(top * 1.15, width * 0.4), boxes: [], ribbons: [], ticks: [], categories: [], warnings: pile.notes };
			})()
		: base3d;
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
	const style = resolveChart3dStyle(options.style);
	const surfaces = chart3dStyleColors(style, theme);
	const material = (css: string, look: Chart3dMaterial = style.materials.mark) => {
		const params = { color: color(css, '#888888'), roughness: look.roughness, metalness: look.metalness, ...(look.opacity < 1 ? { transparent: true, opacity: look.opacity } : {}) };
		const m = look.transmission > 0 ? new THREE.MeshPhysicalMaterial({ ...params, transmission: look.transmission, thickness: 0.2 }) : new THREE.MeshStandardMaterial(params);
		disposables.push(m);
		return m;
	};

	// Light from the style's preset (default studio: a soft key from the upper left and a sky / ground fill).
	const k = style.light.intensity;
	const keyPosition =
		style.light.azimuth !== undefined || style.light.elevation !== undefined
			? (() => {
					const az = ((style.light.azimuth ?? -45) * Math.PI) / 180;
					const el = ((style.light.elevation ?? 55) * Math.PI) / 180;
					const r = layout.width + layout.height + layout.depth * 3;
					return world(layout.width / 2 + Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, layout.depth / 2 - Math.cos(az) * Math.cos(el) * r);
				})()
			: world(-layout.width, layout.height * 2.5, -(layout.depth * 3 + layout.width));
	const preset = style.light.preset;
	const [fill, keyStrength] = preset === 'soft' ? [2.2, 0.6] : preset === 'rim' ? [0.9, 1] : preset === 'flat' ? [0, 0] : [1.6, 1.4];
	if (preset === 'flat') scene.add(new THREE.AmbientLight(0xffffff, 3 * k));
	else scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, fill * k));
	const key = new THREE.DirectionalLight(0xffffff, keyStrength * k);
	key.position.copy(keyPosition);
	scene.add(key);
	// A key from a chosen direction aims at the chart's centre; the default keeps aiming at the
	// origin, as unstyled 3-D always has.
	if (style.light.azimuth !== undefined || style.light.elevation !== undefined || style.shadow.enabled) {
		key.target.position.copy(world(layout.width / 2, 0, layout.depth / 2));
		scene.add(key.target);
	}
	if (preset === 'rim') {
		const rim = new THREE.DirectionalLight(0xffffff, 1.6 * k);
		rim.position.copy(world(layout.width * 0.8, layout.height * 1.5, layout.depth * 4 + layout.width));
		scene.add(rim);
	}
	if (style.shadow.enabled && preset !== 'flat') {
		key.castShadow = true;
		key.shadow.mapSize.set(2048, 2048);
		key.shadow.radius = 1 + style.shadow.softness * 8;
		key.shadow.bias = -0.0005;
		const span = Math.max(layout.width, layout.height, layout.depth) * 1.5;
		Object.assign(key.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.1, far: span * 8 });
	}

	// Floor and back wall, with the value gridlines on the wall.
	const floorGeometry = new THREE.PlaneGeometry(layout.width, layout.depth + 0.4);
	disposables.push(floorGeometry);
	const floor = add(new THREE.Mesh(floorGeometry, material(surfaces.floor, style.materials.floor)));
	floor.rotation.x = -Math.PI / 2;
	floor.position.set(layout.width / 2, 0, (layout.depth + 0.4) / 2 - 0.2);
	floor.receiveShadow = style.shadow.enabled;
	const wallGeometry = new THREE.PlaneGeometry(layout.width, layout.height);
	disposables.push(wallGeometry);
	const wallMaterial = material(surfaces.wall, style.materials.wall);
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
		const m = material(b.color, style.materials.mark);
		const mesh = add(new THREE.Mesh(g, m));
		mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
		mesh.castShadow = style.shadow.enabled;
		if (style.ambientOcclusion && b.y0 <= 1e-6) {
			// Contact darkening: a soft dark footprint, a little larger than the bar, just above the floor.
			const pad = Math.min(b.x1 - b.x0, b.z1 - b.z0) * 0.35;
			const cg = new THREE.PlaneGeometry(b.x1 - b.x0 + pad * 2, b.z1 - b.z0 + pad * 2);
			const cm = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false });
			disposables.push(cg, cm);
			const contact = add(new THREE.Mesh(cg, cm));
			contact.rotation.x = -Math.PI / 2;
			contact.position.set((b.x0 + b.x1) / 2, 0.002, (b.z0 + b.z1) / 2);
			contact.name = `contact-${b.seriesId}-${b.index}`;
		}
		mesh.name = `bar-${b.seriesId}-${b.index}`;
		mesh.userData = { seriesId: b.seriesId, index: b.index };
		marks.push({ mesh, material: m, base: m.color.clone(), seriesId: b.seriesId, index: b.index });
	}
	const ribbonThickness = layout.height * 0.02;
	for (const r of layout.ribbons) {
		if (r.points.length < 2) continue;
		const g = ribbonGeometry(r.points, r.z0, r.z1, r.kind, ribbonThickness);
		disposables.push(g);
		const m = material(r.color, style.materials.ribbon);
		const mesh = add(new THREE.Mesh(g, m));
		mesh.name = `${r.kind}-${r.seriesId}`;
		mesh.castShadow = style.shadow.enabled;
		mesh.userData = { seriesId: r.seriesId };
		marks.push({ mesh, material: m, base: m.color.clone(), seriesId: r.seriesId, ribbon: r });
	}
	// Particles: one instanced mesh, a colour per grain from its layer, matrices from the frame.
	let grains: THREE.InstancedMesh | null = null;
	const grainBase: THREE.Color[] = [];
	const setProgress = (p: number) => {
		if (!grains || !pile) return;
		const frame = settleFrame(pile.settled, p);
		const m = new THREE.Matrix4();
		for (let i = 0; i < pile.settled.count; i++) {
			const sc = frame.visible[i] ? 1 : 0;
			m.makeScale(sc, sc, sc);
			m.setPosition(frame.positions[i * 3]!, frame.positions[i * 3 + 1]!, frame.positions[i * 3 + 2]!);
			grains.setMatrixAt(i, m);
		}
		grains.instanceMatrix.needsUpdate = true;
		grains.computeBoundingSphere();
	};
	if (pile) {
		const r = pile.settled.size / 2;
		const g = new THREE.SphereGeometry(r, 12, 8);
		const m = material('#ffffff', style.materials.mark);
		disposables.push(g);
		grains = add(new THREE.InstancedMesh(g, m, Math.max(1, pile.settled.count)));
		grains.count = pile.settled.count;
		grains.name = 'particles';
		grains.castShadow = style.shadow.enabled;
		for (let i = 0; i < pile.settled.count; i++) {
			const c = color(pile.settled.layers[pile.settled.layerOf[i]!]!.color ?? '#888888', '#888888');
			grainBase.push(c);
			grains.setColorAt(i, c);
		}
		if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
		setProgress(1);
		if (options.particles?.outline !== false) {
			const { width, depth } = pile.settled.container;
			const h = Math.max(pile.settled.levels * pile.settled.cell, pile.settled.cell);
			const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(width, h, depth));
			const em = new THREE.LineBasicMaterial({ color: color(theme.axis, '#999999'), transparent: true, opacity: 0.6 });
			disposables.push(eg, em);
			const box = add(new THREE.LineSegments(eg, em));
			box.position.set(width / 2, h / 2, depth / 2);
			box.name = 'outline';
		}
	}
	const fadeTo = color(surfaces.background, '#ffffff');
	const glow = style.materials.highlight.color ? color(style.materials.highlight.color, '#ffffff') : null;
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
		style,
		background: surfaces.background,
		...(pile ? { particles: pile } : {}),
		setProgress,
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
			if (pile) {
				// A label beside each layer, at the middle of its band, on the right of the container.
				pile.settled.layers.forEach((l, k) => {
					if (!l.count) return;
					const index = pile.categories[k]!;
					const p = toScreen(world(layout.width + 0.08, (l.bottom + l.top) / 2, layout.depth / 2));
					out.push({ kind: 'category', text: pile.labels[k]!, x: p.x + 6, y: p.y, anchor: 'start', index, ...(at === index ? { focused: true } : {}) });
				});
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
			const targets: THREE.Object3D[] = marks.map((m) => m.mesh);
			if (grains) targets.push(grains);
			const hit = raycaster.intersectObjects(targets, false)[0];
			if (!hit) return null;
			if (grains && hit.object === grains && pile && hit.instanceId !== undefined) {
				const index = pile.categories[pile.settled.layerOf[hit.instanceId]!]!;
				return { kind: 'point', seriesId: pile.seriesId, index, instance: hit.instanceId };
			}
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
				// The house highlight glows on focused marks.
				m.material.emissive.setRGB(0, 0, 0);
				if (glow && selection && lit) m.material.emissive.copy(glow).multiplyScalar(style.materials.highlight.intensity);
			}
			if (grains && pile) {
				const c = new THREE.Color();
				for (let i = 0; i < pile.settled.count; i++) {
					const lit = chart3dMarkInFocus(selection, pile.seriesId, pile.categories[pile.settled.layerOf[i]!]);
					c.copy(grainBase[i]!);
					if (!lit) c.lerp(fadeTo, dim);
					else if (glow && selection) c.lerp(glow, style.materials.highlight.intensity * 0.5);
					grains.setColorAt(i, c);
				}
				if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
			}
		},
		getFocus: () => focused,
		anchor(selection) {
			if (selection.kind !== 'point') return null;
			if (pile) {
				const k = pile.categories.indexOf(selection.index);
				const l = pile.settled.layers[k];
				if (selection.seriesId !== pile.seriesId || !l || !l.count) return null;
				// A grain of the layer where it is seen: the front row, near the middle and the band's middle.
				const pos = pile.settled.positions;
				const mid = (l.bottom + l.top) / 2;
				let best = l.start;
				let score = Infinity;
				for (let i = l.start; i < l.start + l.count; i++) {
					const sc = pos[i * 3 + 2]! * 4 + Math.abs(pos[i * 3]! - layout.width / 2) + Math.abs(pos[i * 3 + 1]! - mid) * 0.5;
					if (sc < score) {
						score = sc;
						best = i;
					}
				}
				return toScreen(world(pos[best * 3]!, pos[best * 3 + 1]!, pos[best * 3 + 2]!));
			}
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

/** A label that doesn't read on what is drawn behind it. */
export interface Chart3dLabelContrastFinding {
	label: Chart3dLabel;
	/** The colour sampled behind the label, and the text colour. */
	behind: string;
	text: string;
	ratio: number;
}

/**
 * The house-style check on the rendered picture (#810): each overlay label's text colour against
 * the colour behind it, which `sample(x, y)` reads from a capture of the canvas (for example the
 * pixels of `compositeCapture` or `captureAt`, without the labels). Labels below `minRatio` (default
 * 4.5) come back; titles count as large text (3).
 */
export function checkChart3dLabelContrast(labels: readonly Chart3dLabel[], sample: (x: number, y: number) => string | null, theme: Partial<Pick<ChartTheme, 'text' | 'mutedText'>> = {}, minRatio = 4.5): Chart3dLabelContrastFinding[] {
	const out: Chart3dLabelContrastFinding[] = [];
	for (const label of labels) {
		const behind = sample(label.x, label.y);
		if (!behind) continue;
		const text = label.kind === 'tick' ? (theme.mutedText ?? DEFAULT_CHART_THEME.mutedText) : (theme.text ?? DEFAULT_CHART_THEME.text);
		const ratio = chartContrastRatio(text, behind);
		const want = label.kind === 'title' ? Math.min(3, minRatio) : minRatio;
		if (ratio !== null && ratio < want) out.push({ label, behind, text, ratio: Math.round(ratio * 100) / 100 });
	}
	return out;
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
	/** With particles: drops the grains in to progress `p`; call `render` after. */
	setProgress(p: number): void;
	dispose(): void;
}

/**
 * Draws `spec` in 3-D on `canvas` with WebGL. Throws when the browser has no WebGL. The background
 * is the theme's (transparent when it is `transparent`); the picture keeps its drawing buffer so
 * `capture` works after `render`.
 */
export function renderChart3d(canvas: HTMLCanvasElement, spec: ChartSpec, options: Chart3dOptions & { pixelRatio?: number }): Chart3dRenderer {
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: theme.background === 'transparent' && !options.style?.background, preserveDrawingBuffer: true });
	renderer.setPixelRatio(options.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1));
	renderer.setSize(options.width, options.height, false);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	const view = createChart3dScene(spec, options);
	if (view.style.background || theme.background !== 'transparent') renderer.setClearColor(color(view.background, '#ffffff'), 1);
	if (view.style.shadow.enabled) {
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	}
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
		setProgress: (p) => view.setProgress(p),
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

export { resolveChart3dStyle, chart3dStyleColors, DEFAULT_CHART_3D_STYLE, CHART_3D_LIGHT_PRESETS, CHART_3D_STYLE_VERSION, type Chart3dStyle, type Chart3dStyleInput, type Chart3dMaterial } from '../chart/style3d.js';
export { settleParticles, settleFrame, layoutChartParticles, type SettledParticles, type SettledLayer, type ChartParticlesLayout, type ChartParticlesOptions } from '../chart/particles.js';
export { layoutChart3d, CHART_3D_TYPES, chart3dMarkSeries, chart3dMarkInFocus, nextChart3dFocus, type Chart3dLayout, type Chart3dBox, type Chart3dRibbon } from '../chart/layout3d.js';
export { describeChartSelectionIn } from '../chart/interaction.js';
export { chartTooltipFor, type ChartTooltip } from '../chart/tooltip.js';
