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
export type { JsonSchema, SchemaValidationError } from '../agent/schema.js';
export { validateJsonSchema } from '../agent/schema.js';
export type { AgentTool, AgentToolProvider, McpToolDefinition, McpToolResult } from '../agent/registry.js';
