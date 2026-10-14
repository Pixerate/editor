/**
 * Declarative descriptions of generative models (what a model accepts) and of
 * the requests sent to them. Everything here is plain data so capabilities can
 * come from a server, be merged with local presentation overlays, and be
 * turned into JSON Schema for agents.
 */

export type GenerationMediaKind = 'image' | 'video' | 'audio' | 'text';

/** What a reference input is used for. */
export type ReferenceRole =
	| 'start_frame'
	| 'end_frame'
	| 'style_ref'
	| 'character_ref'
	| 'background_ref'
	| 'mask'
	| 'image_ref'
	| 'video_ref'
	| 'audio_ref';

/** Every reference role, in a stable display order. */
export const REFERENCE_ROLES: readonly ReferenceRole[] = [
	'start_frame',
	'end_frame',
	'style_ref',
	'character_ref',
	'background_ref',
	'mask',
	'image_ref',
	'video_ref',
	'audio_ref'
];

/** Human-readable default labels for reference roles. */
export const REFERENCE_ROLE_LABELS: Readonly<Record<ReferenceRole, string>> = {
	start_frame: 'Start frame',
	end_frame: 'End frame',
	style_ref: 'Style reference',
	character_ref: 'Character reference',
	background_ref: 'Background reference',
	mask: 'Mask',
	image_ref: 'Image reference',
	video_ref: 'Video reference',
	audio_ref: 'Audio reference'
};

/** A choice from a fixed list. `options` order matters (low → high where it applies). */
export interface EnumCapability<T extends string | number = string> {
	options: readonly T[];
	default?: T;
	/** Display labels by option value. */
	labels?: Readonly<Record<string, string>>;
}

export interface TextFieldCapability {
	maxLength?: number;
}

export interface PromptCapability extends TextFieldCapability {
	/**
	 * Count the resolved prompt (templates expanded, variables substituted)
	 * against `maxLength` rather than the raw template text. Default `true`.
	 * Pass the resolved text to the planner as `resolvedPrompt`.
	 */
	countResolved?: boolean;
	/** The prompt must be non-empty. */
	required?: boolean;
}

export interface CountCapability {
	/** Largest number of outputs per request. */
	max: number;
	/** Predefined choices; when given, requests snap to one of them. */
	options?: readonly number[];
	default?: number;
}

export interface DurationCapability {
	/** Seconds. */
	min?: number;
	max?: number;
	/** Predefined choices; when given, requests snap to one of them. */
	options?: readonly number[];
	default?: number;
	step?: number;
}

export interface SeedCapability {
	min?: number;
	max?: number;
}

export interface ReferenceRoleCapability {
	/** Most references of this role. */
	max: number;
	/** Fewest references of this role (e.g. an image-to-video model needs a `start_frame`). */
	min?: number;
	label?: string;
	description?: string;
}

export interface ReferenceCapability {
	/** Supported roles and their per-role limits. Roles not listed are unsupported. */
	roles: Partial<Readonly<Record<ReferenceRole, ReferenceRoleCapability>>>;
	/** Most references across all roles. */
	maxTotal?: number;
}

export interface NumberParamSpec {
	type: 'number' | 'integer';
	min?: number;
	max?: number;
	step?: number;
	default?: number;
	label?: string;
	description?: string;
}

export interface EnumParamSpec {
	type: 'enum';
	options: readonly (string | number)[];
	default?: string | number;
	label?: string;
	description?: string;
}

export interface BooleanParamSpec {
	type: 'boolean';
	default?: boolean;
	label?: string;
	description?: string;
}

/** A model-specific parameter (`guidance`, `motion_strength`, `style`, …). */
export type ExtraParamSpec = NumberParamSpec | EnumParamSpec | BooleanParamSpec;

/** Rough timing used for progress estimates (`expectedDurationFor`). */
export interface TimingCapability {
	/** Fixed cost of one request in ms. */
	baseMs: number;
	/** Extra ms per output beyond the first. */
	perItemMs?: number;
	/** Extra ms per second of requested duration (video/audio). */
	perSecondMs?: number;
	/** Extra ms per megapixel of the requested resolution. */
	perMegapixelMs?: number;
}

/** Presentation-only fields; overlays may set these (see `mergeCapabilities`). */
export interface CapabilityPresentation {
	name?: string;
	description?: string;
	badges?: readonly string[];
	icon?: string;
	group?: string;
}

/** Everything a generative model accepts. Absent sections mean "unsupported". */
export interface ModelCapabilities extends CapabilityPresentation {
	id: string;
	media: GenerationMediaKind;
	prompt?: PromptCapability;
	/** Negative prompt support (`true` or limits). */
	negativePrompt?: boolean | TextFieldCapability;
	/** System prompt support (`true` or limits). */
	systemPrompt?: boolean | TextFieldCapability;
	/** E.g. `['1:1', '16:9', '9:16']`. */
	aspectRatios?: EnumCapability<string>;
	/** E.g. `['512x512', '1024x1024']`, `['720p', '1080p']` or `['1k', '2k', '4k']`, low → high. */
	resolutions?: EnumCapability<string>;
	/** Ordered low → high, e.g. `['draft', 'standard', 'high']`. */
	quality?: EnumCapability<string>;
	count?: CountCapability;
	duration?: DurationCapability;
	seed?: boolean | SeedCapability;
	references?: ReferenceCapability;
	/** Accepts a source to edit (`mode: 'edit'`). */
	editing?: boolean;
	/** Accepts a source plus a `mask` reference (`mode: 'inpaint'`). */
	inpainting?: boolean;
	params?: Readonly<Record<string, ExtraParamSpec>>;
	timing?: TimingCapability;
}

export interface GenerationReference {
	/** Asset id (opaque to this library). */
	id: string;
	role: ReferenceRole;
	url?: string;
}

export type GenerationMode = 'generate' | 'edit' | 'inpaint';

export type GenerationParamValue = string | number | boolean;

/** A request for one model. Every field is optional; the planner fills and fixes. */
export interface GenerationRequest {
	model?: string;
	prompt?: string;
	negativePrompt?: string;
	systemPrompt?: string;
	aspectRatio?: string;
	resolution?: string;
	quality?: string;
	count?: number;
	/** Seconds. */
	duration?: number;
	seed?: number;
	mode?: GenerationMode;
	references?: GenerationReference[];
	params?: Record<string, GenerationParamValue>;
}

/** Fields of {@link GenerationRequest} the planner knows about, in planning order. */
export const GENERATION_REQUEST_FIELDS = [
	'model',
	'prompt',
	'negativePrompt',
	'systemPrompt',
	'aspectRatio',
	'resolution',
	'quality',
	'count',
	'duration',
	'seed',
	'mode',
	'references',
	'params'
] as const;

/** Text field limits normalized from `boolean | TextFieldCapability`. */
export function textFieldCapability(value: boolean | TextFieldCapability | undefined): TextFieldCapability | null {
	if (!value) return null;
	return value === true ? {} : value;
}

/** Seed limits normalized from `boolean | SeedCapability`. */
export function seedCapability(value: boolean | SeedCapability | undefined): SeedCapability | null {
	if (!value) return null;
	return value === true ? {} : value;
}

/** Supported reference roles of a model in {@link REFERENCE_ROLES} order. */
export function supportedReferenceRoles(caps: ModelCapabilities): ReferenceRole[] {
	const roles = caps.references?.roles ?? {};
	return REFERENCE_ROLES.filter((role) => (roles[role]?.max ?? 0) > 0);
}

/** Supported generation modes of a model. */
export function supportedModes(caps: ModelCapabilities): GenerationMode[] {
	const modes: GenerationMode[] = ['generate'];
	if (caps.editing) modes.push('edit');
	if (caps.inpainting) modes.push('inpaint');
	return modes;
}

const PRESENTATION_KEYS = ['name', 'description', 'badges', 'icon', 'group'] as const;

/** A partial model entry used to decorate (or add) models locally. */
export type CapabilityOverlay = Partial<ModelCapabilities> & { id: string };

/**
 * Merges server-reported capabilities with a local overlay. For models the
 * server knows, every capability value comes from `remote`; the overlay only
 * contributes presentation fields (`name`, `description`, `badges`, `icon`,
 * `group`), filling in or replacing the remote ones. Overlay entries for
 * models the server does not report are appended when they are complete
 * (have a `media` kind). Remote order is kept; overlay-only models follow in
 * overlay order.
 */
export function mergeCapabilities(
	remote: readonly ModelCapabilities[],
	overlay: readonly CapabilityOverlay[] = []
): ModelCapabilities[] {
	const overlayById = new Map(overlay.map((entry) => [entry.id, entry]));
	const remoteIds = new Set(remote.map((model) => model.id));
	const merged = remote.map((model) => {
		const extra = overlayById.get(model.id);
		if (!extra) return { ...model };
		const next: ModelCapabilities = { ...model };
		for (const key of PRESENTATION_KEYS) {
			if (extra[key] !== undefined) (next as any)[key] = extra[key];
		}
		return next;
	});
	for (const entry of overlay) {
		if (remoteIds.has(entry.id) || !entry.media) continue;
		remoteIds.add(entry.id);
		merged.push({ ...(entry as ModelCapabilities) });
	}
	return merged;
}
