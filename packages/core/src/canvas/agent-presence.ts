/**
 * UI-agnostic agent presence trajectory, inspection anchor, and cursor rotation math.
 */

export const DEFAULT_CURSOR_INACTIVITY_MS = 12000;

export interface CanvasAgentCursor {
	id: string;
	userId?: string;
	x: number;
	y: number;
	username?: string;
	avatarUrl?: string;
	color?: string;
	isAgent?: boolean;
	isServiceAccount?: boolean;
	role?: string;
	statusText?: string;
	message?: string;
	note?: string;
	lastUpdate?: number;
	timeoutMs?: number;
	transitionDurationMs?: number;
	customEase?: string;
	targetNodeId?: string;
	targetNodeCenter?: { x: number; y: number } | null;
	isModalOpen?: boolean;
	isClicking?: boolean;
}

/**
 * Deterministic string hash function used to derive consistent per-agent / per-node variances.
 */
export function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

export type CardInspectionZone = 'header' | 'action' | 'body' | 'footer';

export const CARD_INSPECTION_ZONES: Record<CardInspectionZone, { x: number; y: number }> = {
	header: { x: 36, y: 24 },
	action: { x: 180, y: 28 },
	body: { x: 60, y: 84 },
	footer: { x: 165, y: 122 }
};

/**
 * Computes a varied inspection anchor position on a node/card (default width ~250px, height ~160px).
 * Generates distinct natural resting spots so agents do not appear at the exact same coordinates.
 */
export function getAgentCardAnchor(
	agentId: string = 'agent',
	nodeId: string = 'node',
	zone: CardInspectionZone | number = 0,
	options?: { randomJitter?: boolean; width?: number; height?: number }
): { x: number; y: number; zoneName: CardInspectionZone } {
	const zoneNames: CardInspectionZone[] = ['header', 'action', 'body', 'footer'];
	const zoneName =
		typeof zone === 'string' ? zone : zoneNames[Math.abs(Math.floor(zone)) % zoneNames.length];

	const base = CARD_INSPECTION_ZONES[zoneName];
	const seed = hashString(`${agentId}:${nodeId}:${zoneName}`);

	// Deterministic pseudo-random base offset within zone (-8px to +8px in X, -4px to +4px in Y)
	const offsetX = (seed % 17) - 8;
	const offsetY = ((seed >> 4) % 9) - 4;

	// Organic micro-randomness (live jitter ±12px in X, ±8px in Y when opted in)
	const jitterX = options?.randomJitter ? (Math.random() - 0.5) * 24 : 0;
	const jitterY = options?.randomJitter ? (Math.random() - 0.5) * 16 : 0;

	const maxX = options?.width ? Math.max(24, options.width - 20) : 230;
	const maxY = options?.height ? Math.max(20, options.height - 15) : 145;

	return {
		x: Math.max(16, Math.min(maxX, Math.round(base.x + offsetX + jitterX))),
		y: Math.max(14, Math.min(maxY, Math.round(base.y + offsetY + jitterY))),
		zoneName
	};
}

export interface CurvedPathOptions {
	arcHeight?: number; // negative lifts upward in screen coordinates, e.g. -30px
	wobble?: number; // subtle lateral sway, e.g. 3px
}

/**
 * Calculates coordinates along a natural curved trajectory with parabolic lift
 * and optional lateral sway, replacing robotic straight linear movement.
 */
export function calculateCurvedPath(
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	progress: number,
	options?: CurvedPathOptions
): { x: number; y: number } {
	const p = Math.max(0, Math.min(1, progress));
	const arcHeight = options?.arcHeight ?? -30;
	const wobble = options?.wobble ?? 0;

	// Parabolic lift peak at mid-flight (p = 0.5)
	const arc = Math.sin(p * Math.PI) * arcHeight;
	// Natural full-cycle lateral sway
	const sway = Math.sin(p * Math.PI * 2) * wobble;

	const currentX = fromX + (toX - fromX) * p + sway;
	const currentY = fromY + (toY - fromY) * p + arc;

	return { x: currentX, y: currentY };
}

/**
 * Computes natural drag movement timing, parabolic arc amplitude, and grip offset
 * based on distance traveled and a deterministic seed.
 */
export function getNaturalMovementTiming(
	distance: number,
	seedStr: string = 'drag'
): {
	duration: number;
	arcHeight: number;
	grabOffset: { x: number; y: number };
} {
	const seed = hashString(seedStr);
	const absDist = Math.abs(distance);

	// Scale duration with distance: clamped between 500ms and 1000ms
	const distDuration = 560 + Math.min(340, (absDist / 1000) * 300);
	const variance = (seed % 120) - 60; // -60ms to +60ms
	const duration = Math.round(Math.max(500, Math.min(1000, distDuration + variance)));

	// Arc height: larger distance lifts slightly higher (-24px to -44px)
	const baseArc = -24 - Math.min(16, (absDist / 1000) * 14);
	const arcVariance = ((seed >> 3) % 9) - 4; // -4px to +4px
	const arcHeight = Math.round(baseArc + arcVariance);

	// Varied grab offset across the card header
	const grabX = 24 + (seed % 24);
	const grabY = 12 + ((seed >> 2) % 14);

	return {
		duration,
		arcHeight,
		grabOffset: { x: grabX, y: grabY }
	};
}

/**
 * Computes variable CSS transition duration in ms based on distance and seed.
 */
export function getCursorTransitionDuration(
	distance: number,
	seedStr: string = 'cursor',
	options?: { naturalVariance?: boolean }
): number {
	const seed = hashString(seedStr);
	const jitter = (seed % 60) - 30; // -30ms to +30ms
	// Natural timing variance (±15% when opted in)
	const variance = options?.naturalVariance ? 0.85 + Math.random() * 0.3 : 1;

	let baseDuration = 560;
	if (distance < 60) {
		baseDuration = 340;
	} else if (distance < 300) {
		baseDuration = 440;
	}
	const computed = Math.round((baseDuration + jitter) * variance);
	return Math.max(300, Math.min(650, computed));
}

/**
 * Calculates the SVG rotation angle for aligning a presence cursor arrow
 * toward the center of a target node.
 */
export function calculateCursorArrowRotation(
	cursor: { x: number; y: number; isModalOpen?: boolean },
	targetCenter?: { x: number; y: number } | null,
	isAgentOrServiceAccount: boolean = false,
	isModalOpen?: boolean,
	currentRotation: number = 0
): { shouldPoint: boolean; rotationDeg: number } {
	const hasModal = isModalOpen ?? Boolean(cursor.isModalOpen);
	const shouldPoint = Boolean(targetCenter && (isAgentOrServiceAccount || hasModal));

	if (!shouldPoint || !targetCenter) {
		return { shouldPoint: false, rotationDeg: 0 };
	}

	const dx = targetCenter.x - cursor.x;
	const dy = targetCenter.y - cursor.y;
	const dist = Math.hypot(dx, dy);

	if (dist < 2) {
		return { shouldPoint: true, rotationDeg: currentRotation };
	}

	const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
	// Default unrotated SVG pointer tip faces -135deg (up-and-left).
	// Rotating by (angleDeg + 135) directs the tip directly toward the target.
	const rawTargetDeg = angleDeg + 135;

	// Shortest rotation unwrapping
	const diff = ((((rawTargetDeg - currentRotation + 180) % 360) + 360) % 360) - 180;
	return {
		shouldPoint: true,
		rotationDeg: currentRotation + diff
	};
}

/**
 * Sanitizes an agent name by removing any leading '@' prefix(es) and trimming whitespace.
 */
export function formatAgentCursorName(nameOrUsername?: string | null): string {
	if (!nameOrUsername) return 'Agent';
	const cleaned = nameOrUsername.trim().replace(/^@+/, '').trim();
	return cleaned || 'Agent';
}

/**
 * Determines whether a given presence cursor represents an autonomous agent.
 */
export function isAgentCursor(cursor: Partial<CanvasAgentCursor>): boolean {
	if (cursor.isAgent) return true;
	if (cursor.userId?.startsWith('agent_') || cursor.userId?.startsWith('agent-')) return true;
	if (cursor.id?.startsWith('agent-') || cursor.id?.startsWith('agent_')) return true;
	if (cursor.username?.startsWith('@agent_') || cursor.username?.startsWith('agent_')) return true;

	const roleLower = cursor.role?.toLowerCase() || '';
	if (
		roleLower.includes('agent') ||
		roleLower.includes('specialist') ||
		roleLower === 'planner' ||
		roleLower === 'coordinator' ||
		roleLower === 'executor' ||
		roleLower === 'validator' ||
		roleLower === 'supervisor'
	) {
		return true;
	}

	const usernameLower = (cursor.username || '').toLowerCase();
	if (usernameLower.includes('agent') || usernameLower.includes('specialist')) {
		return true;
	}

	return false;
}
