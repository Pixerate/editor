// The presence primitives moved to `tools/presence.ts` so `@pixerate/editor/tools` can play agent
// calls without importing an editor; this path keeps the chart, paint and diagram imports working.
export * from '../tools/presence.js';
