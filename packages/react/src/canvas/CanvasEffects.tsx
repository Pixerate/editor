import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
	CANVAS_EFFECT_MISSING_PATTERN,
	canvasEffectErrorReason,
	canvasEffectStatus,
	createCanvasEffectsController,
	createCanvasEffectsToolProvider,
	isShapeDescription,
	runCanvasNodeEffect,
	type CanvasEffectsController,
	type CanvasEffectsControllerOptions,
	type CanvasEffectsToolProviderOptions,
	type CanvasNode,
	type CanvasScenesStore,
	type CanvasShapeEffect,
	type ShapeDescription
} from '@pixerate/editor/canvas';
import type { EffectProvider } from '@pixerate/editor/effects';
import type { ToolRegistry } from '@pixerate/editor/tools';
import { EffectParameters, EffectsBrowser, useEffectDescription } from '../effects';

const ProviderContext = createContext<EffectProvider | null>(null);

/**
 * Gives the shape nodes inside it an effects provider (see `@pixerate/editor/effects`), so their
 * `shape.effect` is drawn. Without one (or outside it) effects are kept and not drawn.
 */
export function CanvasEffectsProvider({ provider, children }: { provider: EffectProvider | null | undefined; children: React.ReactNode }) {
	return <ProviderContext.Provider value={provider ?? null}>{children}</ProviderContext.Provider>;
}

/** The effects provider from the nearest `<CanvasEffectsProvider>`, or `null`. */
export const useCanvasEffectsProviderContext = (): EffectProvider | null => useContext(ProviderContext);

/**
 * Draws a shape node's effect: `fill` inside the shape (clipped to `clipPath`, an SVG path in the
 * node's own pixels), `overlay` over the whole node. Animated effects play until unmounted.
 */
export function CanvasNodeEffectLayer({ effect, width, height, clipPath, clipTransform }: { effect: CanvasShapeEffect; width: number; height: number; clipPath?: string; clipTransform?: string }) {
	const provider = useCanvasEffectsProviderContext();
	const ref = useRef<HTMLCanvasElement>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
	const pw = Math.max(1, Math.round(width * dpr));
	const ph = Math.max(1, Math.round(height * dpr));
	const key = JSON.stringify(effect);
	const status = provider ? canvasEffectStatus(effect, provider) : null;
	useEffect(() => {
		const canvas = ref.current;
		if (!provider || !canvas || !canvasEffectStatus(effect, provider).ok) return;
		setFailed(null);
		const run = runCanvasNodeEffect({ provider, effect, target: canvas, onError: (e) => setFailed(canvasEffectErrorReason(effect, e)) });
		return () => run.stop();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [provider, key, pw, ph]);
	const clipId = useMemo(() => `pixerate-effect-clip-${Math.random().toString(36).slice(2)}`, []);
	if (!provider || !status || !(width > 0 && height > 0)) return null;
	const missing = !status.ok ? status.reason : failed;
	if (missing) return <CanvasEffectMissing reason={missing} effect={effect} width={width} height={height} clipPath={clipPath} clipTransform={clipTransform} />;
	const style: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: effect.opacity ?? 1 };
	const canvas = <canvas ref={ref} width={pw} height={ph} style={{ width: '100%', height: '100%', display: 'block' }} data-canvas-effect={effect.effect} />;
	if (effect.mode === 'overlay' || !clipPath) return <div style={style}>{canvas}</div>;
	return (
		<svg style={style} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
			<defs>
				<clipPath id={clipId}>
					<path d={clipPath} transform={clipTransform} />
				</clipPath>
			</defs>
			<foreignObject x={0} y={0} width={width} height={height} clipPath={`url(#${clipId})`}>
				{canvas}
			</foreignObject>
		</svg>
	);
}

/** Stands in for an effect that cannot be drawn (see `canvasEffectStatus`): a faint hatch, with the reason. */
function CanvasEffectMissing({ reason, effect, width, height, clipPath, clipTransform }: { reason: string; effect: CanvasShapeEffect; width: number; height: number; clipPath?: string; clipTransform?: string }) {
	const id = useMemo(() => `pixerate-effect-missing-${Math.random().toString(36).slice(2)}`, []);
	const common = { role: 'img', 'aria-label': reason, 'data-canvas-effect-missing': effect.effect } as const;
	if (effect.mode === 'overlay' || !clipPath) return <div {...common} title={reason} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: CANVAS_EFFECT_MISSING_PATTERN }} />;
	return (
		<svg {...common} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
			<title>{reason}</title>
			<defs>
				<pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
					<rect width={2} height={8} fill="rgba(128,128,128,0.28)" />
				</pattern>
			</defs>
			<path d={clipPath} transform={clipTransform} fill={`url(#${id})`} />
		</svg>
	);
}

export interface UseCanvasEffectsOptions<TNode extends CanvasNode = CanvasNode> extends Omit<CanvasEffectsControllerOptions<TNode>, 'effects'> {
	/** The effects provider, registered while mounted (optional). */
	effects?: EffectProvider | null;
	scenes?: CanvasScenesStore;
}

/**
 * A canvas effects controller (apply, change and remove node effects, scene transitions) for the
 * component's lifetime, with `effects` registered while given.
 */
export function useCanvasEffects<TNode extends CanvasNode = CanvasNode>(options: UseCanvasEffectsOptions<TNode>): CanvasEffectsController<TNode> {
	const opts = useRef(options);
	opts.current = options;
	const controller = useMemo(
		() =>
			createCanvasEffectsController<TNode>({
				getNodes: () => opts.current.getNodes(),
				setNodes: (n) => opts.current.setNodes(n),
				history: { execute: (c) => (opts.current.history ? opts.current.history.execute(c) : c.execute()) },
				get scenes() {
					return opts.current.scenes;
				}
			} as CanvasEffectsControllerOptions<TNode>),
		[]
	);
	useEffect(() => {
		if (!options.effects) return;
		return controller.useEffects(options.effects);
	}, [controller, options.effects]);
	return controller;
}

/** Registers the canvas effect tools (`search_effects`, `apply_effect`, `set_scene_transition`, …) while mounted. */
export function useCanvasEffectsTools(registry: ToolRegistry | null | undefined, controller: CanvasEffectsController, options: CanvasEffectsToolProviderOptions = {}): void {
	const { id, namespace, readOnly, subscribe } = options;
	useEffect(() => {
		if (!registry) return;
		return registry.register(createCanvasEffectsToolProvider(controller, { id, namespace, readOnly, subscribe }));
	}, [registry, controller, id, namespace, readOnly, subscribe]);
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

function Controls({ controller, nodeId, effect }: { controller: CanvasEffectsController; nodeId: string; effect: CanvasShapeEffect }) {
	const { description, error } = useEffectDescription(controller.effectsProvider, effect.effect);
	const [message, setMessage] = useState<string | null>(null);
	const run = (work: Promise<unknown>) => void work.then(() => setMessage(null), (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
	if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
	if (!description) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
	return (
		<>
			<EffectParameters
				description={description}
				values={effect.values}
				onChange={(k, v) => run(controller.updateNodeEffect(nodeId, { values: { [k]: v as never } }))}
				onReset={(k) => run(controller.updateNodeEffect(nodeId, { values: { [k]: null } }))}
				onPreset={(v) => run(controller.updateNodeEffect(nodeId, { values: v as never }))}
			/>
			{message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
		</>
	);
}

/** The effect's controls, or why the registered provider cannot draw it (then Fill… / Overlay… replace it). */
function EffectControlsOrReason({ controller, nodeId, effect }: { controller: CanvasEffectsController; nodeId: string; effect: CanvasShapeEffect }) {
	const status = controller.status(effect);
	if (!status.ok) return <p className="text-[11px] text-amber-500" data-canvas-effect-unavailable="">{status.reason}</p>;
	return <Controls controller={controller} nodeId={nodeId} effect={effect} />;
}

export interface CanvasEffectsPanelProps {
	controller: CanvasEffectsController;
	/** The node to edit (e.g. the selected shape). */
	nodeId?: string | null;
	/** The node's shape, to show its effect (re-render the panel when it changes). */
	shape?: ShapeDescription | null;
	/** The scene to set a transition into (e.g. the current one). */
	sceneId?: string | null;
	className?: string;
}

/**
 * Effects for a shape node (fill with a generator, overlay, change controls, play / hold,
 * opacity, remove) and the transition into a scene.
 */
export function CanvasEffectsPanel({ controller, nodeId, shape, sceneId, className = '' }: CanvasEffectsPanelProps) {
	const [, setTick] = useState(0);
	useEffect(() => controller.effects.subscribe(() => setTick((n) => n + 1)), [controller]);
	const provider = controller.effectsProvider;
	const [browse, setBrowse] = useState<null | 'fill' | 'overlay' | 'transition'>(null);
	const [message, setMessage] = useState<string | null>(null);
	const run = (work: () => unknown) => {
		setMessage(null);
		Promise.resolve().then(work).then(() => setTick((n) => n + 1), (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
	};
	const effect = isShapeDescription(shape) ? shape.effect : undefined;
	const transition = sceneId ? controller.sceneTransition(sceneId) : undefined;
	return (
		<section className={`flex flex-col gap-2 text-xs ${className}`} aria-label="Canvas effects" data-canvas-effects="">
			<div className="flex flex-wrap items-center gap-1">
				<span className="flex-1 font-semibold">Effects</span>
				<button type="button" className={btn} disabled={!provider || !nodeId || !shape} aria-pressed={browse === 'fill'} onClick={() => setBrowse(browse === 'fill' ? null : 'fill')}>
					Fill…
				</button>
				<button type="button" className={btn} disabled={!provider || !nodeId || !shape} aria-pressed={browse === 'overlay'} onClick={() => setBrowse(browse === 'overlay' ? null : 'overlay')}>
					Overlay…
				</button>
				<button type="button" className={btn} disabled={!provider || !sceneId} aria-pressed={browse === 'transition'} onClick={() => setBrowse(browse === 'transition' ? null : 'transition')}>
					Scene transition…
				</button>
			</div>
			{!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Effects on the canvas are kept.</p>}
			{browse === 'fill' && nodeId && <EffectsBrowser provider={provider} uses={['generator', 'interactive']} title="Fills" onPick={(e) => (setBrowse(null), run(() => controller.applyNodeEffect(nodeId, e.id, { mode: 'fill' })))} />}
			{browse === 'overlay' && nodeId && <EffectsBrowser provider={provider} uses={['overlay', 'title', 'interactive', 'generator']} title="Overlays" onPick={(e) => (setBrowse(null), run(() => controller.applyNodeEffect(nodeId, e.id, { mode: 'overlay' })))} />}
			{browse === 'transition' && sceneId && <EffectsBrowser provider={provider} uses={['transition']} title="Transitions" onPick={(e) => (setBrowse(null), run(() => controller.setSceneTransition(sceneId, e.id)))} />}
			{effect && nodeId && (
				<div className="space-y-1 rounded border border-border p-1" data-canvas-node-effect={nodeId}>
					<div className="flex items-center gap-1">
						<span className="min-w-0 flex-1 truncate font-medium">
							{effect.name ?? effect.effect} <span className="text-muted-foreground">· {effect.mode}</span>
						</span>
						<label className="flex items-center gap-1">
							<input type="checkbox" checked={effect.playing !== false} aria-label="Play" onChange={(e) => { const playing = e.currentTarget.checked; run(() => controller.updateNodeEffect(nodeId, { playing })); }} /> Play
						</label>
						<button type="button" className={btn} aria-label="Remove effect" onClick={() => run(() => controller.removeNodeEffect(nodeId))}>
							✕
						</button>
					</div>
					{provider && <EffectControlsOrReason controller={controller} nodeId={nodeId} effect={effect} />}
				</div>
			)}
			{sceneId && transition && (
				<div className="flex items-center gap-1" data-canvas-scene-transition={sceneId}>
					<span className="min-w-0 flex-1 truncate">Into scene: {transition.name ?? transition.effect} ({transition.duration ?? 600} ms)</span>
					<button type="button" className={btn} aria-label="Remove transition" onClick={() => run(() => controller.setSceneTransition(sceneId, null))}>
						✕
					</button>
				</div>
			)}
			{message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
		</section>
	);
}
