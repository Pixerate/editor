import type { CanvasEdge, CanvasNode, Side, XYPosition } from '../canvas/types.js';

/**
 * Agent presence state for visual multiplayer/agent choreography.
 */
export interface AgentPresence {
	agentId: string;
	name: string;
	color: string;
	cursorPosition?: XYPosition;
	selectedNodeIds?: string[];
	activeNodeId?: string;
	statusMessage?: string;
	lastActive: number;
}

/**
 * Snapshot of current editor and canvas state provided to agent planners and MCP clients.
 */
export interface EditorSnapshot<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	document?: {
		text: string;
		variables?: Record<string, any>;
		selection?: { from: number; to: number };
		isDirty?: boolean;
	};
	canvas?: {
		nodes: TNode[];
		edges: TEdge[];
		selectedNodeIds?: string[];
	};
}

/**
 * High-level intent commands that an AI agent or remote controller can issue.
 */
export type AgentCommand<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> =
	// Canvas commands
	| {
			type: 'canvas:add_node';
			node: Omit<TNode, 'position'> & { position?: XYPosition };
			nearNodeId?: string;
			side?: Side;
	  }
	| {
			type: 'canvas:remove_nodes';
			nodeIds: string[];
	  }
	| {
			type: 'canvas:connect';
			source: string;
			target: string;
			label?: string;
	  }
	| {
			type: 'canvas:update_node';
			id: string;
			data: Partial<TNode['data']>;
	  }
	| {
			type: 'canvas:layout';
			direction?: 'LR' | 'TB' | 'RL' | 'BT';
			incremental?: boolean;
	  }
	| {
			type: 'canvas:select';
			nodeIds: string[];
	  }
	| {
			type: 'canvas:highlight';
			nodeIds: string[];
			color?: string;
			durationMs?: number;
	  }
	// Prompt/Document commands
	| {
			type: 'prompt:insert_text';
			text: string;
			at?: number;
	  }
	| {
			type: 'prompt:replace_range';
			from: number;
			to: number;
			text: string;
	  }
	| {
			type: 'prompt:set_variable';
			name: string;
			value: any;
	  }
	| {
			type: 'prompt:select';
			from: number;
			to: number;
	  };

/**
 * Atomic execution steps returned by the planner.
 */
export type AgentStep<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> =
	| {
			type: 'step:canvas_add_node';
			node: TNode;
	  }
	| {
			type: 'step:canvas_remove_nodes';
			nodeIds: string[];
	  }
	| {
			type: 'step:canvas_add_edge';
			edge: TEdge;
	  }
	| {
			type: 'step:canvas_update_node';
			id: string;
			data: Partial<TNode['data']>;
	  }
	| {
			type: 'step:canvas_move_nodes';
			positions: Record<string, XYPosition>;
	  }
	| {
			type: 'step:canvas_select';
			nodeIds: string[];
	  }
	| {
			type: 'step:canvas_highlight';
			nodeIds: string[];
			color: string;
			durationMs: number;
	  }
	| {
			type: 'step:prompt_insert';
			text: string;
			at?: number;
	  }
	| {
			type: 'step:prompt_replace';
			from: number;
			to: number;
			text: string;
	  }
	| {
			type: 'step:prompt_set_variable';
			name: string;
			value: any;
	  }
	| {
			type: 'step:prompt_select';
			from: number;
			to: number;
	  };
