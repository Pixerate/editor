/**
 * Standard MCP Tool Definitions for @pixerate/editor.
 * Compatible with the Model Context Protocol (MCP) tool specification schema.
 */

export const MCP_TOOL_GET_EDITOR_STATE = {
	name: 'get_editor_state',
	description:
		'Retrieves the current state of the document, variables, selection, and canvas graph (nodes and edges).',
	inputSchema: {
		type: 'object',
		properties: {
			includeDocument: {
				type: 'boolean',
				description: 'Whether to include the prompt document text and variables (default: true).'
			},
			includeCanvas: {
				type: 'boolean',
				description: 'Whether to include the canvas nodes and edges (default: true).'
			}
		}
	}
} as const;

export const MCP_TOOL_EDIT_CANVAS = {
	name: 'edit_canvas',
	description:
		'Applies high-level structural operations to the visual canvas (adding nodes, connecting edges, organizing layout, or moving elements).',
	inputSchema: {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				enum: [
					'add_node',
					'remove_nodes',
					'connect',
					'update_node',
					'layout',
					'select',
					'highlight'
				],
				description: 'The canvas operation to execute.'
			},
			node: {
				type: 'object',
				description: 'Node definition when operation is add_node. Can omit position to auto-place.'
			},
			nearNodeId: {
				type: 'string',
				description: 'Anchor node ID to position beside using collision-aware placement.'
			},
			side: {
				type: 'string',
				enum: ['top', 'right', 'bottom', 'left'],
				description: 'Side of the anchor node to place the new node beside.'
			},
			nodeIds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Array of node IDs for remove_nodes, select, or highlight.'
			},
			source: {
				type: 'string',
				description: 'Source node ID for connect operation.'
			},
			target: {
				type: 'string',
				description: 'Target node ID for connect operation.'
			},
			label: {
				type: 'string',
				description: 'Optional edge label for connect operation.'
			},
			direction: {
				type: 'string',
				enum: ['LR', 'TB', 'RL', 'BT'],
				description: 'Layout direction (default LR).'
			},
			incremental: {
				type: 'boolean',
				description: 'Preserve existing node coordinates and blend layout (default true).'
			}
		},
		required: ['operation']
	}
} as const;

export const MCP_TOOL_EDIT_PROMPT = {
	name: 'edit_prompt',
	description:
		'Applies edits to the prompt template document, including inserting text, replacing ranges, and setting variables.',
	inputSchema: {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				enum: ['insert_text', 'replace_range', 'set_variable', 'select'],
				description: 'The prompt operation to execute.'
			},
			text: {
				type: 'string',
				description: 'Text to insert or replace.'
			},
			at: {
				type: 'number',
				description: 'Position to insert text at.'
			},
			from: {
				type: 'number',
				description: 'Start offset for replace_range or select.'
			},
			to: {
				type: 'number',
				description: 'End offset for replace_range or select.'
			},
			name: {
				type: 'string',
				description: 'Variable name for set_variable.'
			},
			value: {
				description: 'Variable value for set_variable.'
			}
		},
		required: ['operation']
	}
} as const;

export const MCP_TOOL_VIEW_EDITOR = {
	name: 'view_editor',
	description:
		'Captures a visual image snapshot (JPEG or PNG) of the editor canvas or viewport for multimodal evaluation. Active agent cursor indicators are automatically excluded from the snapshot.',
	inputSchema: {
		type: 'object',
		properties: {
			scope: {
				type: 'string',
				enum: ['viewport', 'canvas'],
				description: 'Whether to capture only the visible viewport or the full canvas bounding box (default: viewport).'
			},
			format: {
				type: 'string',
				enum: ['jpeg', 'png'],
				description: 'Image format of the base64 snapshot (default: jpeg).'
			},
			maxEdge: {
				type: 'integer',
				description: 'Maximum width or height dimension in pixels (default: 1024).'
			}
		}
	}
} as const;

/**
 * CSS selectors for ephemeral UI overlays (such as agent cursors, presence tags, and transient bubbles)
 * that should be excluded during canvas image export and visual snapshot generation.
 */
export const EXPORT_EXCLUDED_SELECTORS = [
	'.pixerate-presence',
	'.agent-presence',
	'.ursula-presence'
] as const;

export const EDITOR_MCP_TOOLS = [
	MCP_TOOL_GET_EDITOR_STATE,
	MCP_TOOL_EDIT_CANVAS,
	MCP_TOOL_EDIT_PROMPT,
	MCP_TOOL_VIEW_EDITOR
] as const;

