import React, { useEffect, useRef } from 'react';
import {
	ANIMATION_EASING_LABELS,
	ANIMATION_EASING_PRESETS,
	formatAnimationTime,
	getTimelineTicks,
	timeToX,
	xToTime,
	type AnimationLoopMode,
	type CanvasNode,
	type KeyframeRef
} from '@pixerate/editor/canvas';
import type { CanvasAnimation } from './useCanvasAnimation.js';

export interface AnimationTimelineProps {
	/** The `useCanvasAnimation` result. */
	animation: CanvasAnimation<any>;
	/** Nodes whose tracks are listed (default: the selected nodes). */
	nodeIds?: readonly string[];
	/** Width of the keyframe lanes in px (default 360). */
	width?: number;
	/** Snap distance in screen px while dragging keyframes (default 8; hold Alt to turn snapping off). */
	snapThreshold?: number;
	labelOf?: (node: CanvasNode) => string;
	className?: string;
}

const LOOP_LABELS: Record<AnimationLoopMode, string> = { none: 'Once', loop: 'Loop', 'ping-pong': 'Ping-pong' };
const easingValue = (easing: unknown) => (typeof easing === 'string' ? easing : easing ? 'custom' : 'linear');

/**
 * Compact timeline: play / pause, record toggle, playhead ruler (drag to scrub), one lane per
 * animated property of the selected nodes with draggable keyframe diamonds (snapping to other
 * keys, the playhead and frames; Shift-click adds to the selection, Escape cancels a drag,
 * Delete removes), an easing picker for the selected keyframes and the loop mode.
 */
export function AnimationTimeline({ animation, nodeIds, width = 360, snapThreshold = 8, labelOf, className = '' }: AnimationTimelineProps) {
	const { state } = animation;
	const duration = state.duration;
	const rows = animation.timelineRows(nodeIds ?? undefined, labelOf ? { labelOf } : {});
	const ticks = getTimelineTicks(duration, width);
	const selectedEasing = (() => {
		const first = state.selection[0];
		if (!first) return '';
		for (const row of rows) for (const k of row.keyframes) if (k.selected && k.ref.property === first.property && k.ref.nodeId === first.nodeId) return easingValue(k.easing);
		return '';
	})();
	const dragRef = useRef<{ startX: number } | null>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && dragRef.current) {
				dragRef.current = null;
				animation.cancelKeyframeDrag();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [animation]);

	const onRulerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const lane = event.currentTarget;
		const left = lane.getBoundingClientRect().left;
		animation.scrub(xToTime(event.clientX - left, duration, width));
		const move = (e: PointerEvent) => animation.scrub(xToTime(e.clientX - left, duration, width));
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			animation.endScrub();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	const onKeyDown = (ref: KeyframeRef) => (event: React.PointerEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		event.preventDefault();
		if (event.shiftKey || event.metaKey || event.ctrlKey) {
			animation.selectKeyframes([ref], 'toggle');
			return;
		}
		animation.beginKeyframeDrag([ref]);
		dragRef.current = { startX: event.clientX };
		const msPerPx = width > 0 ? duration / width : 0;
		const move = (e: PointerEvent) => {
			if (!dragRef.current) return;
			animation.updateKeyframeDrag((e.clientX - dragRef.current.startX) * msPerPx, { snap: !e.altKey, thresholdMs: snapThreshold * msPerPx });
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (!dragRef.current) return;
			dragRef.current = null;
			animation.endKeyframeDrag();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	const onTimelineKey = (event: React.KeyboardEvent) => {
		if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection.length > 0) {
			event.preventDefault();
			animation.deleteKeyframes();
		}
	};

	const btn = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50';
	const playheadX = timeToX(state.time, duration, width);
	const labelWidth = 120;

	return (
		<div data-animation-timeline="" className={`flex flex-col gap-1 text-xs text-foreground ${className}`} tabIndex={0} onKeyDown={onTimelineKey}>
			<div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Animation">
				<button type="button" className={btn} data-action="toggle-play" aria-label={state.playing ? 'Pause' : 'Play'} onClick={() => animation.toggle()}>
					{state.playing ? '❚❚' : '▶'}
				</button>
				<button
					type="button"
					className={`${btn} ${state.recording ? 'text-red-500' : ''}`}
					data-action="record"
					aria-pressed={state.recording}
					aria-label="Record keyframes"
					onClick={() => animation.toggleRecording()}
				>
					● Rec
				</button>
				<button type="button" className={btn} data-action="add-keyframe" onClick={() => animation.addKeyframe()}>
					◆ Key
				</button>
				<span data-time="" className="tabular-nums text-muted-foreground">
					{formatAnimationTime(state.time)} / {formatAnimationTime(duration)}
				</span>
				<select
					aria-label="Easing"
					data-easing-picker=""
					className="rounded border border-border bg-background px-1 py-0.5"
					value={selectedEasing}
					disabled={state.selection.length === 0}
					onChange={(e) => e.target.value && e.target.value !== 'custom' && animation.setEasing(e.target.value)}
				>
					<option value="">Easing…</option>
					{ANIMATION_EASING_PRESETS.map((preset) => (
						<option key={preset} value={preset}>
							{ANIMATION_EASING_LABELS[preset]}
						</option>
					))}
					{selectedEasing === 'custom' ? <option value="custom">Custom</option> : null}
				</select>
				<select
					aria-label="Loop"
					data-loop-picker=""
					className="rounded border border-border bg-background px-1 py-0.5"
					value={state.loop}
					onChange={(e) => animation.setLoop(e.target.value as AnimationLoopMode)}
				>
					{(Object.keys(LOOP_LABELS) as AnimationLoopMode[]).map((mode) => (
						<option key={mode} value={mode}>
							{LOOP_LABELS[mode]}
						</option>
					))}
				</select>
			</div>
			<div className="flex">
				<div style={{ width: labelWidth }} className="shrink-0" />
				<div
					data-timeline-ruler=""
					className="relative h-5 cursor-ew-resize border-b border-border"
					style={{ width }}
					onPointerDown={onRulerDown}
				>
					{ticks.map((tick) => (
						<span key={tick.time} className="absolute top-0 -translate-x-1/2 text-[10px] text-muted-foreground" style={{ left: tick.x }}>
							{tick.label}
						</span>
					))}
					<div data-playhead="" className="absolute top-0 h-5 w-px bg-red-500" style={{ left: playheadX }} />
				</div>
			</div>
			{rows.length === 0 ? (
				<p className="text-muted-foreground" data-timeline-empty="">
					Select an animated node, or press ◆ Key to add a keyframe.
				</p>
			) : (
				rows.map((row) => (
					<div key={row.id} className="flex items-center" data-track={row.id}>
						<label className="flex shrink-0 items-center gap-1 truncate pr-2" style={{ width: labelWidth }} title={`${row.nodeLabel} · ${row.label}`}>
							<input
								type="checkbox"
								aria-label={`Enable ${row.label}`}
								checked={row.enabled}
								onChange={(e) => animation.setTrackEnabled(row.nodeId, row.property, e.target.checked)}
							/>
							<span className="truncate">{rows.filter((r) => r.nodeId === row.nodeId).length < rows.length ? `${row.nodeLabel} · ` : ''}{row.label}</span>
						</label>
						<div data-lane="" className={`relative h-5 rounded bg-muted/40 ${row.enabled ? '' : 'opacity-50'}`} style={{ width }}>
							<div className="pointer-events-none absolute top-0 h-5 w-px bg-red-500/60" style={{ left: playheadX }} />
							{state.drag?.target != null ? (
								<div data-snap-target="" className="pointer-events-none absolute top-0 h-5 w-px bg-sky-400" style={{ left: timeToX(state.drag.target, duration, width) }} />
							) : null}
							{row.keyframes.map((k) => (
								<button
									key={k.ref.time}
									type="button"
									data-keyframe={k.ref.time}
									aria-pressed={k.selected}
									aria-label={`${row.label} keyframe at ${formatAnimationTime(k.ref.time)}`}
									title={`${formatAnimationTime(k.time)} · ${String(k.value)}`}
									className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
										k.selected ? 'border-sky-300 bg-sky-500' : 'border-foreground/60 bg-background'
									} ${k.easing === 'hold' ? 'rounded-none' : 'rounded-[1px]'}`}
									style={{ left: timeToX(k.time, duration, width) }}
									onPointerDown={onKeyDown(k.ref)}
								/>
							))}
						</div>
					</div>
				))
			)}
		</div>
	);
}
