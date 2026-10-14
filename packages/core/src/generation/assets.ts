import {
	REFERENCE_ROLES,
	mediaTypeMatches,
	normalizeReferenceRole,
	referenceRoleLabel,
	supportedReferenceRoles,
	type ModelCapabilities,
	type ReferenceRole,
	type ReferenceRoleCapability
} from './capabilities.js';
import type { PlanAssetMention } from './plan.js';

/** A role a model accepts for asset mentions / references, for pickers. */
export interface AssetRoleOption {
	role: ReferenceRole;
	label: string;
	description?: string;
	min: number;
	max: number;
	accepts?: string[];
}

/** What the host knows about an asset (for planning, records and drift checks). */
export interface AssetInfo {
	id: string;
	label?: string;
	/** MIME type or media kind (`image/png`, `image`). */
	mediaType?: string;
	/** Content hash; a change is reported as `asset-changed` drift. */
	contentHash?: string;
	url?: string;
}

/** Assets by id: a lookup function, a map, or a list. */
export type AssetLookup =
	| ((id: string) => AssetInfo | null | undefined)
	| ReadonlyMap<string, AssetInfo>
	| readonly AssetInfo[];

/** Normalizes an {@link AssetLookup} to a function. */
export function toAssetResolver(lookup: AssetLookup | undefined): ((id: string) => AssetInfo | undefined) | undefined {
	if (!lookup) return undefined;
	if (typeof lookup === 'function') return (id) => lookup(id) ?? undefined;
	if (lookup instanceof Map) return (id) => lookup.get(id);
	const byId = new Map((lookup as readonly AssetInfo[]).map((asset) => [asset.id, asset]));
	return (id) => byId.get(id);
}

function roleCap(caps: ModelCapabilities, role: ReferenceRole): ReferenceRoleCapability | undefined {
	const cap = caps.references?.roles[role];
	if (cap && cap.max > 0) return cap;
	if (role === 'mask' && caps.inpainting) return { max: 1 };
	return undefined;
}

/** The roles a model accepts, with labels, limits and accepted media (inpainting adds `mask`). */
export function getAssetRoleOptions(caps: ModelCapabilities): AssetRoleOption[] {
	const roles = supportedReferenceRoles(caps);
	if (caps.inpainting && !roles.includes('mask')) roles.push('mask');
	return roles.map((role) => {
		const cap = roleCap(caps, role) ?? { max: 1 };
		return {
			role,
			label: referenceRoleLabel(role, caps),
			...(cap.description ? { description: cap.description } : {}),
			min: cap.min ?? 0,
			max: cap.max,
			...(cap.accepts?.length ? { accepts: [...cap.accepts] } : {})
		};
	});
}

export type AssetMentionIssueCode = 'missing-role' | 'unsupported-role' | 'renamed-role' | 'media-mismatch' | 'too-many';

export interface AssetMentionIssue {
	/** Index of the mention in the input. */
	index: number;
	id: string;
	role?: ReferenceRole;
	code: AssetMentionIssueCode;
	/** `error` blocks generation under the `error` strategy; `warning` is fixed by planning. */
	severity: 'error' | 'warning';
	message: string;
	/** The role the planner will use instead (`renamed-role`). */
	suggestion?: ReferenceRole;
}

export interface AssetMentionValidation {
	ok: boolean;
	issues: AssetMentionIssue[];
	/** Mentions per (canonical) role. */
	counts: Record<string, number>;
	/** Roles below their `min`. */
	missing: { role: ReferenceRole; min: number; count: number }[];
}

/**
 * Checks asset mentions against what a model accepts, per mention, for UI
 * feedback (badges, popovers). Mirrors the planner: aliases (`style` →
 * `style_ref`) are accepted with a `renamed-role` warning, unsupported roles,
 * media types the role does not accept and mentions beyond a role's `max`
 * are reported, and roles below their `min` are listed in `missing`.
 */
export function validateAssetMentions(
	mentions: readonly PlanAssetMention[],
	caps: ModelCapabilities,
	options: { assets?: AssetLookup } = {}
): AssetMentionValidation {
	const resolve = toAssetResolver(options.assets);
	const issues: AssetMentionIssue[] = [];
	const counts: Record<string, number> = {};
	mentions.forEach((mention, index) => {
		const id = mention.id;
		const label = `@${mention.label ?? id}`;
		if (!mention.role) {
			issues.push({ index, id, code: 'missing-role', severity: 'warning', message: `${label} has no role.` });
			return;
		}
		let role: ReferenceRole = mention.role;
		if (!roleCap(caps, role)) {
			const alias = normalizeReferenceRole(role, caps);
			if (alias !== role && roleCap(caps, alias)) {
				issues.push({
					index,
					id,
					role,
					code: 'renamed-role',
					severity: 'warning',
					suggestion: alias,
					message: `${label}: this model calls "${role}" ${referenceRoleLabel(alias, caps)} (${alias}).`
				});
				role = alias;
			} else {
				issues.push({
					index,
					id,
					role,
					code: 'unsupported-role',
					severity: 'error',
					message: `${label}: ${caps.name ?? caps.id} does not accept ${referenceRoleLabel(role, caps).toLowerCase()} assets.`
				});
				return;
			}
		}
		const cap = roleCap(caps, role)!;
		const mediaType = mention.mediaType ?? resolve?.(id)?.mediaType;
		if (mediaType !== undefined && !mediaTypeMatches(mediaType, cap.accepts)) {
			issues.push({
				index,
				id,
				role,
				code: 'media-mismatch',
				severity: 'error',
				message: `${label} is ${mediaType}; ${referenceRoleLabel(role, caps)} accepts ${(cap.accepts ?? []).join(', ')}.`
			});
			return;
		}
		counts[role] = (counts[role] ?? 0) + 1;
		if (counts[role] > cap.max) {
			issues.push({
				index,
				id,
				role,
				code: 'too-many',
				severity: 'warning',
				message: `${label}: at most ${cap.max} ${referenceRoleLabel(role, caps).toLowerCase()} asset(s); extra ones are left out.`
			});
		}
	});
	const missing = getAssetRoleOptions(caps)
		.filter((option) => (counts[option.role] ?? 0) < option.min)
		.map((option) => ({ role: option.role, min: option.min, count: counts[option.role] ?? 0 }));
	return { ok: !issues.some((issue) => issue.severity === 'error') && missing.length === 0, issues, counts, missing };
}

/**
 * Joins mentions (`{ handle, role }`, e.g. from `extractMentions(text, { details: true, roles: true })`)
 * with your assets: each handle is looked up by id, then by label
 * (case-insensitive). Mentions that are not assets are left out.
 */
export function resolveAssetMentions(
	mentions: readonly { handle: string; role?: string | null }[],
	assets: readonly AssetInfo[]
): PlanAssetMention[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const byLabel = new Map(assets.filter((a) => a.label).map((asset) => [asset.label!.toLowerCase(), asset]));
	const result: PlanAssetMention[] = [];
	for (const mention of mentions) {
		const asset = byId.get(mention.handle) ?? byLabel.get(mention.handle.toLowerCase());
		if (!asset) continue;
		result.push({
			id: asset.id,
			label: mention.handle,
			...(mention.role ? { role: mention.role } : {}),
			...(asset.mediaType !== undefined ? { mediaType: asset.mediaType } : {}),
			...(asset.contentHash !== undefined ? { contentHash: asset.contentHash } : {}),
			...(asset.url !== undefined ? { url: asset.url } : {})
		});
	}
	return result;
}

/** Built-in roles as picker options, for when no model is selected. */
export function defaultAssetRoleOptions(): AssetRoleOption[] {
	return REFERENCE_ROLES.map((role) => ({ role, label: referenceRoleLabel(role), min: 0, max: 1 }));
}

/** An asset mention prepared for display as a chip. */
export interface AssetMentionChip {
	/** Position among the chips. */
	index: number;
	/** Offset of the `@` in the text, when known (for `setMentionRoleInText`). */
	start?: number;
	handle: string;
	asset: AssetInfo;
	role?: ReferenceRole;
	/** Display label of the role (the model's, else built-in). */
	roleLabel?: string;
	/** Problems with this mention for the model (`validateAssetMentions`). */
	issues: AssetMentionIssue[];
}

/**
 * Chips for the asset mentions among `mentions` (e.g. `findTextMentions(text)`
 * from `@pixerate/editor/serializers`): each mention whose handle is an asset
 * id or label, with its role label and the problems the model has with it.
 */
export function describeAssetMentions(
	mentions: readonly { handle: string; role?: string | null; start?: number }[],
	assets: readonly AssetInfo[],
	caps?: ModelCapabilities
): AssetMentionChip[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const byLabel = new Map(assets.filter((a) => a.label).map((asset) => [asset.label!.toLowerCase(), asset]));
	const chips: AssetMentionChip[] = [];
	for (const mention of mentions) {
		const asset = byId.get(mention.handle) ?? byLabel.get(mention.handle.toLowerCase());
		if (!asset) continue;
		const role = mention.role || undefined;
		chips.push({
			index: chips.length,
			...(mention.start !== undefined ? { start: mention.start } : {}),
			handle: mention.handle,
			asset,
			...(role
				? { role, roleLabel: referenceRoleLabel(caps ? normalizeReferenceRole(role, caps) : role, caps) }
				: {}),
			issues: []
		});
	}
	if (caps) {
		const validation = validateAssetMentions(
			chips.map((chip) => ({
				id: chip.asset.id,
				label: chip.handle,
				...(chip.role ? { role: chip.role } : {}),
				...(chip.asset.mediaType ? { mediaType: chip.asset.mediaType } : {})
			})),
			caps
		);
		for (const issue of validation.issues) chips[issue.index].issues.push(issue);
	}
	return chips;
}
