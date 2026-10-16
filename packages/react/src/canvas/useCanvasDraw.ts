import { useEffect, useMemo, useRef, useState } from 'react';
import {
	createCanvasDrawController,
	type ArrangeHistoryTarget,
	type CanvasNode,
	type FreehandDrawOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool
} from '@pixerate/editor/canvas';

export interface UseCanvasDrawOptions<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	history?: ArrangeHistoryTarget;
	initialTool?: FreehandTool;
	initialStyle?: Partial<FreehandStrokeStyle>;
	drawOptions?: FreehandDrawOptions;
	generateNodeId?: () => string;
	onStrokeComplete?: (node: TNode) => void;
	onNodesErase?: (erasedNodes: TNode[]) => void;
}

export interface CanvasDrawState {
	tool: FreehandTool;
	style: FreehandStrokeStyle;
	activeStroke: FreehandStroke | null;
	isDrawing: boolean;
}

export interface CanvasDrawActions<TNode extends CanvasNode = CanvasNode> {
	setTool: (tool: FreehandTool) => void;
	setStyle: (style: Partial<FreehandStrokeStyle>) => void;
	startStroke: (point: [number, number]) => void;
	continueStroke: (point: [number, number]) => void;
	endStroke: () => TNode | null;
	cancelStroke: () => void;
	eraseAt: (point: [number, number], radius?: number) => TNode[];
}

export type CanvasDraw<TNode extends CanvasNode = CanvasNode> = CanvasDrawState &
	CanvasDrawActions<TNode>;

/**
 * React hook managing freehand drawing tools (pen, highlighter, eraser) on a canvas.
 */
export function useCanvasDraw<TNode extends CanvasNode = CanvasNode>(
	options: UseCanvasDrawOptions<TNode>
): CanvasDraw<TNode> {
	const nodesRef = useRef(options.nodes);
	nodesRef.current = options.nodes;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const [tool, setToolState] = useState<FreehandTool>(options.initialTool ?? 'select');
	const [activeStroke, setActiveStroke] = useState<FreehandStroke | null>(null);

	const controller = useMemo(
		() =>
			createCanvasDrawController<TNode>({
				getNodes: () => nodesRef.current,
				setNodes: (next) => {
					nodesRef.current = next;
					optionsRef.current.setNodes(next);
				},
				get history() {
					return optionsRef.current.history;
				},
				tool: options.initialTool ?? 'select',
				style: options.initialStyle,
				drawOptions: options.drawOptions,
				generateNodeId: options.generateNodeId,
				onToolChange: setToolState,
				onStyleChange: (s) => setStyleState(s),
				onActiveStrokeChange: setActiveStroke,
				onStrokeComplete: (n) => optionsRef.current.onStrokeComplete?.(n),
				onNodesErase: (erased) => optionsRef.current.onNodesErase?.(erased)
			}),
		[]
	);

	const [style, setStyleState] = useState<FreehandStrokeStyle>(controller.style);

	// Synchronize initialTool changes if passed as reactive prop
	useEffect(() => {
		if (options.initialTool && options.initialTool !== controller.tool) {
			controller.setTool(options.initialTool);
		}
	}, [options.initialTool, controller]);

	return useMemo(
		() => ({
			tool,
			style,
			activeStroke,
			isDrawing: activeStroke !== null,
			setTool: controller.setTool,
			setStyle: controller.setStyle,
			startStroke: controller.startStroke,
			continueStroke: controller.continueStroke,
			endStroke: controller.endStroke,
			cancelStroke: controller.cancelStroke,
			eraseAt: controller.eraseAt
		}),
		[tool, style, activeStroke, controller]
	);
}
