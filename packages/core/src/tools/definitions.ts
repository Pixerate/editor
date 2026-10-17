/**
 * Standard MCP Tool Definitions for @pixerate/editor.
 * Compatible with the Model Context Protocol (MCP) tool specification schema.
 */

export const MCP_TOOL_GET_EDITOR_STATE = {
	name: 'get_editor_state',
	title: 'Get editor state',
	annotations: {
		title: 'Get editor state',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
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
	title: 'Edit the canvas',
	annotations: {
		title: 'Edit the canvas',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	description:
		'Applies high-level structural operations to the visual canvas (adding nodes, connecting edges, organizing layout, or moving elements). ' +
		'Prefer the per-operation canvas_* tools when the host exposes them. Returns the ids of created nodes and edges.',
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
			id: {
				type: 'string',
				description: 'Node ID for update_node (or pass `node: { id, data }`).'
			},
			data: {
				type: 'object',
				description: 'Data fields to merge into the node for update_node.'
			},
			color: {
				type: 'string',
				description: 'CSS color for highlight (default #3b82f6).'
			},
			durationMs: {
				type: 'integer',
				minimum: 0,
				description: 'How long the highlight lasts in ms (default 2000).'
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
	title: 'Edit the prompt',
	annotations: {
		title: 'Edit the prompt',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
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
				type: 'integer',
				minimum: 0,
				description: 'Position to insert text at.'
			},
			from: {
				type: 'integer',
				minimum: 0,
				description: 'Start offset for replace_range or select.'
			},
			to: {
				type: 'integer',
				minimum: 0,
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
	title: 'View the editor',
	annotations: {
		title: 'View the editor',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
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

// ---------------------------------------------------------------------------
// Per-operation tools: one strict schema per canvas / prompt operation.
// ---------------------------------------------------------------------------

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const NODE_IDS = {
	type: 'array',
	items: { type: 'string', minLength: 1 },
	minItems: 1,
	uniqueItems: true,
	description: 'Node ids (from get_editor_state).'
} as const;

const POSITION = {
	type: 'object',
	properties: { x: { type: 'number' }, y: { type: 'number' } },
	required: ['x', 'y'],
	additionalProperties: false
} as const;

const DOC_POSITION = { type: 'integer', minimum: 0 } as const;

export const MCP_TOOL_CANVAS_ADD_NODE = {
	name: 'canvas_add_node',
	title: 'Add a canvas node',
	annotations: { title: 'Add a canvas node', ...WRITE_ANNOTATIONS },
	description:
		'Adds a node to the canvas. Without `position` it is placed without overlaps beside `nearNodeId` (and connected from it) ' +
		'or beside the last node. Returns the new node id (generated unless you pass `node.id`) and the id of the connecting edge.',
	inputSchema: {
		type: 'object',
		properties: {
			node: {
				type: 'object',
				description: 'The node. Extra host-specific fields are kept.',
				properties: {
					id: { type: 'string', minLength: 1, description: 'Node id (default: generated). Must be unused.' },
					type: { type: 'string', description: 'Node type registered by the host.' },
					data: { type: 'object', description: 'Node data (e.g. { "label": "..." }).' },
					position: { ...POSITION, description: 'Canvas coordinates (default: auto-placed).' },
					width: { type: 'number', exclusiveMinimum: 0 },
					height: { type: 'number', exclusiveMinimum: 0 },
					parentId: { type: 'string', description: 'Parent (group/frame) node id.' }
				}
			},
			nearNodeId: { type: 'string', description: 'Existing node to place the new node beside and connect from.' },
			side: {
				type: 'string',
				enum: ['top', 'right', 'bottom', 'left'],
				description: 'Side of `nearNodeId` to place the node on (default right).'
			}
		},
		required: ['node'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_REMOVE_NODES = {
	name: 'canvas_remove_nodes',
	title: 'Remove canvas nodes',
	annotations: { title: 'Remove canvas nodes', ...DESTRUCTIVE_ANNOTATIONS },
	description: 'Removes nodes (and their edges) from the canvas. Every id must exist.',
	inputSchema: {
		type: 'object',
		properties: { nodeIds: NODE_IDS },
		required: ['nodeIds'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_CONNECT = {
	name: 'canvas_connect',
	title: 'Connect canvas nodes',
	annotations: { title: 'Connect canvas nodes', ...WRITE_ANNOTATIONS },
	description: 'Adds an edge from one existing node to another. Returns the new edge id.',
	inputSchema: {
		type: 'object',
		properties: {
			source: { type: 'string', minLength: 1, description: 'Source node id.' },
			target: { type: 'string', minLength: 1, description: 'Target node id.' },
			label: { type: 'string', description: 'Edge label.' }
		},
		required: ['source', 'target'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_UPDATE_NODE = {
	name: 'canvas_update_node',
	title: 'Update a canvas node',
	annotations: { title: 'Update a canvas node', ...DESTRUCTIVE_ANNOTATIONS, idempotentHint: true },
	description: "Merges fields into an existing node's data.",
	inputSchema: {
		type: 'object',
		properties: {
			id: { type: 'string', minLength: 1, description: 'Node id.' },
			data: { type: 'object', description: 'Data fields to merge (e.g. { "label": "New" }).' }
		},
		required: ['id', 'data'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_LAYOUT = {
	name: 'canvas_layout',
	title: 'Lay out the canvas',
	annotations: { title: 'Lay out the canvas', ...IDEMPOTENT_ANNOTATIONS },
	description: 'Arranges the canvas graph automatically.',
	inputSchema: {
		type: 'object',
		properties: {
			direction: { type: 'string', enum: ['LR', 'TB', 'RL', 'BT'], description: 'Layout direction (default LR).' },
			incremental: {
				type: 'boolean',
				description: 'Keep nodes that already have a position where they are (default true).'
			}
		},
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_SELECT = {
	name: 'canvas_select',
	title: 'Select canvas nodes',
	annotations: { title: 'Select canvas nodes', ...IDEMPOTENT_ANNOTATIONS },
	description: 'Replaces the canvas selection with these nodes (an empty list clears it).',
	inputSchema: {
		type: 'object',
		properties: { nodeIds: { ...NODE_IDS, minItems: 0 } },
		required: ['nodeIds'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_CANVAS_HIGHLIGHT = {
	name: 'canvas_highlight',
	title: 'Highlight canvas nodes',
	annotations: { title: 'Highlight canvas nodes', ...IDEMPOTENT_ANNOTATIONS },
	description: 'Briefly highlights nodes to draw the user\'s attention to them.',
	inputSchema: {
		type: 'object',
		properties: {
			nodeIds: NODE_IDS,
			color: { type: 'string', description: 'CSS color (default #3b82f6).' },
			durationMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'Duration in ms (default 2000).' }
		},
		required: ['nodeIds'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_PROMPT_INSERT_TEXT = {
	name: 'prompt_insert_text',
	title: 'Insert prompt text',
	annotations: { title: 'Insert prompt text', ...WRITE_ANNOTATIONS },
	description: 'Inserts text into the prompt at a position, or at the cursor when `at` is omitted.',
	inputSchema: {
		type: 'object',
		properties: {
			text: { type: 'string', description: 'Text to insert.' },
			at: { ...DOC_POSITION, description: 'Position (as in get_editor_state `document.selection`).' }
		},
		required: ['text'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_PROMPT_REPLACE_RANGE = {
	name: 'prompt_replace_range',
	title: 'Replace prompt text',
	annotations: { title: 'Replace prompt text', ...DESTRUCTIVE_ANNOTATIONS },
	description: 'Replaces the prompt text between two positions (an empty text deletes it).',
	inputSchema: {
		type: 'object',
		properties: {
			from: { ...DOC_POSITION, description: 'Start position.' },
			to: { ...DOC_POSITION, description: 'End position (>= from).' },
			text: { type: 'string', description: 'Replacement text.' }
		},
		required: ['from', 'to', 'text'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_PROMPT_SET_VARIABLE = {
	name: 'prompt_set_variable',
	title: 'Set a prompt variable',
	annotations: { title: 'Set a prompt variable', ...DESTRUCTIVE_ANNOTATIONS, idempotentHint: true },
	description: 'Sets the value of a template variable used by the prompt.',
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', minLength: 1, description: 'Variable name.' },
			value: { description: 'Variable value (any JSON value).' }
		},
		required: ['name', 'value'],
		additionalProperties: false
	}
} as const;

export const MCP_TOOL_PROMPT_SELECT = {
	name: 'prompt_select',
	title: 'Select prompt text',
	annotations: { title: 'Select prompt text', ...IDEMPOTENT_ANNOTATIONS },
	description: 'Selects the prompt text between two positions (from === to places the cursor).',
	inputSchema: {
		type: 'object',
		properties: {
			from: { ...DOC_POSITION, description: 'Start position.' },
			to: { ...DOC_POSITION, description: 'End position (>= from).' }
		},
		required: ['from', 'to'],
		additionalProperties: false
	}
} as const;

/** Per-operation canvas tools, the strict alternative to `edit_canvas`. */
export const EDITOR_CANVAS_TOOLS = [
	MCP_TOOL_CANVAS_ADD_NODE,
	MCP_TOOL_CANVAS_REMOVE_NODES,
	MCP_TOOL_CANVAS_CONNECT,
	MCP_TOOL_CANVAS_UPDATE_NODE,
	MCP_TOOL_CANVAS_LAYOUT,
	MCP_TOOL_CANVAS_SELECT,
	MCP_TOOL_CANVAS_HIGHLIGHT
] as const;

/** Per-operation prompt tools, the strict alternative to `edit_prompt`. */
export const EDITOR_PROMPT_TOOLS = [
	MCP_TOOL_PROMPT_INSERT_TEXT,
	MCP_TOOL_PROMPT_REPLACE_RANGE,
	MCP_TOOL_PROMPT_SET_VARIABLE,
	MCP_TOOL_PROMPT_SELECT
] as const;

/**
 * Arguments each `edit_canvas` / `edit_prompt` operation needs, used to tell
 * an agent exactly what is missing (the combined schemas cannot express it).
 */
export const EDIT_OPERATION_REQUIRED_ARGUMENTS: Readonly<Record<'edit_canvas' | 'edit_prompt', Readonly<Record<string, readonly string[]>>>> = {
	edit_canvas: {
		add_node: ['node'],
		remove_nodes: ['nodeIds'],
		connect: ['source', 'target'],
		update_node: ['id'],
		layout: [],
		select: ['nodeIds'],
		highlight: ['nodeIds']
	},
	edit_prompt: {
		insert_text: ['text'],
		replace_range: ['from', 'to', 'text'],
		set_variable: ['name'],
		select: ['from', 'to']
	}
};

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

