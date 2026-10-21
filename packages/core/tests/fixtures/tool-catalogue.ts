/**
 * Every built-in tool provider in one registry, with default ids and namespaces, the way a
 * host that mounts all the editors would expose them. The tool-selection evals search it.
 * Needs a DOM (jsdom) for the rich text editor.
 */
import { Editor } from '@tiptap/core';
import {
	ToolRegistry,
	createRichTextToolProvider,
	createSpreadsheetToolProvider,
	createEditorMcpToolProvider,
	createCanvasComponentToolProvider
} from '../../src/agent';
import { CommandRegistry, createCommandToolProvider } from '../../src/commands';
import { ImageEditorController, createImageEditorToolProvider, createImageEffectsToolProvider } from '../../src/image-editor';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectsToolProvider } from '../../src/paint-editor';
import { createGenerationToolProvider, createGenerationHistoryToolProvider, createGenerationRecordStore } from '../../src/generation';
import { createMemoryStorage } from '../../src/persistence';
import { ChartController, createChartToolProvider, createOfficeChartToolProvider } from '../../src/chart';
import { DiagramController, createDiagramToolProvider } from '../../src/diagram';
import { createCanvasCaptureToolProvider, createCanvasEffectsController, createCanvasEffectsToolProvider } from '../../src/canvas';
import { AnimationEditorController, createAnimationEditorToolProvider, createAnimationEffectsToolProvider } from '../../src/animation-editor';
import { VideoEditorController, createVideoEditorToolProvider, createVideoEffectsToolProvider } from '../../src/video-editor';
import { VectorEditorController, createVectorEffectsToolProvider, createVectorGenerationToolProvider } from '../../src/vector';
import { createFakeEffectProvider } from '../../src/effects';
import { createRichTextPreset, SpreadsheetController } from '../../src';

export function createToolCatalogue(): { registry: ToolRegistry; dispose(): void } {
	const doc = new Editor({ extensions: createRichTextPreset({ chart: true }), content: '<p>x</p>' });
	const sheet = new SpreadsheetController({
		document: {
			columns: [{ id: 'c0', key: 'A', title: 'A', type: 'freeform' as const }],
			rows: [{ id: 'r0', index: 0, type: 'freeform' as const }]
		}
	});
	const painter = new PaintEditorController({ width: 64, height: 64 });
	painter.setEffectsProvider(createFakeEffectProvider());
	const registry = new ToolRegistry();
	const providers = [
		createRichTextToolProvider(doc, { id: 'doc' }),
		createSpreadsheetToolProvider(sheet, { id: 'sheet' }),
		createEditorMcpToolProvider({
			id: 'editor',
			getSnapshot: () => ({}) as any,
			applySteps: () => {},
			captureView: () => ({ data: '', mimeType: 'image/png' })
		}),
		createCanvasComponentToolProvider({ addVariant: () => {}, removeVariant: () => {} } as any, { id: 'components' }),
		createCommandToolProvider(new CommandRegistry()),
		createImageEditorToolProvider(new ImageEditorController()),
		createImageEffectsToolProvider(new ImageEditorController({ effects: createFakeEffectProvider() })),
		createPaintEditorToolProvider(new PaintEditorController({ width: 64, height: 64 })),
		createPaintEffectsToolProvider(painter),
		createChartToolProvider(new ChartController()),
		createOfficeChartToolProvider({ files: () => [], controller: new ChartController() }),
		createDiagramToolProvider(new DiagramController(), { renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) }),
		createCanvasEffectsToolProvider(createCanvasEffectsController({ getNodes: () => [], setNodes: () => {}, effects: createFakeEffectProvider() })),
		createCanvasCaptureToolProvider({ element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => [] }),
		createAnimationEditorToolProvider(new AnimationEditorController()),
		createAnimationEffectsToolProvider(new AnimationEditorController({ effects: createFakeEffectProvider() })),
		createVideoEditorToolProvider(new VideoEditorController()),
		createVideoEffectsToolProvider(new VideoEditorController({ effects: createFakeEffectProvider() })),
		createVectorEffectsToolProvider(new VectorEditorController()),
		createVectorGenerationToolProvider(new VectorEditorController(), { models: [{ id: 'm', media: 'image' }], generate: () => ({ svg: '' }) }),
		createGenerationToolProvider({ models: [], generate: () => ({}), estimate: () => ({}) } as any),
		createGenerationHistoryToolProvider({ store: createGenerationRecordStore({ storage: createMemoryStorage() }) })
	];
	for (const provider of providers) registry.register(provider);
	return { registry, dispose: () => doc.destroy() };
}
