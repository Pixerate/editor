// Lives in a .ts file, not ChartInspector.svelte's module script: `node16` consumers type
// `.svelte` imports through Svelte's ambient `*.svelte` module, which has no named exports.
export type ChartInspectorSection = 'type' | 'style' | 'titles' | 'options' | 'legend' | 'axes' | 'annotations' | 'series';
