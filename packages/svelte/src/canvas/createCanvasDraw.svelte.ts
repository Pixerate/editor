import {
	createCanvasDrawController,
	type CanvasDrawControllerOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

export interface CreateCanvasDrawOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<
		CanvasDrawControllerOptions<TNode>,
		'onToolChange' | 'onStyleChange' | 'onActiveStrokeChange'
	> {
	onToolChange?: (tool: FreehandTool) => void;
	onStyleChange?: (style: FreehandStrokeStyle) => void;
	onActiveStrokeChange?: (stroke: FreehandStroke | null) => void;
}

/**
 * Headless Svelte 5 rune managing freehand drawing tools (pen, highlighter, eraser) on a canvas.
 */
export function createCanvasDraw<TNode extends CanvasNode = CanvasNode>(
	options: CreateCanvasDrawOptions<TNode>
) {
	let tool = $state.raw<FreehandTool>(options.tool ?? 'select');
	let activeStroke = $state.raw<FreehandStroke | null>(null);

	const controller = createCanvasDrawController<TNode>({
		...options,
		onToolChange: (nextTool) => {
			tool = nextTool;
			style = controller.style;
			options.onToolChange?.(nextTool);
		},
		onStyleChange: (nextStyle) => {
			style = nextStyle;
			options.onStyleChange?.(nextStyle);
		},
		onActiveStrokeChange: (nextStroke) => {
			activeStroke = nextStroke;
			options.onActiveStrokeChange?.(nextStroke);
		}
	});

	let style = $state.raw<FreehandStrokeStyle>(controller.style);

	return {
		get tool() {
			return tool;
		},
		setTool: controller.setTool,
		get style() {
			return style;
		},
		setStyle: controller.setStyle,
		get activeStroke() {
			return activeStroke;
		},
		get isDrawing() {
			return activeStroke !== null;
		},
		startStroke: controller.startStroke,
		continueStroke: controller.continueStroke,
		endStroke: controller.endStroke,
		cancelStroke: controller.cancelStroke,
		eraseAt: controller.eraseAt
	};
}

export type CanvasDraw<TNode extends CanvasNode = CanvasNode> = ReturnType<
	typeof createCanvasDraw<TNode>
>;
