/**
 * An effects provider's `EffectSequence` (what a sequence template fills to) as animation shots:
 * each shot keeps its framing and camera moves, its layers and its transition. Its title and
 * caption become overlay word layers placed in the shot's framing. Rects and framings are scaled
 * from the sequence's stage to the artwork.
 */

import type { EffectRect, EffectSequence, EffectSequenceShot } from '../effects/types.js';
import type { MotionCamera, MotionScene, MotionShot, MotionShotLayer } from './types.js';

export interface MotionShotsFromSequence {
	shots: MotionShot[];
	/** What could not be carried over, in sentences. */
	notes: string[];
}

export interface MotionSequenceOptions {
	/** The artwork size the shots are for (default the sequence's stage). */
	width?: number;
	height?: number;
	/** Shot ids already used (new ones avoid them). */
	shotIds?: Iterable<string>;
	/** Layer ids already used (new ones avoid them). */
	layerIds?: Iterable<string>;
	/** The provider the sequence's effects come from, saved on layers and transitions. */
	provider?: string;
}

const fresh = (used: Set<string>, base: string): string => {
	const clean = base.replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z_]+/, '') || 'item';
	if (!used.has(clean)) return used.add(clean), clean;
	for (let i = 2; ; i++) if (!used.has(`${clean}-${i}`)) return used.add(`${clean}-${i}`), `${clean}-${i}`;
};

/** The shots of a sequence, sized for the artwork (see the module comment). */
export function motionShotsFromSequence(sequence: EffectSequence, options: MotionSequenceOptions = {}): MotionShotsFromSequence {
	const sx = (options.width ?? sequence.stage.width) / sequence.stage.width;
	const sy = (options.height ?? sequence.stage.height) / sequence.stage.height;
	const scale = (r: EffectRect): EffectRect => ({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy });
	const full: EffectRect = { x: 0, y: 0, width: sequence.stage.width * sx, height: sequence.stage.height * sy };
	const shotIds = new Set(options.shotIds ?? []);
	const layerIds = new Set(options.layerIds ?? []);
	const notes: string[] = [];
	const provider = options.provider ? { provider: options.provider } : {};
	const shots = sequence.shots.map((s: EffectSequenceShot, i): MotionShot => {
		const id = fresh(shotIds, `shot${i + 1}`);
		const framing = s.camera?.framing ? scale(s.camera.framing) : undefined;
		const view = framing ?? full;
		const layers: MotionShotLayer[] = [];
		for (const layer of s.layers) {
			if (layer.subject && 'video' in layer.subject) {
				notes.push(`Shot ${i + 1}: a layer plays a video, which an animation cannot; it was left out (the video editor plays it).`);
				continue;
			}
			const { id: given, rect, subject, ...rest } = layer;
			layers.push({ ...rest, id: fresh(layerIds, given ?? 'layer'), ...(subject ? { subject: subject as MotionShotLayer['subject'] } : {}), ...(rect ? { rect: scale(rect) } : {}), ...(layer.effect ? provider : {}) });
		}
		// The title and caption are words over the shot, placed in its framing.
		if (s.title) layers.push({ id: fresh(layerIds, `${id}-title`), subject: { text: s.title }, role: 'overlay', rect: { x: view.x + view.width * 0.1, y: view.y + view.height * 0.38, width: view.width * 0.8, height: view.height * 0.24 } });
		if (s.caption) layers.push({ id: fresh(layerIds, `${id}-caption`), subject: { text: s.caption }, role: 'overlay', rect: { x: view.x + view.width * 0.1, y: view.y + view.height * 0.8, width: view.width * 0.8, height: view.height * 0.1 } });
		const camera = framing || s.camera?.in !== undefined || s.camera?.during !== undefined ? ({ ...(framing ?? {}), ...(s.camera?.in !== undefined ? { in: s.camera.in } : {}), ...(s.camera?.during !== undefined ? { during: s.camera.during } : {}) } as MotionCamera) : undefined;
		return {
			id,
			label: s.title ?? s.caption ?? `Shot ${i + 1}`,
			...(camera ? { camera } : {}),
			run: [],
			hold: s.hold,
			...(layers.length ? { layers } : {}),
			...(i > 0 && s.transition ? { transition: { ...s.transition, ...provider } } : {})
		};
	});
	return { shots, notes };
}

/** A new scene from a sequence: an empty artwork the size of its stage, and its shots. */
export function motionSceneFromSequence(sequence: EffectSequence, options: Pick<MotionSequenceOptions, 'provider'> & { background?: string } = {}): { scene: MotionScene; notes: string[] } {
	const { shots, notes } = motionShotsFromSequence(sequence, options);
	return {
		scene: { version: 1, name: sequence.name, ...(sequence.title ? { description: sequence.title } : {}), artwork: { width: sequence.stage.width, height: sequence.stage.height, background: options.background ?? '#000000', nodes: [] }, shots },
		notes
	};
}
