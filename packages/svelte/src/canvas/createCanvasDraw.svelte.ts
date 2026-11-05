import {
	createCanvasDrawController,
	type CanvasDrawControllerOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

type CoreOptions = CanvasDrawControllerOptions<any>;

export interface CreateCanvasDrawOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<
		CoreOptions,
		'getNodes' | 'setNodes' | 'onToolChange' | 'onStyleChange' | 'onActiveStrokeChange'
	> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
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
	let colorLocked = $state(!!options.colorLocked);
	let colorScheme = $state<'light' | 'dark'>(options.colorScheme === 'dark' ? 'dark' : 'light');

	const controller = createCanvasDrawController<any>({
		...options,
		onColorLockChange: (locked) => {
			colorLocked = locked;
			options.onColorLockChange?.(locked);
		},
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
		eraseAt: controller.eraseAt,
		/** Draws a whole stroke at once (agents, code); validates the brush first. One undo step. */
		drawStroke: controller.drawStroke,
		/** A node's box in canvas coordinates (lets gesture commands such as `canvas.circle` take `{ nodeId }`). */
		nodeBounds: controller.nodeBounds,
		/** The dry paint presets `style.brush` accepts (loads the paint engine). */
		listBrushes: controller.listBrushes,
		/**
		 * Picks a brush (`null`: plain pen) with its size, and its default colour unless `keepColour`.
		 * Resolves to the preset; rejects for a brush the canvas can't paint.
		 */
		selectBrush: controller.selectBrush,
		get colorScheme() {
			return colorScheme;
		},
		/**
		 * Sets the colour scheme that picks the side of a brush's light / dark default colour; a
		 * stroke colour taken from one (`selectBrush`) follows.
		 */
		setColorScheme(scheme: 'light' | 'dark') {
			controller.setColorScheme(scheme);
			colorScheme = controller.colorScheme;
		},
		/** "Keep my colour": choosing a brush keeps the stroke colour. */
		get colorLocked() {
			return colorLocked;
		},
		/** Locks the stroke colour ("Keep my colour"): `selectBrush` then keeps it. */
		setColorLocked: controller.setColorLocked,
		/** What the brush picker is set to (brush, colour, scheme, lock), read now; `canvas.selectBrush` returns it. */
		brushSettings: controller.brushSettings
	};
}

export type CanvasDraw<TNode extends CanvasNode = CanvasNode> = ReturnType<
	typeof createCanvasDraw<TNode>
>;
