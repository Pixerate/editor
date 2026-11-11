/**
 * The built-in brushes as facet specs. The paint editor's built-in library (`BUILTIN_BRUSHES`)
 * is these, resolved (`resolveBrush`), so a preset is written only here; the committed brush
 * contracts (`resolved.json`) catch a change in what one paints. Medium and variety file
 * each brush under what it is for browsing and filtering. Only what differs from the engine's
 * defaults is written down.
 *
 * Our own settings; none come from another product.
 */

import type { Brush } from './types';

/** The built-in brush library, in the paint editor's order. */
export const BRUSH_PRESETS: readonly Brush[] = [
  {
    id: 'pencil-hb', name: 'HB pencil', kind: 'mark', medium: 'dry', variety: 'pencil', family: 'dry',
    tip: { shape: 'round', size: 4, hardness: 0.7, spacing: 0.08, opacity: 0.85, flow: 0.55 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, pressureSmoothing: 0.3, minSize: 0.55, tiltSize: 0.9, tiltRoundness: 0.7, tiltOpacity: 0.5 },
    behaviour: { grain: 0.85 },
  },
  {
    id: 'pencil-6b', name: '6B pencil', kind: 'mark', medium: 'dry', variety: 'pencil', family: 'dry',
    tip: { shape: 'round', size: 7, hardness: 0.55, spacing: 0.07, flow: 0.75 },
    dynamics: { smoothing: 0.2, pressureOpacity: true, pressureSmoothing: 0.3, minSize: 0.5, tiltSize: 1, tiltRoundness: 0.75, tiltOpacity: 0.35 },
    behaviour: { grain: 0.7 },
  },
  {
    id: 'soft-pastel', name: 'Soft pastel', kind: 'mark', medium: 'dry', variety: 'soft-pastel', family: 'dry',
    tip: { shape: 'flat', size: 32, hardness: 0.55, spacing: 0.05, angle: 90, roundness: 0.55, flow: 0.7 },
    dynamics: { smoothing: 0.15, pressureSize: false, pressureOpacity: true, pressureSmoothing: 0.25, rotation: 'stroke', sizeJitter: 0.06, angleJitter: 0.02 },
    behaviour: { grain: 1 },
  },
  {
    id: 'oil-pastel', name: 'Oil pastel', kind: 'mark', medium: 'dry', variety: 'oil-pastel', family: 'dry',
    tip: { shape: 'flat', size: 26, hardness: 0.8, spacing: 0.05, angle: 90, roundness: 0.7, flow: 0.9, blend: 'pigment' },
    dynamics: { smoothing: 0.15, pressureSmoothing: 0.25, rotation: 'stroke', minSize: 0.6 },
    behaviour: { grain: 0.5 },
  },
  {
    id: 'charcoal-stick', name: 'Charcoal stick', kind: 'mark', medium: 'dry', variety: 'charcoal', family: 'dry',
    tip: { shape: 'flat', size: 26, hardness: 0.4, spacing: 0.05, angle: 90, roundness: 0.35, opacity: 0.95, flow: 0.5 },
    dynamics: { smoothing: 0.15, pressureSize: false, pressureOpacity: true, pressureSmoothing: 0.2, rotation: 'stroke', tiltSize: 0.6, sizeJitter: 0.1, angleJitter: 0.03 },
    behaviour: { grain: 0.95 },
  },
  {
    id: 'vine-charcoal', name: 'Vine charcoal', kind: 'mark', medium: 'dry', variety: 'charcoal', family: 'dry',
    tip: { shape: 'round', size: 10, hardness: 0.3, spacing: 0.06, opacity: 0.75, flow: 0.45 },
    dynamics: { smoothing: 0.2, pressureOpacity: true, pressureSmoothing: 0.2, minSize: 0.4, tiltSize: 0.8, tiltRoundness: 0.5, tiltOpacity: 0.3, sizeJitter: 0.08 },
    behaviour: { grain: 0.9 },
  },
  {
    id: 'airbrush', name: 'Airbrush', kind: 'mark', medium: 'spray', variety: 'airbrush', family: 'spray',
    tip: { shape: 'round', size: 90, hardness: 0, spacing: 0.04, flow: 0.06 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureSmoothing: 0.3, pressureFlow: 1, tiltSize: 0.5, tiltRoundness: 0.6 },
  },
  {
    id: 'marker', name: 'Chisel marker', kind: 'mark', medium: 'ink', variety: 'marker', family: 'ink',
    tip: { shape: 'chisel', size: 24, hardness: 0.85, spacing: 0.04, angle: 45, roundness: 0.35, opacity: 0.6, blend: 'multiply' },
    dynamics: { smoothing: 0.3, pressureSize: false },
    behaviour: { grain: 0.1 },
  },
  {
    id: 'ink-pen', name: 'Ink pen', kind: 'mark', medium: 'ink', variety: 'pen', family: 'ink',
    tip: { shape: 'round', size: 4, spacing: 0.05 },
    dynamics: { smoothing: 0.5, pressureSmoothing: 0.4, minSize: 0.25, velocitySize: -0.45 },
  },
  {
    id: 'brush-pen', name: 'Brush pen', kind: 'mark', medium: 'ink', variety: 'brush-pen', family: 'ink',
    tip: { shape: 'flat', size: 14, hardness: 0.9, spacing: 0.04, roundness: 0.8 },
    dynamics: { smoothing: 0.5, pressureSmoothing: 0.45, rotation: 'stroke', minSize: 0.05, velocitySize: -0.3 },
  },
  {
    id: 'eraser-soft', name: 'Soft eraser', kind: 'tool', tool: 'eraser',
    tip: { shape: 'round', size: 40, hardness: 0.2, spacing: 0.08, flow: 0.6 },
    dynamics: { pressureSize: false, pressureOpacity: true },
  },
  {
    id: 'eraser-hard', name: 'Hard eraser', kind: 'tool', tool: 'eraser',
    tip: { shape: 'round', size: 16, hardness: 0.9, spacing: 0.06 },
    dynamics: { minSize: 0.5 },
    behaviour: { grain: 0.3 },
  },
  {
    id: 'blender', name: 'Blender', kind: 'tool', tool: 'blender',
    tip: { shape: 'round', size: 34, hardness: 0.4 },
    dynamics: { smoothing: 0.2, pressureSize: false, pressureOpacity: true },
  },
  {
    id: 'smudge', name: 'Smudge', kind: 'tool', tool: 'smudge',
    tip: { shape: 'round', size: 26, hardness: 0.6, spacing: 0.06 },
    dynamics: { smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    behaviour: { strength: 0.75 },
  },
  {
    id: 'wet-smudge', name: 'Pigment smudge', kind: 'tool', tool: 'smudge',
    tip: { shape: 'round', size: 30, hardness: 0.5, spacing: 0.06 },
    dynamics: { smoothing: 0.2, pressureOpacity: true, minSize: 0.6 },
    behaviour: { length: 0.9, mixing: 'pigment' },
  },
  {
    // Carries no paint: scrapes and spreads the thick and wet paint already down.
    id: 'palette-knife', name: 'Palette knife', kind: 'tool', tool: 'knife',
    tip: { shape: 'flat', size: 48, spacing: 0.05, angle: 90, roundness: 0.18 },
    dynamics: { smoothing: 0.3, pressureSize: false, rotation: 'stroke' },
    behaviour: { thick: { gloss: 0.55, drag: 0.85 } },
  },
  {
    id: 'dirty-round', name: 'Dirty round', kind: 'mark', medium: 'paint', variety: 'acrylic', family: 'wet',
    tip: { shape: 'round', size: 22, hardness: 0.65, spacing: 0.06, flow: 0.7 },
    dynamics: { smoothing: 0.2, minSize: 0.5 },
    behaviour: { exchange: { pickup: 0.55, mix: 0.6, dirty: true } },
  },
  // The paint and second colours side by side across the tip.
  {
    id: 'multicolor-flat', name: 'Multi-colour flat', kind: 'mark', medium: 'paint', variety: 'acrylic', family: 'wet',
    tip: { shape: 'flat', size: 30, hardness: 0.75, spacing: 0.05, angle: 90, roundness: 0.3, flow: 0.85 },
    dynamics: { smoothing: 0.2, rotation: 'stroke', minSize: 0.6 },
    behaviour: { exchange: { pickup: 0.15, mix: 0.4 } },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: 'secondary' }], space: 'pigment', map: { by: 'across-tip' }, softness: 0.7 } },
  },
  // From the paint colour to the second colour and back, every 6 dabs.
  {
    id: 'palette-dabber', name: 'Palette dabber', kind: 'mark', medium: 'paint', variety: 'acrylic', family: 'wet',
    tip: { shape: 'round', size: 18, hardness: 0.7, spacing: 0.35, flow: 0.9 },
    dynamics: { smoothing: 0.1, minSize: 0.5, sizeJitter: 0.15, scatter: 0.3 },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: 'paint' }, { offset: 0.5, color: 'secondary' }, { offset: 1, color: 'paint' }], space: 'pigment', map: { by: 'distance', length: 12, repeat: 'repeat', unit: 'dabs' }, softness: 0.4 } },
  },
  // Changes colour as it is dragged out: paint → second colour over 300 px, and back.
  {
    id: 'gradient-round', name: 'Gradient round', kind: 'mark', medium: 'paint', variety: 'gradient', family: 'wet',
    tip: { shape: 'round', size: 24, hardness: 0.8, spacing: 0.05, flow: 0.9 },
    dynamics: { smoothing: 0.2, minSize: 0.5 },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: 'secondary' }], space: 'pigment', map: { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' } } },
  },
  // Light pressure lays the second colour, full pressure the paint colour.
  {
    id: 'pressure-ombre', name: 'Pressure ombré', kind: 'mark', medium: 'paint', variety: 'gradient', family: 'wet',
    tip: { shape: 'round', size: 26, hardness: 0.6, spacing: 0.05, flow: 0.8 },
    dynamics: { smoothing: 0.2, pressureSize: false },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: 'secondary' }, { offset: 1, color: 'paint' }], space: 'pigment', map: { by: 'pressure' } } },
  },
  {
    id: 'rainbow-marker', name: 'Rainbow marker', kind: 'mark', medium: 'ink', variety: 'marker', family: 'ink',
    tip: { shape: 'flat', size: 18, hardness: 0.9, spacing: 0.04, angle: 90, roundness: 0.4 },
    dynamics: { smoothing: 0.25, pressureSize: false, rotation: 'stroke' },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: '#e11d48' }, { offset: 0.2, color: '#f59e0b' }, { offset: 0.4, color: '#facc15' }, { offset: 0.6, color: '#22c55e' }, { offset: 0.8, color: '#3b82f6' }, { offset: 1, color: '#8b5cf6' }], space: 'oklab', map: { by: 'distance', length: 600, repeat: 'repeat', unit: 'px' } }, own: true },
  },
  {
    id: 'mixer-brush', name: 'Mixer Brush', kind: 'mark', medium: 'paint', variety: 'mixer', family: 'wet',
    tip: { shape: 'round', size: 30, hardness: 0.7, flow: 0.5 },
    dynamics: { smoothing: 0.2, minSize: 0.5 },
    behaviour: { exchange: { reservoir: { load: 0.95 } }, mixing: 'pigment' },
  },
  {
    id: 'watercolor-round', name: 'Watercolour round', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'wet',
    tip: { shape: 'round', size: 28, hardness: 0.6, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.35 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.55 }, wet: { water: 0.55, rewet: 0.2 } },
  },
  {
    id: 'watercolor-wash', name: 'Wash brush', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'wet',
    tip: { shape: 'flat', size: 90, hardness: 0.35, angle: 90, roundness: 0.45 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureOpacity: true, rotation: 'stroke' },
    behaviour: { surface: 'wet', exchange: { pickup: 0.45, mix: 0.45 }, wet: { water: 0.8, pigment: 0.45, rewet: 0.2 } },
  },
  // A graded wash: the paint colour runs into the second colour as the brush travels.
  {
    id: 'gradient-wash', name: 'Gradient wash', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'wet',
    tip: { shape: 'flat', size: 80, hardness: 0.35, angle: 90, roundness: 0.5 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureOpacity: true, rotation: 'stroke' },
    behaviour: { surface: 'wet', exchange: { pickup: 0.4, mix: 0.4 }, wet: { water: 0.8, pigment: 0.45, rewet: 0.2 } },
    colour: { default: { type: 'gradient', stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: 'secondary' }], space: 'pigment', map: { by: 'distance', length: 500, repeat: 'mirror', unit: 'px' } } },
  },
  // Live patterns: Gray-Scott reaction-diffusion that grows inside the wet wash and freezes as it dries.
  {
    id: 'turing-wash', name: 'Turing wash', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'living',
    tip: { shape: 'round', size: 36, hardness: 0.5, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.35 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.45 }, wet: { water: 0.75, pigment: 0.55, rewet: 0.2 } },
    livePatterns: { pattern: 'spots', contrast: 1.2, secondColor: '#0ea5e9', relief: 0.25 },
  },
  {
    id: 'coral-ink', name: 'Coral ink', kind: 'mark', medium: 'ink', variety: 'watercolor', family: 'living',
    tip: { shape: 'round', size: 22, hardness: 0.65, spacing: 0.12 },
    dynamics: { smoothing: 0.3, pressureOpacity: true, minSize: 0.3 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.35 }, wet: { water: 0.7, pigment: 0.75, rewet: 0.15 } },
    livePatterns: { pattern: 'coral', scale: 1.2, contrast: 1.3 },
  },
  {
    id: 'watercolor-detail', name: 'Watercolour rigger', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'wet',
    tip: { shape: 'round', size: 7, hardness: 0.75 },
    dynamics: { smoothing: 0.4, minSize: 0.2 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.4, mix: 0.45 }, wet: { water: 0.4, pigment: 0.7, rewet: 0.2 } },
  },
  {
    id: 'gouache', name: 'Gouache', kind: 'mark', medium: 'paint', variety: 'gouache', family: 'wet',
    tip: { shape: 'round', size: 26, hardness: 0.7 },
    dynamics: { smoothing: 0.25, minSize: 0.5 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.65, mix: 0.6 }, wet: { water: 0.35, pigment: 0.8, body: 1, rewet: 0.3 } },
  },
  {
    id: 'oil-round', name: 'Wet oil round', kind: 'mark', medium: 'paint', variety: 'oil', family: 'wet',
    tip: { shape: 'round', size: 24, hardness: 0.75, spacing: 0.08 },
    dynamics: { smoothing: 0.25, minSize: 0.5 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.6, mix: 0.55 }, wet: { water: 0.4, pigment: 0.9, body: 1, load: 0.97 } },
  },
  {
    id: 'oil-flat', name: 'Wet oil flat', kind: 'mark', medium: 'paint', variety: 'oil', family: 'wet',
    tip: { shape: 'flat', size: 40, hardness: 0.85, spacing: 0.06, angle: 90, roundness: 0.35 },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.6 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.65, mix: 0.6 }, wet: { water: 0.45, pigment: 0.9, body: 1, load: 0.95 } },
  },
  {
    id: 'impasto-brush', name: 'Impasto brush', kind: 'mark', medium: 'paint', variety: 'oil', family: 'thick',
    tip: { shape: 'flat', size: 36, hardness: 0.8, spacing: 0.06, angle: 90, roundness: 0.55 },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.55 },
    behaviour: { surface: 'thick', exchange: { pickup: 0.4 }, thick: { gloss: 0.45, load: 0.92 } },
  },
  {
    id: 'paint-tube', name: 'Paint tube', kind: 'mark', medium: 'paint', variety: 'oil', family: 'thick',
    tip: { shape: 'round', size: 22, hardness: 0.9, spacing: 0.05 },
    dynamics: { smoothing: 0.35, minSize: 0.4 },
    behaviour: { surface: 'thick', thick: { applicator: 'tube', thickness: 0.9, gloss: 0.5, load: 1, drag: 0.1 } },
  },
  {
    id: 'paint-roller', name: 'Roller', kind: 'mark', medium: 'paint', variety: 'acrylic', family: 'thick',
    tip: { shape: 'flat', size: 70, hardness: 0.95, spacing: 0.04, angle: 90, roundness: 0.12 },
    dynamics: { smoothing: 0.4, pressureSize: false, rotation: 'stroke' },
    behaviour: { surface: 'thick', thick: { applicator: 'roller', thickness: 0.25, gloss: 0.3, drag: 0.15 } },
  },
  {
    id: 'gloop-pen', name: 'Gloop pen', kind: 'mark', medium: 'paint', variety: 'gloop', family: 'thick',
    tip: { shape: 'round', size: 14, hardness: 0.9, spacing: 0.05 },
    dynamics: { smoothing: 0.5, minSize: 0.5 },
    behaviour: { surface: 'thick', thick: { applicator: 'gloop', thickness: 1, gloss: 0.9, load: 1, drag: 0 } },
  },
  {
    id: 'metallic-paint', name: 'Metallic paint', kind: 'mark', medium: 'paint', variety: 'metallic', family: 'metallic',
    tip: { shape: 'flat', size: 30, hardness: 0.8, spacing: 0.06, angle: 90, roundness: 0.6 },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.5 },
    behaviour: { surface: 'thick', exchange: { pickup: 0.2, mix: 0.4 }, thick: { thickness: 0.45, gloss: 0.8, metallic: 1, load: 0.95, drag: 0.3 } },
  },
  {
    id: 'hair-strands', name: 'Hair strands', kind: 'mark', medium: 'ink', variety: 'hair', family: 'strands',
    tip: { shape: 'round', size: 40, hardness: 0.8, opacity: 0.9, flow: 0.6 },
    marks: { kind: 'particles', physics: 'string', count: 22, size: 0.025, spread: 1, stiffness: 0.08, damping: 0.3 },
    dynamics: { smoothing: 0.2, pressureOpacity: true },
  },
  {
    id: 'spring-ink', name: 'Spring ink', kind: 'mark', medium: 'ink', variety: 'spring', family: 'strands',
    tip: { shape: 'round', size: 30, hardness: 0.9, flow: 0.8 },
    marks: { kind: 'particles', count: 5, spread: 0.6, stiffness: 0.2, damping: 0.1 },
    dynamics: { smoothing: 0.1 },
  },
  {
    id: 'orbit-curls', name: 'Orbit curls', kind: 'mark', medium: 'ink', variety: 'curls', family: 'strands',
    tip: { shape: 'round', size: 36, hardness: 0.85, opacity: 0.9, flow: 0.7 },
    marks: { kind: 'particles', physics: 'orbit', count: 4, size: 0.05, spread: 0.6, speed: 0.45 },
    dynamics: { smoothing: 0.2 },
  },
  {
    id: 'flow-fur', name: 'Flow fur', kind: 'mark', medium: 'ink', variety: 'fur', family: 'strands',
    tip: { shape: 'round', size: 50, hardness: 0.7, opacity: 0.8, flow: 0.5 },
    marks: { kind: 'particles', physics: 'flow', count: 10, size: 0.03, spread: 0.6, life: 0.25 },
    dynamics: { smoothing: 0.2, pressureOpacity: true },
  },
  {
    id: 'bead-trail', name: 'Bead trail', kind: 'mark', medium: 'paint', variety: 'beads', family: 'strands',
    tip: { shape: 'round', size: 34, hardness: 0.9 },
    marks: { kind: 'particles', render: 'sequence', count: 3, size: 0.18, stiffness: 0.3, damping: 0.3, interval: 0.4 },
    dynamics: { smoothing: 0.25 },
  },
  {
    id: 'sparkle-dust', name: 'Sparkle dust', kind: 'mark', medium: 'paint', variety: 'glitter', family: 'glow',
    tip: { shape: 'round', size: 60, hardness: 0.6, flow: 0.9 },
    marks: { kind: 'particles', physics: 'flow', render: 'dot', count: 6, size: 0.05, spread: 0.9, speed: 0.7, life: 0.4 },
    dynamics: { smoothing: 0.1, pressureOpacity: true },
  },
  {
    id: 'bristle-round', name: 'Bristle round', kind: 'mark', medium: 'paint', variety: 'oil', family: 'wet',
    tip: { shape: 'bristle', size: 30, hardness: 0.85, flow: 0.9, bristle: { count: 28, stiffness: 0.45, splay: 0.6, thickness: 0.035, load: 0.7, jitter: 0.5 } },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.4, tiltSize: 0.6, tiltRoundness: 0.6 },
  },
  {
    id: 'bristle-flat', name: 'Bristle flat', kind: 'mark', medium: 'paint', variety: 'oil', family: 'wet',
    tip: { shape: 'bristle', size: 46, hardness: 0.85, angle: 90, roundness: 0.3, flow: 0.9, bristle: { count: 40, stiffness: 0.6, splay: 0.4, thickness: 0.025, load: 0.65, jitter: 0.45 } },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.5, tiltSize: 0.5 },
  },
  {
    id: 'dry-brush', name: 'Dry brush', kind: 'mark', medium: 'paint', variety: 'dry-brush', family: 'wet',
    tip: { shape: 'bristle', size: 44, hardness: 0.9, angle: 90, roundness: 0.45, flow: 0.8, bristle: { count: 48, stiffness: 0.35, splay: 0.7, thickness: 0.05, load: 0.15, jitter: 0.8 } },
    dynamics: { smoothing: 0.2, rotation: 'stroke' },
    behaviour: { grain: 0.6 },
  },
  // Light paint: brushes that lay light with their colour (glow and spill; see light.ts).
  {
    id: 'glow-gel', name: 'Glow gel', kind: 'mark', medium: 'paint', variety: 'gel', family: 'glow',
    tip: { shape: 'round', size: 16, hardness: 0.9, spacing: 0.05 },
    dynamics: { smoothing: 0.5, minSize: 0.6 },
    behaviour: { surface: 'thick', thick: { applicator: 'gloop', thickness: 1, gloss: 0.95, load: 1, drag: 0, rim: 0.8, clarity: 0.5 } },
    light: { amount: 0.85 },
  },
  {
    id: 'neon-marker', name: 'Neon marker', kind: 'mark', medium: 'ink', variety: 'neon', family: 'glow',
    tip: { shape: 'round', size: 10, hardness: 0.9, spacing: 0.04 },
    dynamics: { smoothing: 0.45, pressureSize: false },
    light: { amount: 1 },
    colour: { palette: ['#f0abfc', '#22d3ee', '#a3e635', '#fb7185', '#fde047'] },
  },
  {
    id: 'light-airbrush', name: 'Light airbrush', kind: 'mark', medium: 'spray', variety: 'airbrush', family: 'spray',
    tip: { shape: 'round', size: 90, hardness: 0, spacing: 0.04, flow: 0.06 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureSmoothing: 0.3, pressureFlow: 1 },
    light: { amount: 0.7, pressure: true },
  },
  {
    id: 'spark-trail', name: 'Spark trail', kind: 'mark', medium: 'paint', variety: 'sparks', family: 'glow',
    tip: { shape: 'round', size: 50, hardness: 0.7 },
    marks: { kind: 'particles', physics: 'flow', render: 'dot', count: 8, size: 0.06, spread: 0.7, speed: 0.9, life: 0.3 },
    dynamics: { smoothing: 0.1 },
    light: { amount: 1 },
  },
  // Silk of light: strands dragged behind the pen on slow waves, the bands between them filled.
  {
    id: 'light-ribbon', name: 'Light ribbon', kind: 'mark', medium: 'paint', variety: 'ribbon', family: 'glow',
    tip: { shape: 'round', size: 80, hardness: 0.8, opacity: 0.9 },
    marks: { kind: 'particles', physics: 'string', render: 'ribbon', count: 5, size: 0.015, spread: 1, stiffness: 0.05, damping: 0.3, ribbonFill: 0.45, waveAmplitude: 0.25, waveLength: 220, wavePhaseJitter: 0.25 },
    dynamics: { smoothing: 0.35, pressureSize: false },
    light: { amount: 0.8 },
  },
  // Flames: short-lived bands thrown off the pen, rising and curling in the flow.
  {
    id: 'flame-ribbon', name: 'Flame ribbon', kind: 'mark', medium: 'paint', variety: 'flame', family: 'glow',
    tip: { shape: 'round', size: 50, hardness: 0.6, opacity: 0.85 },
    marks: { kind: 'particles', physics: 'flow', render: 'ribbon', count: 4, size: 0.012, speed: 0.6, gravity: -0.6, life: 0.2 },
    dynamics: { smoothing: 0.25 },
    light: { amount: 1 },
  },
  // A neon tube that lags and snaps back, with a slow shimmer.
  {
    id: 'neon-strand', name: 'Neon strand', kind: 'mark', medium: 'ink', variety: 'neon', family: 'glow',
    tip: { shape: 'round', size: 40, hardness: 0.9 },
    marks: { kind: 'particles', physics: 'elastic', count: 3, size: 0.05, spread: 0.25, stiffness: 0.6, damping: 0.3, waveAmplitude: 0.06, waveLength: 120 },
    dynamics: { smoothing: 0.4, pressureSize: false },
    light: { amount: 1 },
  },
  // Smoke lit from within: thin bands thrown into a slow, rising flow.
  {
    id: 'smoke-ribbon', name: 'Smoke ribbon', kind: 'mark', medium: 'paint', variety: 'smoke', family: 'strands',
    tip: { shape: 'round', size: 70, hardness: 0.3, opacity: 0.45 },
    marks: { kind: 'particles', physics: 'flow', render: 'ribbon', count: 3, size: 0.005, speed: 0.15, gravity: -0.15, life: 0.35, ribbonFill: 0.25, waveAmplitude: 0.1, waveLength: 140, wavePhaseJitter: 1 },
    dynamics: { smoothing: 0.3 },
    light: { amount: 0.3 },
  },
  // Out-of-focus lights: soft discs and rings spaced along springy paths.
  {
    id: 'bokeh-dots', name: 'Bokeh dots', kind: 'mark', medium: 'paint', variety: 'bokeh', family: 'glow',
    tip: { shape: 'stamp', size: 80, hardness: 0.7, opacity: 0.6, stamps: ['editor:dot', 'editor:dot', 'editor:ring'] },
    marks: { kind: 'particles', render: 'sequence', count: 3, size: 0.3, spread: 1, stiffness: 0.15, damping: 0.4, interval: 1, stampOrder: 'random' },
    dynamics: { smoothing: 0.3 },
    light: { amount: 0.9 },
  },
  // Sparks: twinkles and stars thrown into the flow, spaced along it.
  {
    id: 'twinkle-sparks', name: 'Twinkle sparks', kind: 'mark', medium: 'paint', variety: 'sparks', family: 'glow',
    tip: { shape: 'stamp', size: 50, hardness: 0.8, stamps: ['editor:sparkle', 'editor:sparkle', 'editor:star'] },
    marks: { kind: 'particles', physics: 'flow', render: 'sequence', count: 3, size: 0.25, spread: 0.8, speed: 0.9, life: 0.35, interval: 0.6, stampOrder: 'random' },
    dynamics: { smoothing: 0.1 },
    light: { amount: 1 },
  },
  {
    id: 'glow-wash', name: 'Glow wash', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'glow',
    tip: { shape: 'round', size: 40, hardness: 0.55, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.35 },
    behaviour: { surface: 'wet', exchange: { pickup: 0.4 }, wet: { water: 0.65, pigment: 0.75, rewet: 0.1 } },
    light: { amount: 0.7 },
  },
  // Fluorescent ink: a transparent chisel marker that multiplies (text under it stays dark) and glows a little
  // brighter than the paper. Its light spills nowhere (a spill hint of 0), and it comes in highlighter colours.
  {
    id: 'highlighter', name: 'Highlighter', kind: 'mark', medium: 'ink', variety: 'highlighter', family: 'ink',
    tip: { shape: 'chisel', size: 30, hardness: 0.85, spacing: 0.04, angle: 45, roundness: 0.35, opacity: 0.6, blend: 'multiply' },
    dynamics: { smoothing: 0.3, pressureSize: false },
    behaviour: { grain: 0.05 },
    light: { amount: 0.5, spill: { radius: 0 } },
    colour: { default: '#fff200', palette: ['#fff200', '#ff6ec7', '#7cff4f', '#ffa630'] },
  },
  {
    id: 'sticker-stars', name: 'Star stickers', kind: 'mark', variety: 'stars', family: 'stickers',
    tip: { shape: 'stamp', size: 36, stamps: ['editor:star', 'editor:sparkle'] },
    marks: { kind: 'objects', density: 0.35, sizeJitter: 0.5, scatter: 0.6, colourJitter: 0.3 },
    dynamics: { smoothing: 0.2, minSize: 0.5 },
  },
  {
    id: 'sticker-leaves', name: 'Leaf stickers', kind: 'mark', variety: 'leaves', family: 'stickers',
    tip: { shape: 'stamp', size: 40, stamps: ['editor:leaf'] },
    marks: { kind: 'objects', density: 0.5, rotationJitter: 0.35, scatter: 0.4, colourJitter: 0.35 },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.5 },
  },
  {
    id: 'sticker-confetti', name: 'Confetti', kind: 'mark', variety: 'confetti', family: 'stickers',
    tip: { shape: 'stamp', size: 22, stamps: ['editor:confetti', 'editor:dot', 'editor:ring'] },
    marks: { kind: 'objects', density: 0.7, sizeJitter: 0.5, scatter: 1.5, colourJitter: 1 },
    dynamics: { smoothing: 0.1, pressureSize: false },
  },
  {
    id: 'sticker-flowers', name: 'Flower stickers', kind: 'mark', variety: 'flowers', family: 'stickers',
    tip: { shape: 'stamp', size: 44, stamps: ['editor:flower', 'editor:heart'] },
    marks: { kind: 'objects', density: 0.3, sizeJitter: 0.5, scatter: 0.7, colourJitter: 0.4 },
    dynamics: { smoothing: 0.2 },
  },
  {
    id: 'sticker-splats', name: 'Paint splats', kind: 'mark', variety: 'splats', family: 'stickers',
    tip: { shape: 'stamp', size: 50, opacity: 0.95, stamps: ['editor:splat'] },
    marks: { kind: 'objects', density: 0.25, sizeJitter: 0.6, scatter: 0.8, colourJitter: 0.15 },
    dynamics: { smoothing: 0.1 },
  },
  {
    id: 'add-water', name: 'Add water', kind: 'tool', tool: 'water',
    tip: { shape: 'round', size: 40, hardness: 0.4, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.5 },
    behaviour: { wet: { water: 0.6, pigment: 0, rewet: 0.3 } },
  },
  {
    id: 'hair-dryer', name: 'Dry', kind: 'tool', tool: 'dryer',
    tip: { shape: 'round', size: 80, hardness: 0.1, spacing: 0.15 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureOpacity: true },
  },
  {
    id: 'blow', name: 'Blow', kind: 'tool', tool: 'blow',
    tip: { shape: 'round', size: 50, hardness: 0.2 },
    dynamics: { smoothing: 0.3, pressureSize: false, pressureOpacity: true },
    behaviour: { strength: 0.6 },
  },
  {
    id: 'wet-blend', name: 'Wet blend', kind: 'tool', tool: 'wet-blend',
    tip: { shape: 'round', size: 36, hardness: 0.3 },
    dynamics: { smoothing: 0.25, pressureSize: false, pressureOpacity: true },
    behaviour: { strength: 0.4 },
  },
  {
    id: 'wet-drag', name: 'Wet smudge', kind: 'tool', tool: 'wet-drag',
    tip: { shape: 'round', size: 30, hardness: 0.5, spacing: 0.08 },
    dynamics: { smoothing: 0.25, pressureSize: false, pressureOpacity: true },
    behaviour: { strength: 0.6 },
  },
  {
    id: 'blot', name: 'Blot (erase wet)', kind: 'tool', tool: 'blot',
    tip: { shape: 'round', size: 40, hardness: 0.5, spacing: 0.12 },
    dynamics: { smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    behaviour: { strength: 0.7 },
  },
  // --- Pens, crayon, chalk and the spray can -------------------------------------------
  // A ballpoint: a fine, hard, even line that lightens with a light touch.
  {
    id: 'ballpoint', name: 'Ballpoint', kind: 'mark', medium: 'ink', variety: 'ballpoint', family: 'ink',
    tip: { shape: 'round', size: 3, hardness: 0.95, spacing: 0.05, opacity: 0.9 },
    dynamics: { smoothing: 0.35, pressureSmoothing: 0.3, pressureOpacity: true, minSize: 0.7, opacityJitter: 0.08 },
    behaviour: { grain: 0.15 },
    colour: { default: { light: '#1e3a8a', dark: '#93c5fd' }, palette: [{ light: '#1e3a8a', dark: '#93c5fd' }, { light: '#111827', dark: '#f3f4f6' }, '#b91c1c', '#166534'] },
  },
  // A gel pen: an even, opaque, saturated line.
  {
    id: 'gel-pen', name: 'Gel pen', kind: 'mark', medium: 'ink', variety: 'gel', family: 'ink',
    tip: { shape: 'round', size: 4, spacing: 0.04 },
    dynamics: { smoothing: 0.3, pressureSmoothing: 0.3, minSize: 0.8 },
    colour: { default: { light: '#111827', dark: '#f3f4f6' }, palette: [{ light: '#111827', dark: '#f3f4f6' }, '#7c3aed', '#db2777', '#0891b2', '#16a34a', '#f59e0b'] },
  },
  // A fineliner: one width, whatever the pressure.
  {
    id: 'fineliner', name: 'Fineliner', kind: 'mark', medium: 'ink', variety: 'fineliner', family: 'ink',
    tip: { shape: 'round', size: 2, spacing: 0.05 },
    dynamics: { smoothing: 0.4, pressureSize: false },
    colour: { default: { light: '#111827', dark: '#f3f4f6' } },
  },
  // A wax crayon: waxy, catching the paper's peaks, a little uneven.
  {
    id: 'crayon', name: 'Crayon', kind: 'mark', medium: 'dry', variety: 'crayon', family: 'dry',
    tip: { shape: 'round', size: 14, hardness: 0.7, spacing: 0.06, opacity: 0.9, flow: 0.85 },
    dynamics: { smoothing: 0.2, minSize: 0.6, tiltSize: 0.6, sizeJitter: 0.1, opacityJitter: 0.1 },
    behaviour: { grain: 0.9 },
    colour: { default: '#dc2626', palette: ['#dc2626', '#f59e0b', '#facc15', '#16a34a', '#2563eb', '#7c3aed'] },
  },
  // Chalk: broad, powdery and grainy. Its default colour is light on dark paper and dark on light.
  {
    id: 'chalk', name: 'Chalk', kind: 'mark', medium: 'dry', variety: 'chalk', family: 'dry',
    tip: { shape: 'round', size: 18, hardness: 0.6, spacing: 0.05, opacity: 0.95, flow: 0.8 },
    dynamics: { smoothing: 0.2, minSize: 0.5, tiltSize: 0.8, sizeJitter: 0.12, scatter: 0.05 },
    behaviour: { grain: 1 },
    colour: { default: { light: '#475569', dark: '#f8fafc' }, palette: [{ light: '#475569', dark: '#f8fafc' }, '#fca5a5', '#fde68a', '#93c5fd'] },
  },
  // A spray can: a mist of hard droplets, denser the slower it passes.
  {
    id: 'spray-can', name: 'Spray can', kind: 'mark', medium: 'spray', variety: 'spraycan', family: 'spray',
    tip: { shape: 'round', size: 60, hardness: 0.9, spacing: 0.08, opacity: 0.9 },
    marks: { kind: 'scatter', density: 0.7, size: 0.04 },
    dynamics: { smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    colour: { palette: ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#f8fafc'] },
  },
  // --- Smart inks: UV-fluorescent and thermochromic ------------------------------------
  // Invisible UV marker: invisible in normal light, glows brightly under the UV blacklight.
  {
    id: 'uv-marker', name: 'UV marker', kind: 'mark', medium: 'ink', variety: 'uv-ink', family: 'ethereal',
    tip: { shape: 'round', size: 18, hardness: 0.75, spacing: 0.06, opacity: 0.9 },
    dynamics: { smoothing: 0.3, minSize: 0.5 },
    fluorescence: { amount: 0.9, invisible: true },
    colour: { default: '#22d3ee', palette: ['#22d3ee', '#a855f7', '#4ade80', '#f472b6'] },
  },
  // Thermochromic ink: shifts smoothly toward its hot colour where the canvas heat field warms it.
  {
    id: 'thermo-ink', name: 'Thermochromic ink', kind: 'mark', medium: 'ink', variety: 'thermochromic', family: 'reactive',
    tip: { shape: 'round', size: 12, hardness: 0.85, spacing: 0.05 },
    dynamics: { smoothing: 0.3, minSize: 0.4 },
    thermochromic: { hotColor: '#ff7a18', threshold: 0.45 },
    colour: { default: '#1e3a8a', palette: ['#1e3a8a', '#312e81', '#065f46', '#7f1d1d'] },
  },
  // --- Structural colour (thin-film iridescence) ---------------------------------------
  // Scarab lacquer: thick metallic impasto under a high-index chitin-like thin film.
  {
    id: 'scarab-lacquer', name: 'Scarab lacquer', kind: 'mark', medium: 'paint', variety: 'iridescent', family: 'iridescent',
    tip: { shape: 'round', size: 22, hardness: 0.75, spacing: 0.06 },
    dynamics: { smoothing: 0.25, minSize: 0.3 },
    behaviour: { surface: 'thick', thick: { thickness: 0.7, gloss: 0.85, metallic: 0.5 } },
    iridescence: { thickness: 480, pressureToThickness: 0.35, ior: 1.65 },
    colour: { default: '#065f46', palette: ['#065f46', '#1e3a8a', '#581c87', '#7c2d12', '#111827'] },
  },
  // Soap film: a soft glaze whose thin watery film shifts across the spectrum with pressure.
  {
    id: 'soap-film', name: 'Soap film', kind: 'mark', medium: 'paint', variety: 'iridescent', family: 'iridescent',
    tip: { shape: 'round', size: 32, hardness: 0.4, spacing: 0.06, opacity: 0.85, flow: 0.75 },
    dynamics: { smoothing: 0.35, pressureOpacity: true, minSize: 0.35 },
    iridescence: { thickness: 340, pressureToThickness: 0.8, ior: 1.33 },
    colour: { default: { light: '#0284c7', dark: '#bae6fd' }, palette: [{ light: '#0284c7', dark: '#bae6fd' }, '#f472b6', '#a78bfa', '#34d399'] },
  },
  // Pearl glaze: a flat nacre glaze with gentle interference colour shifts.
  {
    id: 'pearl-glaze', name: 'Pearl glaze', kind: 'mark', medium: 'paint', variety: 'iridescent', family: 'iridescent',
    tip: { shape: 'flat', size: 28, hardness: 0.5, spacing: 0.06, angle: 25, roundness: 0.4, opacity: 0.9, flow: 0.85 },
    dynamics: { smoothing: 0.3, rotation: 'stroke', minSize: 0.4 },
    iridescence: { thickness: 560, pressureToThickness: 0.25, ior: 1.55 },
    colour: { default: { light: '#475569', dark: '#f1f5f9' }, palette: [{ light: '#475569', dark: '#f1f5f9' }, '#fbcfe8', '#ddd6fe', '#bae6fd', '#fef3c7'] },
  },
  // --- Ghost paint: wet paint whose colour vanishes, leaving only what it smeared ---
  {
    id: 'ghost-wash', name: 'Ghost wash', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'ethereal',
    tip: { shape: 'round', size: 32, hardness: 0.55, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.35 },
    behaviour: { surface: 'wet', wet: { water: 0.65, rewet: 0.2 } },
    ghost: {},
  },
  {
    id: 'ghost-gouache', name: 'Ghost gouache', kind: 'mark', medium: 'paint', variety: 'gouache', family: 'ethereal',
    tip: { shape: 'round', size: 26, hardness: 0.7 },
    dynamics: { smoothing: 0.25, minSize: 0.5 },
    behaviour: { surface: 'wet', wet: { water: 0.35, pigment: 0.85, body: 1, rewet: 0.3 } },
    ghost: { linger: 5, smear: 0.4 },
  },
  {
    id: 'ghost-oil', name: 'Ghost oil', kind: 'mark', medium: 'paint', variety: 'oil', family: 'ethereal',
    tip: { shape: 'round', size: 24, hardness: 0.75, spacing: 0.08 },
    dynamics: { smoothing: 0.25, minSize: 0.5 },
    behaviour: { surface: 'wet', wet: { water: 0.4, pigment: 0.9, body: 1, load: 0.97 } },
    ghost: { linger: 10, smear: 0.5 },
  },
  {
    id: 'invisible-ink', name: 'Invisible ink', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'ethereal',
    tip: { shape: 'round', size: 24, hardness: 0.65 },
    dynamics: { smoothing: 0.3, minSize: 0.4 },
    behaviour: { surface: 'wet', wet: { water: 0.45, pigment: 0, rewet: 0.35 } },
    ghost: { smear: 0.65 },
  },
  // --- Mutation paint: strokes that sink away once claimed, and an agent answers ---
  {
    id: 'mutation-wash', name: 'Mutation wash', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'living',
    tip: { shape: 'round', size: 28, hardness: 0.6, spacing: 0.12 },
    dynamics: { smoothing: 0.25, pressureOpacity: true, minSize: 0.35 },
    behaviour: { surface: 'wet', wet: { water: 0.6, rewet: 0.2 } },
    mutation: {},
  },
  {
    id: 'mutation-ink', name: 'Mutation ink', kind: 'mark', medium: 'ink', variety: 'pen', family: 'living',
    tip: { shape: 'round', size: 6, hardness: 0.9, spacing: 0.06 },
    dynamics: { smoothing: 0.35, pressureSmoothing: 0.25, minSize: 0.25 },
    mutation: {},
  },
  // --- Ferrofluid paint: liquid magnetic paint that rises into lit Rosensweig spikes near magnets ---
  {
    id: 'ferrofluid', name: 'Ferrofluid', kind: 'mark', medium: 'paint', variety: 'ferrofluid', family: 'reactive',
    tip: { shape: 'round', size: 28, hardness: 0.75, flow: 0.9 },
    dynamics: { smoothing: 0.35 },
    ferro: { amount: 0.85 },
    colour: { default: '#111827', palette: ['#111827', '#1e293b', '#312e81', '#0f3d3e', '#3b0764', '#451a03'] },
  },
  {
    id: 'ferro-ink', name: 'Ferro ink', kind: 'mark', medium: 'ink', variety: 'ferrofluid', family: 'reactive',
    tip: { shape: 'round', size: 12, spacing: 0.08 },
    dynamics: { smoothing: 0.45, minSize: 0.25, velocitySize: -0.25 },
    ferro: { amount: 0.7, wavelength: 12, threshold: 0.15 },
    colour: { default: '#0f172a' },
  },
  // --- Biopaint (culture): mycelial ink that grows through the painting and feeds on it ---
  {
    id: 'mycelial-ink', name: 'Mycelial ink', kind: 'mark', medium: 'ink', variety: 'biopaint', family: 'living',
    tip: { shape: 'round', size: 8, hardness: 0.9, spacing: 0.08 },
    dynamics: { smoothing: 0.35, minSize: 0.25 },
    culture: {},
    colour: { default: '#1c1917' },
  },
  {
    id: 'rot', name: 'Rot', kind: 'mark', medium: 'ink', variety: 'biopaint', family: 'living',
    tip: { shape: 'round', size: 12, hardness: 0.75 },
    dynamics: { smoothing: 0.3, minSize: 0.35 },
    culture: { reach: 16, branching: 0.5, appetite: 0.8, digest: 0.75, thickness: 0.12 },
    colour: { default: '#3f2e21' },
  },
  {
    id: 'foxfire', name: 'Foxfire', kind: 'mark', medium: 'ink', variety: 'biopaint', family: 'living',
    tip: { shape: 'round', size: 10, hardness: 0.8, spacing: 0.08 },
    dynamics: { smoothing: 0.35, minSize: 0.3 },
    culture: { reach: 15, branching: 0.45, glow: 0.85 },
    colour: { default: '#4ade80', palette: ['#4ade80', '#2dd4bf', '#a3e635', '#38bdf8', '#c084fc'] },
  },
  // --- Antimatter paint: blasts that invert, scorch and destroy paint across visible layers ---
  {
    id: 'antimatter', name: 'Antimatter', kind: 'mark', medium: 'paint', variety: 'antimatter', family: 'volatile',
    tip: { shape: 'round', size: 24, hardness: 0.75, spacing: 0.12 },
    marks: { kind: 'antimatter' },
    dynamics: { smoothing: 0.25, minSize: 0.4 },
    colour: { default: '#38bdf8', palette: ['#38bdf8', '#f472b6', '#a855f7', '#fb923c', '#4ade80'] },
  },
  {
    id: 'antimatter-flare', name: 'Antimatter flare', kind: 'mark', medium: 'paint', variety: 'antimatter', family: 'volatile',
    tip: { shape: 'round', size: 18, hardness: 0.7, spacing: 0.08 },
    marks: { kind: 'antimatter', blastRadius: 2, blastSpacing: 1.4, invert: 0.75, invertMode: 'oklab', scorch: 0.35, annihilate: 0.15, sparks: 0.95, sparkReach: 5, crater: 0.3 },
    dynamics: { smoothing: 0.2, minSize: 0.4 },
    light: { amount: 0.9 },
    colour: { default: '#f472b6', palette: ['#f472b6', '#38bdf8', '#facc15', '#a855f7', '#4ade80'] },
  },
  {
    id: 'antimatter-charge', name: 'Antimatter charge', kind: 'mark', medium: 'paint', variety: 'antimatter', family: 'volatile',
    tip: { shape: 'round', size: 32, hardness: 0.85, spacing: 0.15 },
    marks: { kind: 'antimatter', blastRadius: 4.5, blastSpacing: 4.5, threshold: 0.2, invertMode: 'oklab', scorch: 0.8, annihilate: 0.6, sparks: 0.65, sparkReach: 4, crater: 0.85, duration: 1 },
    dynamics: { smoothing: 0.3, minSize: 0.5 },
    colour: { default: '#fb923c', palette: ['#fb923c', '#ef4444', '#38bdf8', '#a855f7'] },
  },
  // --- Scraper: cuts down through the paint stack layer by layer ---
  {
    id: 'paint-scraper', name: 'Paint scraper', kind: 'mark', medium: 'paint', variety: 'scraper',
    tip: { shape: 'flat', size: 28, hardness: 0.9, spacing: 0.06, angle: 30, roundness: 0.35 },
    marks: { kind: 'scraper' },
    dynamics: { smoothing: 0.25, rotation: 'stroke', minSize: 0.5 },
  },
  // --- Vortex paint: draw a shape and the paint around it winds into a vortex of that shape ---
  {
    id: 'vortex', name: 'Vortex', kind: 'mark', medium: 'paint', variety: 'vortex', family: 'volatile',
    tip: { shape: 'round', size: 24, hardness: 0.7 },
    marks: { kind: 'vortex' },
    dynamics: { smoothing: 0.3, minSize: 0.35 },
  },
  {
    id: 'ink-vortex', name: 'Ink vortex', kind: 'mark', medium: 'paint', variety: 'vortex', family: 'volatile',
    tip: { shape: 'round', hardness: 0.75 },
    marks: { kind: 'vortex', ink: 0.85 },
    dynamics: { smoothing: 0.3, minSize: 0.35 },
    colour: { default: '#2563eb', palette: ['#2563eb', '#dc2626', '#f59e0b', '#10b981', '#7c3aed', '#ec4899'] },
  },
  {
    id: 'whirlpool', name: 'Whirlpool', kind: 'mark', medium: 'paint', variety: 'vortex', family: 'volatile',
    tip: { shape: 'round', size: 28, hardness: 0.65 },
    marks: { kind: 'vortex', reach: 4, turns: 2.5, pull: 0.75 },
    dynamics: { smoothing: 0.3, minSize: 0.35 },
  },
  {
    id: 'wet-vortex', name: 'Wet vortex', kind: 'mark', medium: 'paint', variety: 'watercolor', family: 'volatile',
    tip: { shape: 'round', size: 28, hardness: 0.6 },
    marks: { kind: 'vortex', reach: 3.5, pull: 0.35 },
    dynamics: { smoothing: 0.3, minSize: 0.35 },
    behaviour: { surface: 'wet', wet: { water: 0.6, rewet: 0.35 } },
  },
];
