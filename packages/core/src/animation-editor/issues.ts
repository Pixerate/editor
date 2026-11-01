/**
 * Problems with a scene, as data: every issue has a stable `code`, a severity, the shot and
 * command it is in and the ids it is about, beside its prose `message`, so an agent (or a UI)
 * can act on it without parsing sentences.
 */

/** `error`: the scene does not play as written. `warning`: it plays, but probably not as meant. `note`: may well be intended. */
export type MotionIssueSeverity = 'error' | 'warning' | 'note';

/** Every issue code with its severity and what it means. */
export const MOTION_ISSUE_CODES = {
	'no-shots': { severity: 'note', wording: 'The scene has no shots yet.' },
	'duplicate-shot-id': { severity: 'error', wording: 'Two shots share an id.' },
	'unknown-target': { severity: 'error', wording: 'A command names a node the artwork does not have.' },
	'unknown-path': { severity: 'error', wording: 'A follow command names a path the artwork does not have.' },
	'not-a-path': { severity: 'error', wording: 'A follow path must be a path node, not a group.' },
	'reveal-no-box': { severity: 'warning', wording: 'A wipe, iris or split cannot clip a node with no width or height (a lone straight line), so it fades instead.' },
	'driver-cycle': { severity: 'error', wording: 'Drivers follow each other in a loop, so none of them has a value.' },
	'split-not-text': { severity: 'warning', wording: 'A command splits a target into letters, but it is not a group of letter paths, so it animates as a whole.' },
	'unknown-clip': { severity: 'error', wording: 'A play command names a clip the scene does not have.' },
	'unknown-shape': { severity: 'error', wording: 'A morph names a shape the artwork does not have.' },
	'match-self': { severity: 'error', wording: 'A match turns a group into itself or into a group it holds (or that holds it).' },
	'match-unpaired': { severity: 'note', wording: 'Parts of a match\'s "into" group have no partner in the target, so they do not appear.' },
	'unknown-effect': { severity: 'error', wording: 'An effect command names an effect the node does not have.' },
	'unknown-effect-param': { severity: 'error', wording: 'An effect command names a parameter that is not a number of that effect.' },
	'unknown-frame': { severity: 'error', wording: 'A camera frames a node the artwork does not have.' },
	'invalid-camera': { severity: 'error', wording: 'A camera rectangle has no area.' },
	'invalid-color': { severity: 'error', wording: 'A colour cannot be read.' },
	'paint-not-color': { severity: 'warning', wording: 'A style command recolours a gradient or empty paint, which only switches at the end, or a colour pulse has no solid paint to tint.' },
	'overlap': { severity: 'warning', wording: 'Two commands change the same property of a node at the same time; the later one wins.' },
	'enter-visible': { severity: 'warning', wording: 'A node enters while it is already showing, so it blinks out first.' },
	'exit-hidden': { severity: 'warning', wording: 'A node exits or animates while it is hidden.' },
	'out-of-frame': { severity: 'warning', wording: 'A node a command animates ends up outside the camera.' },
	'too-fast': { severity: 'warning', wording: 'A change is too quick to follow.' },
	'spring-cut-short': { severity: 'warning', wording: 'A spring is given a duration shorter than it takes to settle, so it jumps to its end.' },
	'unknown-cue': { severity: 'error', wording: 'A shot is cued to a beat with no beat grid, or to a word the narration does not have.' },
	'cue-missed': { severity: 'warning', wording: 'A shot starts after its cue, because the shot before runs past it.' },
	'trigger-loop': { severity: 'note', wording: 'A scene that plays on a trigger ignores its loop.' },
	'click-cue': { severity: 'warning', wording: 'A shot of a click-triggered scene is cued, but clicks decide when its shots start.' },
	'click-one-shot': { severity: 'note', wording: 'A click-triggered scene has one shot, so every click replays it.' },
	'scene-too-long': { severity: 'warning', wording: 'The scene runs past its target length.' },
	'scene-too-short': { severity: 'warning', wording: 'The scene ends before its target length.' },
	'unknown-control-color': { severity: 'warning', wording: 'A control stands for a colour the scene never uses.' },
	'empty-shot': { severity: 'note', wording: 'A shot neither moves the camera nor runs a command.' },
	'camera-aspect': { severity: 'note', wording: 'A camera rectangle has a different shape from the artwork, so it is letterboxed.' },
	'camera-move-first-shot': { severity: 'note', wording: 'The first shot cuts to its framing, so the move its camera gets in with does not play.' },
	'camera-move-not-played': { severity: 'note', wording: 'A shot names a camera move, but there is no effects provider with camera moves to play it, so the camera eases instead.' },
	'camera-move-unknown': { severity: 'error', wording: 'A shot names a camera move the effects provider does not have, or one of the wrong role.' },
	'camera-move-values': { severity: 'error', wording: 'A camera move\'s preset or values do not fit its controls.' }
} as const satisfies Record<string, { severity: MotionIssueSeverity; wording: string }>;

export type MotionIssueCode = keyof typeof MOTION_ISSUE_CODES;

export interface MotionIssue {
	code: MotionIssueCode;
	severity: MotionIssueSeverity;
	message: string;
	/** Id of the shot it is in, when it is in one. */
	shot?: string;
	/** Index of the command in that shot's `run`. */
	command?: number;
	/** Node ids it is about. */
	ids?: string[];
	/** What was measured, what was needed and in what unit (e.g. 80 vs 120 ms). */
	measured?: number;
	needed?: number;
	unit?: 'ms' | 's' | 'units';
}

export function motionIssue(code: MotionIssueCode, message: string, extra: Omit<MotionIssue, 'code' | 'severity' | 'message'> = {}): MotionIssue {
	return { code, severity: MOTION_ISSUE_CODES[code].severity, message, ...extra };
}

/** A stable key for an issue (code and ids, else code and place), to compare two checks. */
export function motionIssueKey(issue: MotionIssue): string {
	if (issue.ids?.length) return `${issue.code}:${[...issue.ids].sort().join(',')}`;
	return `${issue.code}@${issue.shot ?? ''}#${issue.command ?? ''}`;
}

/** One line: `Shot "intro", command 2: …`. */
export function motionIssueLine(issue: MotionIssue): string {
	const where = issue.shot !== undefined ? `Shot "${issue.shot}"${issue.command !== undefined ? `, command ${issue.command + 1}` : ''}: ` : '';
	return `${where}${issue.message}`;
}

/** Optimal string alignment (Damerau–Levenshtein) distance. */
function editDistance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[a.length][b.length];
}

/** The candidate closest to `word` (case-insensitive), if it is within a third of its length. */
export function suggestName(word: string, candidates: Iterable<string>): string | undefined {
	const w = word.toLowerCase();
	let best: string | undefined;
	let bestDistance = Infinity;
	for (const c of candidates) {
		const distance = editDistance(w, c.toLowerCase());
		if (distance < bestDistance) {
			best = c;
			bestDistance = distance;
		}
	}
	return best !== undefined && bestDistance <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

/** `"sunn" (did you mean "sun"?)`, or just `"sunn"`. */
export function namedWithSuggestion(word: string, candidates: Iterable<string>): string {
	const s = suggestName(word, candidates);
	return s !== undefined && s !== word ? `"${word}" (did you mean "${s}"?)` : `"${word}"`;
}
