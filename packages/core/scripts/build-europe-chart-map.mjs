#!/usr/bin/env node
// Builds src/chart-maps/europe.ts, the Europe outlines for choropleth charts, from Natural Earth's
// 1:50m countries as packaged in world-atlas@2.0.2 (countries-50m.json, TopoJSON). Natural Earth is
// in the public domain; world-atlas is ISC-licensed. The generated file is committed, so building
// the package needs neither the download nor this script.
//
//   node scripts/build-europe-chart-map.mjs path/to/countries-50m.json
//
// Steps: decode the TopoJSON arcs; project every arc once (Lambert azimuthal equal-area centred on
// 10°E 52°N, as Eurostat's ETRS89-LAEA maps are) and simplify it once, so neighbouring countries
// keep sharing the same simplified border; build each country's rings from its arcs; clip them to
// a frame from Iceland to the Caucasus and from Cyprus to the North Cape; write SVG path data in a
// 1000-unit-wide box, rounded to 0.1.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
	console.error('Usage: node scripts/build-europe-chart-map.mjs path/to/countries-50m.json');
	process.exit(1);
}
const topology = JSON.parse(readFileSync(input, 'utf8'));

/** ISO 3166-1 numeric (as world-atlas keys countries) → alpha-3; Kosovo has no numeric code and is matched by name. */
const COUNTRIES = {
	'008': 'ALB', '020': 'AND', '040': 'AUT', '031': 'AZE', '051': 'ARM', '056': 'BEL', '070': 'BIH', '100': 'BGR', '112': 'BLR',
	'191': 'HRV', '196': 'CYP', '203': 'CZE', '208': 'DNK', '233': 'EST', '234': 'FRO', '246': 'FIN', '248': 'ALA', '250': 'FRA',
	'268': 'GEO', '276': 'DEU', '300': 'GRC', '336': 'VAT', '348': 'HUN', '352': 'ISL', '372': 'IRL', '380': 'ITA', '428': 'LVA',
	'438': 'LIE', '440': 'LTU', '442': 'LUX', '470': 'MLT', '492': 'MCO', '498': 'MDA', '499': 'MNE', '528': 'NLD', '578': 'NOR',
	'616': 'POL', '620': 'PRT', '642': 'ROU', '643': 'RUS', '674': 'SMR', '688': 'SRB', '703': 'SVK', '705': 'SVN', '724': 'ESP',
	'752': 'SWE', '756': 'CHE', '792': 'TUR', '804': 'UKR', '807': 'MKD', '826': 'GBR'
};
const BY_NAME = { Kosovo: 'XKX' };
/** Names as people write them (Natural Earth abbreviates some). */
const NAMES = {
	BIH: 'Bosnia and Herzegovina', CZE: 'Czechia', MKD: 'North Macedonia', VAT: 'Vatican City', ALA: 'Åland', FRO: 'Faroe Islands',
	GBR: 'United Kingdom', RUS: 'Russia', MDA: 'Moldova', XKX: 'Kosovo'
};

// ---- Projection: spherical Lambert azimuthal equal-area.
const rad = Math.PI / 180;
const lon0 = 10 * rad;
const lat0 = 52 * rad;
const project = ([lon, lat]) => {
	const l = lon * rad - lon0;
	const p = lat * rad;
	const k = Math.sqrt(2 / (1 + Math.sin(lat0) * Math.sin(p) + Math.cos(lat0) * Math.cos(p) * Math.cos(l)));
	return [k * Math.cos(p) * Math.sin(l), -k * (Math.cos(lat0) * Math.sin(p) - Math.sin(lat0) * Math.cos(p) * Math.cos(l))];
};

// The frame: the projected box round these places.
const frameAt = [[-24.5, 63.3], [-25, 66.6], [-10, 36], [-9.5, 43], [14, 34.6], [34.6, 34.5], [36, 36], [50.5, 41.5], [45, 39], [45, 71], [31, 71.3], [25.8, 71.2]].map(project);
const pad = 0.012;
const minX = Math.min(...frameAt.map((p) => p[0])) - pad;
const maxX = Math.max(...frameAt.map((p) => p[0])) + pad;
const minY = Math.min(...frameAt.map((p) => p[1])) - pad;
const maxY = Math.max(...frameAt.map((p) => p[1])) + pad;
const WIDTH = 1000;
const scale = WIDTH / (maxX - minX);
const HEIGHT = Math.round((maxY - minY) * scale);
const toBox = ([x, y]) => [(x - minX) * scale, (y - minY) * scale];

// ---- Decode and project the arcs. The projection is continuous everywhere but the point opposite
// its centre (in the southern Pacific), so far-away coastlines land outside the box and clipping
// trims them without false edges, and the antimeridian needs no special care.
const [sx, sy] = topology.transform.scale;
const [tx, ty] = topology.transform.translate;
const arcs = topology.arcs.map((arc) => {
	let x = 0;
	let y = 0;
	return arc.map(([dx, dy]) => {
		x += dx;
		y += dy;
		return toBox(project([x * sx + tx, y * sy + ty]));
	});
});

// Douglas–Peucker, once per arc (tolerance in box units).
const TOLERANCE = 0.45;
function simplify(points) {
	if (points.length <= 2) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = keep[points.length - 1] = 1;
	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop();
		const [ax, ay] = points[a];
		const [bx, by] = points[b];
		const len = Math.hypot(bx - ax, by - ay);
		let worst = -1;
		let at = -1;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = points[i];
			// A closed arc (an island) starts and ends at one point: measure from that point instead.
			const d = len < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
			if (d > worst) [worst, at] = [d, i];
		}
		if (worst > TOLERANCE) {
			keep[at] = 1;
			stack.push([a, at], [at, b]);
		}
	}
	return points.filter((_, i) => keep[i]);
}
const simple = arcs.map(simplify);
const arcPoints = (i) => (i >= 0 ? simple[i] : [...simple[~i]].reverse());
const ringOf = (indexes) => indexes.flatMap((i, k) => (k ? arcPoints(i).slice(1) : arcPoints(i)));

// ---- Clip a ring to the box (Sutherland–Hodgman against each edge).
function clip(ring) {
	const edges = [
		(p) => p[0] >= 0, (p) => p[0] <= WIDTH, (p) => p[1] >= 0, (p) => p[1] <= HEIGHT
	];
	const cross = [
		(a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])],
		(a, b) => [WIDTH, a[1] + ((b[1] - a[1]) * (WIDTH - a[0])) / (b[0] - a[0])],
		(a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0],
		(a, b) => [a[0] + ((b[0] - a[0]) * (HEIGHT - a[1])) / (b[1] - a[1]), HEIGHT]
	];
	let out = ring;
	edges.forEach((inside, e) => {
		const next = [];
		for (let i = 0; i < out.length; i++) {
			const cur = out[i];
			const prev = out[(i + out.length - 1) % out.length];
			if (inside(cur)) {
				if (!inside(prev)) next.push(cross[e](prev, cur));
				next.push(cur);
			} else if (inside(prev)) next.push(cross[e](prev, cur));
		}
		out = next;
	});
	return out;
}

const area = (ring) => ring.reduce((t, [x, y], i) => {
	const [nx, ny] = ring[(i + 1) % ring.length];
	return t + x * ny - nx * y;
}, 0) / 2;
const fmt = (n) => String(Math.round(n * 10) / 10);
const pathOf = (rings) => rings.map((r) => `M${r.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join('L')}Z`).join('');

function ringsOf(geometry) {
	const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.type === 'MultiPolygon' ? geometry.arcs : [];
	const rings = [];
	for (const polygon of polygons) for (const r of polygon) {
		const ring = clip(ringOf(r));
		if (ring.length >= 3 && Math.abs(area(ring)) > 0.02) rings.push(ring);
	}
	return rings;
}

const regions = [];
for (const g of topology.objects.countries.geometries) {
	const id = COUNTRIES[g.id] ?? BY_NAME[g.properties.name];
	if (!id) continue;
	const rings = ringsOf(g);
	if (!rings.length) {
		console.warn(`${id} has no outline left after simplifying; it is drawn as a marker.`);
	}
	// The label point: the centre of the largest ring's box (good enough for markers and value labels).
	const all = rings.length ? rings : [];
	const biggest = all.reduce((b, r) => (Math.abs(area(r)) > Math.abs(area(b ?? [])) ? r : b), null);
	const box = (r) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))];
	let center;
	if (biggest) {
		const [x0, y0, x1, y1] = box(biggest);
		center = [(x0 + x1) / 2, (y0 + y1) / 2];
	} else {
		// A microstate too small for an outline: its unsimplified arcs give the spot.
		const pts = (g.type === 'Polygon' ? [g.arcs] : g.arcs).flat(2).flatMap((i) => (i >= 0 ? arcs[i] : arcs[~i]));
		center = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
	}
	regions.push({ id, name: NAMES[id] ?? g.properties.name, d: pathOf(rings), center: center.map((v) => Number(fmt(v))), area: Math.round(rings.reduce((t, r) => t + Math.abs(area(r)), 0)) });
}
regions.sort((a, b) => a.name.localeCompare(b.name));

// Everything else in the frame (North Africa, the Middle East, Greenland's edge) as one background path.
const used = new Set(topology.objects.countries.geometries.filter((g) => COUNTRIES[g.id] ?? BY_NAME[g.properties.name]).map((g) => g));
const land = topology.objects.countries.geometries.filter((g) => !used.has(g)).flatMap(ringsOf);

const body = `// Generated by scripts/build-europe-chart-map.mjs from Natural Earth 1:50m countries (public domain,
// https://www.naturalearthdata.com) as packaged in world-atlas@2.0.2. Do not edit by hand.
import type { ChartMapGeometry } from '../chart/maps.js';

/**
 * Europe, from Iceland to the Caucasus and from Cyprus to the North Cape, in Lambert azimuthal
 * equal-area (centred on 10°E 52°N) within a ${WIDTH} × ${HEIGHT} box. Regions are countries keyed by
 * ISO 3166-1 alpha-3 code (Kosovo: XKX). Register it with \`registerChartMap(EUROPE_CHART_MAP)\`.
 */
export const EUROPE_CHART_MAP: ChartMapGeometry = {
	id: 'europe',
	name: 'Europe',
	width: ${WIDTH},
	height: ${HEIGHT},
	attribution: 'Made with Natural Earth',
	land: ${JSON.stringify(pathOf(land))},
	regions: [
${regions.map((r) => `\t\t{ id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, center: [${r.center.join(', ')}], area: ${r.area}, d: ${JSON.stringify(r.d)} }`).join(',\n')}
	]
};
`;
const out = path.join(root, 'src/chart-maps/europe.ts');
writeFileSync(out, body);
console.log(`Wrote ${path.relative(root, out)}: ${regions.length} regions, ${(body.length / 1024).toFixed(0)} KB, ${WIDTH} × ${HEIGHT}.`);
