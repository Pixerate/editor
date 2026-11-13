/**
 * The vector editor as language-neutral contracts (`@pixerate/conformance` `domains/vector`), so
 * another implementation (the Swift port, #618) offers the same commands, tools, controls and
 * documents: the commands agents run through `run_command` (`createVectorCommands`), the tools of
 * the command, effect and generation providers, the UI tables React and Svelte render, and a JSON
 * Schema of a saved vector document. `scripts/export-contracts.mjs` writes them; a core test fails
 * when the committed files differ from what this returns.
 *
 * Everything here is data from this module's own tables and providers; nothing depends on the
 * package version, so a release does not change the files.
 */

import { createCommandToolProvider } from '../commands/agentTools.js';
import { CommandRegistry } from '../commands/registry.js';
import type { EffectProvider } from '../effects/types.js';
import type { ModelCapabilities } from '../generation/capabilities.js';
import { EDITOR_DOCUMENT_FORMAT, toEditorDocumentFile } from '../persistence/editorDocument.js';
import { createMetricTextShaper } from '../text/shapers.js';
import type { ConformanceHost } from '../tools/conformance.js';
import { ToolRegistry, type AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { createStyleResolver, memoryStyleStore, type StyleResolver } from '../tools/style.js';
import { VECTOR_EFFECT_DEFAULTS, VECTOR_EFFECT_LABELS, VECTOR_EFFECT_PARAM_SPECS } from './appearance.js';
import { createVectorCommands } from './commands.js';
import { VECTOR_CONNECTOR_ROUTE_LABELS, VECTOR_CONNECTOR_SIDE_LABELS } from './connectors.js';
import { VECTOR_CONSTRAINT_GLYPHS, VECTOR_CONSTRAINT_LABELS } from './constraints/glyphs.js';
import { VECTOR_PATHFINDER_LABELS, VECTOR_TOOL_GLYPHS, VECTOR_TOOL_GROUPS, VECTOR_TOOL_SHORTCUTS, VectorEditorController, type VectorEditorOptions } from './controller.js';
import { createVectorEditorDocument } from './editorDocument.js';
import { createVectorEffectsToolProvider } from './effect-tools.js';
import { VECTOR_FILTER_DEFAULTS, VECTOR_FILTER_LABELS, VECTOR_FILTER_MENU, VECTOR_FILTER_PARAM_SPECS } from './filters.js';
import { VECTOR_HORIZONTAL_RESIZING_LABELS, VECTOR_VERTICAL_RESIZING_LABELS } from './frames.js';
import { createVectorGenerationToolProvider, type VectorArtGenerator } from './generate.js';
import { VECTOR_LAYER_KIND_LABELS } from './layers.js';
import { VECTOR_LENS_LABELS, VECTOR_LENS_SPECS } from './lens.js';
import { VECTOR_BLEND_MODE_LABELS } from './paintLayers.js';
import {
	VECTOR_ARROWHEAD_LABELS,
	VECTOR_BLEND_MODE_MENU,
	VECTOR_BLEND_SPACING_LABELS,
	VECTOR_CORNER_KIND_LABELS,
	VECTOR_EDIT_TOGGLES,
	VECTOR_EFFECT_MENU,
	VECTOR_ENVELOPE_STYLE_OPTIONS,
	VECTOR_GRADIENT_INTERPOLATION_LABELS,
	VECTOR_GRADIENT_SPREAD_LABELS,
	VECTOR_GRADIENT_TYPE_LABELS,
	VECTOR_MASK_TYPE_LABELS,
	VECTOR_MASK_TYPE_OPTIONS,
	VECTOR_OVERLAY_THEME,
	VECTOR_PATH_ACTIONS,
	VECTOR_PATHFINDER_ACTIONS,
	VECTOR_STROKE_ALIGN_LABELS,
	VECTOR_STROKE_GRADIENT_MODE_LABELS,
	getVectorSceneRenderData
} from './render.js';
import { createVectorStyleToolProvider, vectorStyleDomain, type VectorStyleProfile } from './style.js';
import { VECTOR_STYLIZE_LABELS } from './stylize.js';
import { VECTOR_SYMMETRY_MODE_LABELS } from './symmetry.js';
import { getVectorTextShaper, setVectorTextShaper } from './text.js';
import { VECTOR_FONT_WEIGHTS, VECTOR_TEXT_ALIGN_LABELS, VECTOR_TEXT_ALIGN_OPTIONS } from './textPanel.js';
import { VECTOR_TOOLS, type VectorDocument } from './types.js';
import { VECTOR_WARP_STYLE_LABELS } from './warp.js';
import { VECTOR_WIDTH_PRESETS } from './width.js';

/** Bumped when a contract file changes shape (not when its data changes). */
export const VECTOR_CONTRACT_FORMAT_VERSION = 1;

/**
 * JSON Schema of a saved vector document: the `pixerate.editor-document` envelope of kind
 * `vector` around a `VectorDocument` (`createVectorEditorDocument`). Readers keep fields they do
 * not know, so objects stay open; nodes are described by their common fields and `type`.
 */
export const VECTOR_DOCUMENT_JSON_SCHEMA: JsonSchema = {
	type: 'object',
	description: "A saved vector document, as the vector editor's save tools and autosave write it.",
	properties: {
		format: { type: 'string', const: EDITOR_DOCUMENT_FORMAT, description: `Always "${EDITOR_DOCUMENT_FORMAT}".` },
		kind: { type: 'string', const: 'vector', description: 'Always "vector".' },
		formatVersion: { type: 'integer', minimum: 1, description: 'Version of the envelope for this kind; readers migrate older ones.' },
		name: { type: 'string', description: 'Display name, when it has one.' },
		document: {
			type: 'object',
			description: 'The drawing (`VectorDocument`, as get_vector_document returns it).',
			properties: {
				width: { type: 'number', exclusiveMinimum: 0, description: 'Artboard width in document units.' },
				height: { type: 'number', exclusiveMinimum: 0, description: 'Artboard height in document units.' },
				background: { type: 'string', description: 'Artboard colour (default: transparent).' },
				nodes: {
					type: 'array',
					description: 'Top-level nodes, bottom to top. Groups hold their own children.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Node id.' },
							type: { type: 'string', enum: ['path', 'group', 'text', 'instance'], description: 'path, group, text or instance (of a symbol).' },
							name: { type: 'string', description: 'Layer name.' },
							visible: { type: 'boolean', description: 'false hides it (default true).' },
							locked: { type: 'boolean', description: 'true keeps it from being selected on the canvas.' },
							transform: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6, description: 'Affine matrix [a, b, c, d, e, f] (default identity).' }
						},
						required: ['id', 'type']
					}
				},
				symbols: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'Symbol id.' } }, required: ['id'] }, description: "Symbols the document's instances draw." },
				constraints: { type: 'array', items: { type: 'object' }, description: 'Constraints between anchors, segments and circles, solved after every edit.' },
				parameters: { type: 'array', items: { type: 'object' }, description: "Named values the constraints' expressions use." },
				perspective: { type: ['object', 'null'], description: 'The perspective grid, or null.' }
			},
			required: ['width', 'height', 'nodes']
		}
	},
	required: ['format', 'kind', 'formatVersion', 'document']
};

/** A provider's tools as an MCP tool list (name, title, description, inputSchema, annotations). */
function toolList(provider: AgentToolProvider) {
	const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
	return {
		id: provider.id,
		title: provider.title,
		...(provider.skill ? { skill: provider.skill } : {}),
		tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
	};
}

/** The UI tables React and Svelte render, as plain data. */
function uiTables() {
	return {
		tools: { order: VECTOR_TOOLS, groups: VECTOR_TOOL_GROUPS, glyphs: VECTOR_TOOL_GLYPHS, shortcuts: VECTOR_TOOL_SHORTCUTS },
		menus: {
			blendModes: VECTOR_BLEND_MODE_MENU,
			effects: VECTOR_EFFECT_MENU,
			filters: VECTOR_FILTER_MENU,
			pathActions: VECTOR_PATH_ACTIONS,
			pathfinderActions: VECTOR_PATHFINDER_ACTIONS,
			editToggles: VECTOR_EDIT_TOGGLES,
			envelopeStyles: VECTOR_ENVELOPE_STYLE_OPTIONS,
			maskTypes: VECTOR_MASK_TYPE_OPTIONS,
			textAligns: VECTOR_TEXT_ALIGN_OPTIONS,
			fontWeights: VECTOR_FONT_WEIGHTS
		},
		specs: {
			effects: { defaults: VECTOR_EFFECT_DEFAULTS, params: VECTOR_EFFECT_PARAM_SPECS },
			filters: { defaults: VECTOR_FILTER_DEFAULTS, params: VECTOR_FILTER_PARAM_SPECS },
			lenses: VECTOR_LENS_SPECS,
			widthPresets: VECTOR_WIDTH_PRESETS
		},
		labels: {
			arrowheads: VECTOR_ARROWHEAD_LABELS,
			blendModes: VECTOR_BLEND_MODE_LABELS,
			blendSpacings: VECTOR_BLEND_SPACING_LABELS,
			connectorRoutes: VECTOR_CONNECTOR_ROUTE_LABELS,
			connectorSides: VECTOR_CONNECTOR_SIDE_LABELS,
			constraints: VECTOR_CONSTRAINT_LABELS,
			constraintGlyphs: VECTOR_CONSTRAINT_GLYPHS,
			cornerKinds: VECTOR_CORNER_KIND_LABELS,
			effects: VECTOR_EFFECT_LABELS,
			filters: VECTOR_FILTER_LABELS,
			gradientInterpolations: VECTOR_GRADIENT_INTERPOLATION_LABELS,
			gradientSpreads: VECTOR_GRADIENT_SPREAD_LABELS,
			gradientTypes: VECTOR_GRADIENT_TYPE_LABELS,
			horizontalResizing: VECTOR_HORIZONTAL_RESIZING_LABELS,
			verticalResizing: VECTOR_VERTICAL_RESIZING_LABELS,
			layerKinds: VECTOR_LAYER_KIND_LABELS,
			lenses: VECTOR_LENS_LABELS,
			maskTypes: VECTOR_MASK_TYPE_LABELS,
			pathfinder: VECTOR_PATHFINDER_LABELS,
			strokeAligns: VECTOR_STROKE_ALIGN_LABELS,
			strokeGradientModes: VECTOR_STROKE_GRADIENT_MODE_LABELS,
			stylize: VECTOR_STYLIZE_LABELS,
			symmetryModes: VECTOR_SYMMETRY_MODE_LABELS,
			textAligns: VECTOR_TEXT_ALIGN_LABELS,
			warpStyles: VECTOR_WARP_STYLE_LABELS
		},
		overlayTheme: VECTOR_OVERLAY_THEME
	};
}

/**
 * The generation models and generator the contracts and scenarios use: one text model that
 * writes a fixed SVG from the prompt (a circle whose size and colour follow the prompt's length),
 * so generation tools replay the same everywhere without a network.
 */
export const FAKE_VECTOR_ART_MODELS: readonly ModelCapabilities[] = [{ id: 'fake-svg', name: 'Fake SVG', media: 'text', seed: true }];

export const fakeVectorArtGenerator: VectorArtGenerator = (request) => {
	const n = (request.prompt ?? '').length;
	const r = 10 + (n % 30);
	const hue = ['#e11d48', '#2563eb', '#16a34a', '#d97706'][n % 4];
	return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="${r}" fill="${hue}"/></svg>` };
};

/**
 * The house style the vector tools check against (#791): one `org` layer holding a `house` skill
 * with `vector.json` (`style`) and `brand.json` (`brand`) when either is given, else no skill.
 */
function vectorStyles(setup: VectorConformanceSetup = {}): StyleResolver {
	const files: Record<string, string> =
		setup.style || setup.brand
			? {
					'house/SKILL.md': '---\nname: house\ndescription: House vector style.\n---\nFollow the house vector style.',
					...(setup.style ? { 'house/vector.json': JSON.stringify(setup.style) } : {}),
					...(setup.brand ? { 'house/brand.json': JSON.stringify(setup.brand) } : {})
				}
			: {};
	return createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }], domains: [vectorStyleDomain] });
}

/** Every vector agent tool provider on `controller`, the commands' own registry included. */
function vectorProviders(controller: VectorEditorController, styles: StyleResolver = vectorStyles()): { commands: CommandRegistry; providers: AgentToolProvider[] } {
	const commands = new CommandRegistry({ context: controller, history: controller.history });
	commands.register(createVectorCommands(controller));
	return {
		commands,
		providers: [
			createCommandToolProvider(commands, { id: 'vector-commands', namespace: '' }),
			createVectorEffectsToolProvider(controller, { id: 'vector-effects' }),
			createVectorGenerationToolProvider(controller, { models: FAKE_VECTOR_ART_MODELS, generate: fakeVectorArtGenerator }),
			createVectorStyleToolProvider(controller, styles, { id: 'vector-style' })
		]
	};
}

/**
 * Every vector contract file, by its path under `domains/vector/` (plain JSON values). `effects`
 * is the effect provider the effect tools are listed with (the export uses the fake provider, so
 * the files do not depend on a catalogue).
 */
export function vectorContracts(options: { effects: EffectProvider }): Record<string, unknown> {
	const controller = new VectorEditorController();
	controller.setEffectsProvider(options.effects);
	const specs = createVectorCommands(controller);
	const providers = vectorProviders(controller).providers.map(toolList);
	const document = createVectorEditorDocument(controller);
	const files: Record<string, unknown> = {
		'document.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'document.schema.json', ...VECTOR_DOCUMENT_JSON_SCHEMA },
		'tools.json': { providers },
		// The commands agents run with run_command: `shortcut` is as written (`Mod` is ⌘ / Ctrl). A
		// command without `params` takes none (run_command refuses any); `undoable` and `readOnly`
		// are the spec's own flags (unset is false), as the registry reads them.
		'commands.json': specs.map((s) => ({
			id: s.id,
			label: s.label,
			...(s.group ? { group: s.group } : {}),
			...(s.keywords?.length ? { keywords: s.keywords } : {}),
			...(s.description ? { description: s.description } : {}),
			...(s.params ? { params: s.params } : {}),
			...(s.shortcut !== undefined ? { shortcut: s.shortcut } : {}),
			...(s.scope ? { scope: s.scope } : {}),
			undoable: !!s.undoable,
			readOnly: !!s.readOnly,
			...(s.hidden ? { hidden: true } : {})
		})),
		'ui.json': uiTables()
	};
	files['manifest.json'] = {
		domain: 'vector',
		formatVersion: VECTOR_CONTRACT_FORMAT_VERSION,
		document: { kind: document.kind, formatVersion: document.formatVersion },
		counts: { providers: providers.length, tools: providers.reduce((n, p) => n + p.tools.length, 0), commands: specs.length },
		files: Object.keys(files).sort()
	};
	document.destroy?.();
	return files;
}

/** A vector conformance scenario's `setup`. */
export interface VectorConformanceSetup {
	/** Artboard width in document units (default the editor's, 800). */
	width?: number;
	/** Artboard height in document units (default the editor's, 600). */
	height?: number;
	/** Artboard colour (default transparent), e.g. for the house style's min-contrast on text. */
	background?: string;
	/** Optional house-style `vector.json` for `check_vector_style` / `fix_vector_style` (#791). */
	style?: VectorStyleProfile & { checks?: ReadonlyArray<string | Record<string, unknown>> };
	/** Optional `brand.json` beside it: the vector profile is derived from it and its checks run too. */
	brand?: Record<string, unknown>;
}

/**
 * A fresh vector editor for replaying a conformance scenario (`domains/vector/fixtures`): every
 * vector tool provider in one registry that validates arguments, and the saved document. Node ids
 * come from a counter (`n1`, `n2`, …), so they are part of the contract; text uses the metric
 * shaper, the one every implementation can match. `render` is the scene the canvases draw
 * (`getVectorSceneRenderData` with its defaults). `setup` is the scenario's artboard size
 * (`{ width, height }`, default the editor's) and `background`, and its house style (`style`, the
 * `vector.json` profile, and `brand`, the `brand.json` beside it, in one `org` layer; see
 * `VectorConformanceSetup`); `effects` is the effect provider the effect tools use.
 */
export function createVectorConformanceHost(setup: VectorConformanceSetup, options: { effects: EffectProvider }): ConformanceHost {
	const shaper = getVectorTextShaper();
	setVectorTextShaper(createMetricTextShaper());
	let next = 0;
	const sized: Pick<VectorEditorOptions, 'document'> =
		setup.width || setup.height || setup.background
			? { document: { width: setup.width ?? 800, height: setup.height ?? 600, ...(setup.background ? { background: setup.background } : {}), nodes: [] } }
			: {};
	const controller = new VectorEditorController({ ...sized, createId: () => `n${++next}` });
	controller.setEffectsProvider(options.effects);
	const registry = new ToolRegistry({ validateArguments: true });
	for (const p of vectorProviders(controller, vectorStyles(setup)).providers) registry.register(p);
	const document = createVectorEditorDocument(controller);
	return {
		callTool: (name, args) => registry.callTool(name, args),
		document: () => toEditorDocumentFile(document),
		pixels: () => {
			throw new Error('The vector editor has no pixels; compare its document, results, render data and SVG export.');
		},
		// What the React and Svelte canvases draw, with the default options (no viewport culling).
		render: () => getVectorSceneRenderData(controller.getState()),
		dispose: () => {
			document.destroy?.();
			setVectorTextShaper(shaper);
		}
	};
}
