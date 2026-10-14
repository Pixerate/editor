<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		ANIMATION_EASING_LABELS,
		ANIMATION_EASING_PRESETS,
		formatAnimationTime,
		getTimelineTicks,
		timeToX,
		xToTime,
		type AnimationLoopMode,
		type KeyframeRef
	} from '@pixerate/editor/canvas';
	import type { SvelteCanvasAnimation } from './createCanvasAnimation.svelte.js';
	import type { CanvasNode } from './types.js';

	interface Props {
		/** The `createCanvasAnimation` rune. */
		animation: SvelteCanvasAnimation<any>;
		/** Nodes whose tracks are listed (default: the selected nodes). */
		nodeIds?: readonly string[];
		/** Width of the keyframe lanes in px (default 360). */
		width?: number;
		/** Snap distance in screen px while dragging keyframes (default 8; hold Alt to turn snapping off). */
		snapThreshold?: number;
		labelOf?: (node: CanvasNode) => string;
		/** Bump to re-read the rows after changing the nodes outside the rune. */
		revision?: unknown;
		class?: string;
	}

	let { animation, nodeIds, width = 360, snapThreshold = 8, labelOf, revision, class: className = '' }: Props = $props();

	const LOOP_LABELS: Record<AnimationLoopMode, string> = { none: 'Once', loop: 'Loop', 'ping-pong': 'Ping-pong' };
	const labelWidth = 120;

	const state = $derived(animation.state);
	const duration = $derived(state.duration);
	const rows = $derived.by(() => {
		void state;
		void revision;
		void animation.revision;
		return animation.timelineRows(nodeIds ?? undefined, labelOf ? { labelOf: labelOf as any } : {});
	});
	const ticks = $derived(getTimelineTicks(duration, width));
	const playheadX = $derived(timeToX(state.time, duration, width));
	const easingValue = (easing: unknown) => (typeof easing === 'string' ? easing : easing ? 'custom' : 'linear');
	const selectedEasing = $derived.by(() => {
		const first = state.selection[0];
		if (!first) return '';
		for (const row of rows) for (const k of row.keyframes) if (k.selected && k.ref.property === first.property && k.ref.nodeId === first.nodeId) return easingValue(k.easing);
		return '';
	});
	const multiNode = $derived(new Set(rows.map((r) => r.nodeId)).size > 1);

	let dragStartX: number | null = null;
	const cleanups: (() => void)[] = [];
	const listen = (move: (e: PointerEvent) => void, up: () => void) => {
		const end = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			up();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		cleanups.push(() => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
		});
	};

	function onRulerDown(event: PointerEvent) {
		const left = (event.currentTarget as Element).getBoundingClientRect().left;
		animation.scrub(xToTime(event.clientX - left, duration, width));
		listen(
			(e) => animation.scrub(xToTime(e.clientX - left, duration, width)),
			() => animation.endScrub()
		);
	}

	function onKeyframeDown(event: PointerEvent, ref: KeyframeRef) {
		event.stopPropagation();
		event.preventDefault();
		if (event.shiftKey || event.metaKey || event.ctrlKey) {
			animation.selectKeyframes([ref], 'toggle');
			return;
		}
		animation.beginKeyframeDrag([ref]);
		dragStartX = event.clientX;
		const msPerPx = width > 0 ? duration / width : 0;
		listen(
			(e) => {
				if (dragStartX === null) return;
				animation.updateKeyframeDrag((e.clientX - dragStartX) * msPerPx, { snap: !e.altKey, thresholdMs: snapThreshold * msPerPx });
			},
			() => {
				if (dragStartX === null) return;
				dragStartX = null;
				animation.endKeyframeDrag();
			}
		);
	}

	function onWindowKey(event: KeyboardEvent) {
		if (event.key === 'Escape' && dragStartX !== null) {
			dragStartX = null;
			animation.cancelKeyframeDrag();
		}
	}

	function onTimelineKey(event: KeyboardEvent) {
		if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection.length > 0) {
			event.preventDefault();
			animation.deleteKeyframes();
		}
	}

	onDestroy(() => cleanups.forEach((fn) => fn()));

	const btn = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50';
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
<div data-animation-timeline="" class="flex flex-col gap-1 text-xs text-foreground {className}" tabindex="0" onkeydown={onTimelineKey}>
	<div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Animation">
		<button type="button" class={btn} data-action="toggle-play" aria-label={state.playing ? 'Pause' : 'Play'} onclick={() => animation.toggle()}>
			{state.playing ? '❚❚' : '▶'}
		</button>
		<button
			type="button"
			class="{btn} {state.recording ? 'text-red-500' : ''}"
			data-action="record"
			aria-pressed={state.recording}
			aria-label="Record keyframes"
			onclick={() => animation.toggleRecording()}
		>
			● Rec
		</button>
		<button type="button" class={btn} data-action="add-keyframe" onclick={() => animation.addKeyframe()}>◆ Key</button>
		<span data-time="" class="tabular-nums text-muted-foreground">{formatAnimationTime(state.time)} / {formatAnimationTime(duration)}</span>
		<select
			aria-label="Easing"
			data-easing-picker=""
			class="rounded border border-border bg-background px-1 py-0.5"
			value={selectedEasing}
			disabled={state.selection.length === 0}
			onchange={(e) => {
				const value = (e.currentTarget as HTMLSelectElement).value;
				if (value && value !== 'custom') animation.setEasing(value);
			}}
		>
			<option value="">Easing…</option>
			{#each ANIMATION_EASING_PRESETS as preset (preset)}
				<option value={preset}>{ANIMATION_EASING_LABELS[preset]}</option>
			{/each}
			{#if selectedEasing === 'custom'}<option value="custom">Custom</option>{/if}
		</select>
		<select
			aria-label="Loop"
			data-loop-picker=""
			class="rounded border border-border bg-background px-1 py-0.5"
			value={state.loop}
			onchange={(e) => animation.setLoop((e.currentTarget as HTMLSelectElement).value as AnimationLoopMode)}
		>
			{#each Object.keys(LOOP_LABELS) as mode (mode)}
				<option value={mode}>{LOOP_LABELS[mode as AnimationLoopMode]}</option>
			{/each}
		</select>
	</div>
	<div class="flex">
		<div style="width: {labelWidth}px" class="shrink-0"></div>
		<div data-timeline-ruler="" class="relative h-5 cursor-ew-resize border-b border-border" style="width: {width}px" onpointerdown={onRulerDown}>
			{#each ticks as tick (tick.time)}
				<span class="absolute top-0 -translate-x-1/2 text-[10px] text-muted-foreground" style="left: {tick.x}px">{tick.label}</span>
			{/each}
			<div data-playhead="" class="absolute top-0 h-5 w-px bg-red-500" style="left: {playheadX}px"></div>
		</div>
	</div>
	{#if rows.length === 0}
		<p class="text-muted-foreground" data-timeline-empty="">Select an animated node, or press ◆ Key to add a keyframe.</p>
	{:else}
		{#each rows as row (row.id)}
			<div class="flex items-center" data-track={row.id}>
				<label class="flex shrink-0 items-center gap-1 truncate pr-2" style="width: {labelWidth}px" title="{row.nodeLabel} · {row.label}">
					<input
						type="checkbox"
						aria-label="Enable {row.label}"
						checked={row.enabled}
						onchange={(e) => animation.setTrackEnabled(row.nodeId, row.property, (e.currentTarget as HTMLInputElement).checked)}
					/>
					<span class="truncate">{multiNode ? `${row.nodeLabel} · ` : ''}{row.label}</span>
				</label>
				<div data-lane="" class="relative h-5 rounded bg-muted/40 {row.enabled ? '' : 'opacity-50'}" style="width: {width}px">
					<div class="pointer-events-none absolute top-0 h-5 w-px bg-red-500/60" style="left: {playheadX}px"></div>
					{#if state.drag && state.drag.target !== null}
						<div data-snap-target="" class="pointer-events-none absolute top-0 h-5 w-px bg-sky-400" style="left: {timeToX(state.drag.target, duration, width)}px"></div>
					{/if}
					{#each row.keyframes as k (k.ref.time)}
						<button
							type="button"
							data-keyframe={k.ref.time}
							aria-pressed={k.selected}
							aria-label="{row.label} keyframe at {formatAnimationTime(k.ref.time)}"
							title="{formatAnimationTime(k.time)} · {String(k.value)}"
							class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border {k.selected
								? 'border-sky-300 bg-sky-500'
								: 'border-foreground/60 bg-background'} {k.easing === 'hold' ? 'rounded-none' : 'rounded-[1px]'}"
							style="left: {timeToX(k.time, duration, width)}px"
							onpointerdown={(e) => onKeyframeDown(e, k.ref)}
						></button>
					{/each}
				</div>
			</div>
		{/each}
	{/if}
</div>
