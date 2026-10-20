/**
 * Wet media (watercolour first): a lattice Boltzmann water simulation with pigment on paper, on
 * sparse 256 px tiles, in WebAssembly SIMD (in Web Workers when the page is cross-origin isolated)
 * with a TypeScript kernel that gives the same bits. See `model.ts` for the model and its sources.
 */

export * from './model';
export * from './film';
export { stepSlotTs } from './kernel';
export * from './wasm';
export * from './world';
export * from './flow';
export * from './medium';
