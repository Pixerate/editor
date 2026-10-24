/**
 * Mermaid diagrams (`@pixerate/editor/diagram`): lossless parse / serialise
 * with statement-level edits for flowchart, state, class, ER, pie, mindmap,
 * quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY
 * and radar diagrams (sankey and treemap data can be read too),
 * canvas layout kept in a `%% @pixerate {…}` comment, `findMermaidSources`
 * for Mermaid in Markdown or chat, an undoable controller and agent tools.
 * Pure TypeScript: no framework, no dagre (the canvas projection with
 * auto-layout lives in `@pixerate/editor/canvas`).
 *
 * Ported from Ursula.
 */
export * from './types.js';
export { createDiagramEditorDocument, type DiagramEditorDocument } from './editorDocument.js';
export { parseMermaid, serializeMermaid, applyEdit, applyEdits, detectFamily, type ParseOptions } from './document.js';
export { registerDiagramAdapter, getDiagramAdapter, supportTierOf } from './registry.js';
export { splitSource, detectFamilyFromHeader, splitStatements, type SplitSource } from './source/lines.js';
export { findMermaidSources, type FoundMermaid } from './source/find.js';
export {
	META_COMMENT_PREFIX,
	META_FRONTMATTER_KEY,
	serializeMeta,
	isMetaEmpty,
	emptyMeta,
	mergeMeta
} from './source/metadata.js';
export * from './flowchart/index.js';
export * from './lines-grammar/index.js';
export * from './statements/index.js';
export * from './families/index.js';
export * from './layout-registry.js';
export * from './pie/index.js';
export * from './xychart/index.js';
export * from './radar/index.js';
export * from './quadrant/index.js';
export * from './mindmap/index.js';
export * from './sequence/index.js';
export * from './gantt/index.js';
export * from './timeline/index.js';
export * from './journey/index.js';
export * from './gitgraph/index.js';
export * from './c4/index.js';
export * from './architecture/index.js';
export * from './sankey/index.js';
export * from './treemap/index.js';
export { createPassthroughAdapter, type PassthroughBody } from './passthrough.js';
export * from './controller.js';
export * from './tools.js';
export * from './draft.js';
export * from './director.js';
export {
	PresenceStore,
	PerformanceQueue,
	createInstantPresenceClock,
	realPresenceClock,
	PRESENCE_COLORS,
	type PresenceActor,
	type PresenceActorInfo,
	type PresenceClock,
	type PresenceState
} from '../animation/presence.js';
