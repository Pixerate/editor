/**
 * Specialty brushes: reactive and simulated paint (ferrofluid, UV-fluorescent and thermochromic
 * ink, thin-film iridescence, ghost paint, mutation paint, live reaction-diffusion patterns) that
 * only shows its effect when the canvas environment is set up for it (magnets, the UV blacklight,
 * heat, a tilted view, an agent). `BRUSH_SPECIALTIES` describes each kind; `brushSpecialties`
 * names the kinds a facet brush has. Plain data with no renderer, so library browsers, the brush
 * editor, the paint editor's guides and other implementations (`ui.json`) share it.
 */

import type { Brush } from './types';

/** A kind of specialty paint, by the facet that makes it. */
export type BrushSpecialtyKind = 'ferro' | 'fluorescence' | 'thermochromic' | 'iridescence' | 'ghost' | 'mutation' | 'livePatterns';

/** One specialty kind, as the library browser, brush editor and guides describe it. */
export interface BrushSpecialtyInfo {
  id: BrushSpecialtyKind;
  /** Display name (`Ferrofluid`, `UV-fluorescent ink`…). */
  label: string;
  /** The library browser's sub-group heading (`Ferrofluid`, `UV-fluorescent`…). */
  group: string;
  /** One line on what the paint does, for the brush editor. */
  summary: string;
  /** How to paint with it and which canvas controls bring the effect out. */
  howToUse: string;
}

/** Every specialty kind, in the order the library, editor and guides list them. */
export const BRUSH_SPECIALTIES: readonly BrushSpecialtyInfo[] = [
  {
    id: 'ferro',
    label: 'Ferrofluid',
    group: 'Ferrofluid',
    summary: 'Lays liquid magnetic paint that magnets pull into glossy 3D spikes.',
    howToUse: 'Paint a pool of ferrofluid, then add a magnet near it: the liquid flows toward the magnet and rises into Rosensweig spikes. Move or retune magnets to reshape them, and cure the spikes to keep them as permanent relief.',
  },
  {
    id: 'fluorescence',
    label: 'UV-fluorescent ink',
    group: 'UV-fluorescent',
    summary: 'Glows in its own colour under the UV blacklight.',
    howToUse: 'Paint as usual, then switch the UV blacklight on: the room dims and fluorescent strokes glow and spill light in their colour. Invisible ink lays nothing you can see in daylight, so it only shows under UV.',
  },
  {
    id: 'thermochromic',
    label: 'Thermochromic ink',
    group: 'Thermochromic',
    summary: 'Shifts toward its hot colour where the canvas is warm.',
    howToUse: 'Paint with the ink, then warm the canvas: where the heat passes the ink’s threshold it shifts toward its hot colour. Step the heat to let it spread and cool, or cool the canvas to bring the cold colour back.',
  },
  {
    id: 'iridescence',
    label: 'Thin-film iridescence',
    group: 'Iridescence',
    summary: 'A thin film whose interference colours shift with the viewing angle.',
    howToUse: 'Paint a coat, then tilt the view (or move the light, or turn on device tilt): the film’s interference colours sweep across the spectrum as the angle changes. Pressure varies the film thickness on brushes that follow it.',
  },
  {
    id: 'ghost',
    label: 'Ghost paint',
    group: 'Ghost paint',
    summary: 'Wet paint that smears what it touches, then fades away.',
    howToUse: 'Drag it through wet or dried paint on the layer: it pushes and lifts that paint while its own colour shows, then its pigment fades away and only the smear stays. Invisible ink is a ghost paint with no colour of its own.',
  },
  {
    id: 'mutation',
    label: 'Mutation paint',
    group: 'Mutation paint',
    summary: 'Your stroke sinks away once an agent claims it and paints its answer.',
    howToUse: 'Paint a mark and pause: after a moment it becomes a mutation request. A connected agent claims it, your paint sinks away and the agent paints its answer. With no agent connected the stroke stays as ordinary paint.',
  },
  {
    id: 'livePatterns',
    label: 'Live patterns',
    group: 'Live patterns',
    summary: 'Reaction-diffusion patterns grow in the wet paint and freeze as it dries.',
    howToUse: 'Paint a wet wash: spots, stripes, coral, maze or worm patterns grow inside it while it is wet and freeze where it dries. Seed the pattern to start growth in a spot, and keep wet time running so it develops.',
  },
];

/** The specialty kinds a facet brush has, in `BRUSH_SPECIALTIES` order (empty for standard brushes and tools). */
export function brushSpecialties(brush: Brush): BrushSpecialtyKind[] {
  if (brush.kind === 'tool') return [];
  const has: Record<BrushSpecialtyKind, boolean> = {
    ferro: (brush.ferro?.amount ?? 0) > 0,
    fluorescence: (brush.fluorescence?.amount ?? 0) > 0,
    thermochromic: brush.thermochromic !== undefined,
    iridescence: brush.iridescence !== undefined,
    ghost: brush.ghost !== undefined,
    mutation: brush.mutation !== undefined,
    livePatterns: brush.livePatterns !== undefined && (brush.livePatterns.pattern as string | undefined) !== 'none',
  };
  return BRUSH_SPECIALTIES.map((s) => s.id).filter((id) => has[id]);
}

/** Whether a brush is a specialty brush (it has at least one `brushSpecialties` kind). */
export function isSpecialtyBrush(brush: Brush): boolean {
  return brushSpecialties(brush).length > 0;
}

/** The description of one specialty kind. */
export function brushSpecialtyInfo(kind: BrushSpecialtyKind): BrushSpecialtyInfo {
  return BRUSH_SPECIALTIES.find((s) => s.id === kind)!;
}
