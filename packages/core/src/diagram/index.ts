/**
 * Mermaid diagrams (`@pixerate/editor/diagram`): lossless parse / serialise
 * with statement-level edits for flowchart, state, class and ER diagrams,
 * canvas layout kept in a `%% @pixerate {…}` comment, `findMermaidSources`
 * for Mermaid in Markdown or chat, an undoable controller and agent tools.
 * Pure TypeScript: no framework, no dagre (the canvas projection with
 * auto-layout lives in `@pixerate/editor/canvas`).
 *
 * Ported from Ursula.
 */
export * from './types.js';
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
