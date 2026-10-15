// `@pixerate/editor/generation`: model capability descriptors, request
// planning, agent tools, provenance and job progress. Dependency-free: it only
// reaches the grammar and the agent tool-registry/schema modules.
export * from './capabilities.js';
export * from './plan.js';
export * from './schema.js';
export * from './tools.js';
export * from './provenance.js';
export * from './batch.js';
export * from './progress.js';
export * from './controls.js';
export * from './hash.js';
export * from './assets.js';
export * from './record.js';
export * from './store.js';
// Plain-text asset mentions (`@fox:style`), dependency-free.
export { findTextMentions, formatMentionText, setMentionRoleInText } from '../serializers/mention-text.js';
export type { MentionRoleSyntax, TextMention } from '../serializers/mention-text.js';
export type { JsonSchema, SchemaValidationError } from '../tools/schema.js';
export { validateJsonSchema } from '../tools/schema.js';
export type { AgentTool, AgentToolProvider, McpToolDefinition, McpToolResult } from '../tools/registry.js';
