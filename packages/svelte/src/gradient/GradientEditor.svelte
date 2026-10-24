<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		GRADIENT_PRESETS,
		type GradientController,
		type GradientInterpolation,
		type GradientState,
		type GradientType,
		angleFromPointer,
		gradientKeyStep,
		gradientToCss,
		gradientToCssFallback,
		gradientTrackBackground,
		isDualGradient
	} from '@pixerate/editor/gradient';
	import { formatDualColor, type ColorScheme } from '@pixerate/editor/color';
	import ColorPicker from '../color/ColorPicker.svelte';
	import DualColorPicker from '../color/DualColorPicker.svelte';

	interface Props {
		/** Required controller that manages gradient data and history. */
		controller: GradientController;
		/** Allowed gradient types to switch between (default: ['linear', 'radial', 'conic']). */
		types?: readonly GradientType[];
		/** Whether to display preset gradient buttons (default: true). */
		showPresets?: boolean;
		/** Whether to display CSS code with copy button (default: false). */
		showCss?: boolean;
		/** Whether stops support dual light/dark colour definitions (default: false or auto-detected). */
		dual?: boolean;
		/** Called when a continuous edit (stop drag, angle drag, colour drag) starts. */
		ongesturestart?: () => void;
		/** Called when that edit ends. */
		ongestureend?: () => void;
		/** Additional CSS class name. */
		class?: string;
		className?: string;
	}

	let {
		controller,
		types = ['linear', 'radial', 'conic'],
		showPresets = true,
		showCss = false,
		dual: controlledDual = undefined,
		class: klass = '',
		ongesturestart,
		ongestureend,
		className = ''
	}: Props = $props();

	// A gesture is one undo step in the controller and is reported to the host.
	function beginGesture(label: string) {
		controller.beginGesture(label);
		ongesturestart?.();
	}

	function endGesture() {
		controller.endGesture();
		ongestureend?.();
	}

	let gradientState = $state.raw<GradientState | null>(null);
	$effect(() => {
		gradientState = controller.state;
		return controller.subscribe((next) => {
			gradientState = next;
		});
	});

	let safeState = $derived(gradientState ?? controller.state);

	let activeScheme = $state<ColorScheme>('light');
	let copied = $state(false);

	let trackEl: HTMLDivElement | null = $state(null);
	let dialEl: HTMLDivElement | null = $state(null);

	let gradient = $derived(safeState.gradient);
	let selectedStopId = $derived(safeState.selectedStopId);
	let isDual = $derived(controlledDual ?? isDualGradient(gradient));

	let selectedStop = $derived(
		gradient.stops.find((s) => s.id === selectedStopId) ?? gradient.stops[0]
	);

	let previewCss = $derived(
		isDual ? gradientToCssFallback(gradient, 16, activeScheme) : gradientToCss(gradient)
	);

	let trackCss = $derived(gradientTrackBackground(gradient));

	const buttonClass =
		'inline-flex h-7 items-center justify-center rounded border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
	const selectClass =
		'h-7 rounded border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';
	const inputClass =
		'h-7 w-16 rounded border border-border bg-background px-1.5 text-center text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

	function handleTrackClick(e: MouseEvent) {
		if (controller.isReadOnly || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		if (rect.width <= 0) return;
		const offset = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		controller.addStop(offset);
	}

	function handleStopPointerDown(e: PointerEvent, stopId: string) {
		if (controller.isReadOnly) return;
		e.stopPropagation();
		controller.selectStop(stopId);
		beginGesture('Move Stop');

		const startY = e.clientY;
		const rect = trackEl?.getBoundingClientRect();

		const onPointerMove = (moveEvent: PointerEvent) => {
			if (!rect || rect.width <= 0) return;
			if (moveEvent.clientY - startY > 32 && controller.getGradient().stops.length > 2) {
				cleanup();
				controller.removeStop(stopId);
				endGesture();
				return;
			}
			const nextOffset = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
			controller.updateStop(stopId, { offset: Math.round(nextOffset * 1000) / 1000 });
		};

		const cleanup = () => {
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
		};

		const onPointerUp = () => {
			cleanup();
			endGesture();
		};

		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
	}

	function handleStopKeyDown(e: KeyboardEvent, stopId: string) {
		if (controller.isReadOnly) return;
		const res = gradientKeyStep(gradient, stopId, e.key, e.shiftKey);
		if (!res) return;
		e.preventDefault();
		if (res.remove) {
			if (gradient.stops.length > 2) {
				controller.removeStop(stopId);
			}
		} else if (res.offset !== undefined) {
			controller.updateStop(stopId, { offset: res.offset });
		}
	}

	function handleAngleDialPointerDown(e: PointerEvent) {
		if (controller.isReadOnly || !dialEl) return;
		beginGesture('Change Angle');
		const rect = dialEl.getBoundingClientRect();
		const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

		const update = (pe: PointerEvent) => {
			const deg = angleFromPointer(center, { x: pe.clientX, y: pe.clientY }, pe.shiftKey ? 15 : 1);
			controller.setAngle(deg);
		};
		update(e);

		const cleanup = () => {
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
		};

		const onPointerMove = (pe: PointerEvent) => update(pe);
		const onPointerUp = () => {
			cleanup();
			endGesture();
		};

		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
	}

	function copyCss() {
		const text = gradientToCss(gradient);
		navigator.clipboard?.writeText(text).then(() => {
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 1500);
		});
	}
</script>

<div
	class="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm {klass} {className}"
	data-testid="gradient-editor"
>
	<!-- Preview box -->
	<div class="relative h-20 w-full overflow-hidden rounded-md border border-border">
		<div
			class="absolute inset-0"
			style="background-image: linear-gradient(45deg, #e0e0e0 25%, transparent 25%), linear-gradient(-45deg, #e0e0e0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e0e0e0 75%), linear-gradient(-45deg, transparent 75%, #e0e0e0 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0px;"
		></div>
		<div
			class="absolute inset-0 transition-all"
			style="background: {previewCss}"
			data-testid="gradient-preview"
		></div>
	</div>

	<!-- Stop Track -->
	<div class="flex flex-col gap-1">
		<div
			bind:this={trackEl}
			role="button"
			tabindex={0}
			aria-label="Add gradient stop"
			class="relative h-6 w-full cursor-pointer rounded border border-border"
			style="background: {trackCss}"
			onclick={handleTrackClick}
			onkeydown={(e) => e.key === 'Enter' && handleTrackClick(e as any)}
			data-testid="gradient-track"
		>
			{#each gradient.stops as stop, idx (stop.id)}
				{@const isSelected = stop.id === selectedStopId}
				{@const pct = Math.round(stop.offset * 100)}
				<button
					type="button"
					role="slider"
					aria-label="Stop {idx + 1}, {stop.color} at {pct}%"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct}
					aria-current={isSelected ? 'true' : undefined}
					disabled={controller.isReadOnly}
					class="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded border border-white shadow-sm transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {isSelected
						? 'scale-110 ring-2 ring-primary z-10'
						: 'hover:scale-105'}"
					style="left: {stop.offset * 100}%; background-color: {stop.color.startsWith(
						'light-dark('
					)
						? '#888'
						: stop.color}"
					onclick={(e) => {
						e.stopPropagation();
						controller.selectStop(stop.id);
					}}
					onpointerdown={(e) => handleStopPointerDown(e, stop.id)}
					onkeydown={(e) => handleStopKeyDown(e, stop.id)}
					data-testid="gradient-stop-{stop.id}"
				></button>
			{/each}
		</div>
		<div class="flex justify-between px-0.5 text-[10px] text-muted-foreground">
			<span>0%</span>
			<span>50%</span>
			<span>100%</span>
		</div>
	</div>

	<!-- Geometry and Types toolbar -->
	<div class="flex flex-wrap items-center gap-2">
		{#if types.length > 1}
			<div class="flex rounded-md border border-border p-0.5">
				{#each types as t}
					<button
						type="button"
						class={buttonClass}
						aria-pressed={gradient.type === t}
						disabled={controller.isReadOnly}
						onclick={() => controller.setType(t)}
					>
						{t.charAt(0).toUpperCase() + t.slice(1)}
					</button>
				{/each}
			</div>
		{/if}

		{#if gradient.type === 'linear' || gradient.type === 'conic'}
			<div class="flex items-center gap-1.5">
				<div
					bind:this={dialEl}
					role="slider"
					tabindex={0}
					aria-label="Gradient angle"
					aria-valuemin={0}
					aria-valuemax={360}
					aria-valuenow={gradient.angle ?? 180}
					class="relative h-7 w-7 cursor-crosshair rounded-full border border-border bg-muted/40 shadow-inner flex items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
					onpointerdown={handleAngleDialPointerDown}
				>
					<div
						class="h-2.5 w-0.5 rounded-full bg-foreground"
						style="transform: rotate({gradient.angle ??
							180}deg) translateY(-50%); transform-origin: 50% 100%;"
					></div>
				</div>
				<input
					type="number"
					aria-label="Angle in degrees"
					class={inputClass}
					min={0}
					max={360}
					value={Math.round(gradient.angle ?? 180)}
					disabled={controller.isReadOnly}
					oninput={(e) => controller.setAngle(Number(e.currentTarget.value) % 360)}
				/>
				<span class="text-xs text-muted-foreground">°</span>
			</div>
		{/if}

		{#if gradient.type === 'radial'}
			<div class="flex items-center gap-1">
				<button
					type="button"
					class={buttonClass}
					aria-pressed={(gradient.shape ?? 'ellipse') === 'circle'}
					disabled={controller.isReadOnly}
					onclick={() =>
						controller.setShape(
							(gradient.shape ?? 'ellipse') === 'circle' ? 'ellipse' : 'circle'
						)}
				>
					{(gradient.shape ?? 'ellipse') === 'circle' ? 'Circle' : 'Ellipse'}
				</button>
			</div>
		{/if}

		<select
			aria-label="Interpolation space"
			class={selectClass}
			value={gradient.interpolation ?? 'oklab'}
			disabled={controller.isReadOnly}
			onchange={(e) =>
				controller.setInterpolation(e.currentTarget.value as GradientInterpolation)}
		>
			<option value="oklab">oklab</option>
			<option value="oklch">oklch</option>
			<option value="srgb">srgb</option>
			<option value="srgb-linear">srgb-linear</option>
		</select>

		<div class="flex items-center gap-1 ml-auto">
			<button
				type="button"
				class={buttonClass}
				title="Reverse stops"
				aria-label="Reverse stops"
				disabled={controller.isReadOnly}
				onclick={() => controller.reverse()}
			>
				⇄
			</button>
			<button
				type="button"
				class={buttonClass}
				title="Distribute stops evenly"
				aria-label="Distribute stops evenly"
				disabled={controller.isReadOnly}
				onclick={() => controller.distribute()}
			>
				⫶⫶
			</button>
			{#if gradient.stops.length > 2 && selectedStop}
				<button
					type="button"
					class={buttonClass}
					title="Delete selected stop"
					aria-label="Delete selected stop"
					disabled={controller.isReadOnly}
					onclick={() => controller.removeStop(selectedStop.id)}
				>
					✕
				</button>
			{/if}
		</div>
	</div>

	<!-- Selected stop colour editor -->
	{#if selectedStop}
		<div class="rounded-md border border-border p-2">
			<div class="mb-2 flex items-center justify-between text-xs text-muted-foreground">
				<span>Selected Stop ({Math.round(selectedStop.offset * 100)}%)</span>
				<div class="flex items-center gap-1">
					<span>Offset:</span>
					<input
						type="number"
						aria-label="Stop offset percentage"
						class={inputClass}
						min={0}
						max={100}
						value={Math.round(selectedStop.offset * 100)}
						disabled={controller.isReadOnly}
						oninput={(e) =>
							controller.updateStop(selectedStop.id, {
								offset: Math.max(0, Math.min(100, Number(e.currentTarget.value))) / 100
							})}
					/>
					<span>%</span>
				</div>
			</div>

			{#if isDual}
				<DualColorPicker
					value={selectedStop.color}
					scheme={activeScheme}
					onschemechange={(s) => (activeScheme = s)}
					onchange={(dualColor) => {
						controller.updateStop(selectedStop.id, {
							color: formatDualColor(dualColor)
						});
					}}
					ongesturestart={() => beginGesture('Change Stop Color')}
					ongestureend={() => endGesture()}
					disabled={controller.isReadOnly}
				/>
			{:else}
				<ColorPicker
					value={selectedStop.color}
					alpha={true}
					onchange={(color) => {
						controller.updateStop(selectedStop.id, { color });
					}}
					ongesturestart={() => beginGesture('Change Stop Color')}
					ongestureend={() => endGesture()}
					disabled={controller.isReadOnly}
				/>
			{/if}
		</div>
	{/if}

	<!-- Presets -->
	{#if showPresets}
		<div class="flex flex-col gap-1">
			<span class="text-[11px] font-medium text-muted-foreground">Presets</span>
			<div class="flex flex-wrap gap-1.5" data-testid="gradient-presets">
				{#each Object.entries(GRADIENT_PRESETS) as [name, preset] (name)}
					<button
						type="button"
						class="h-6 w-10 rounded border border-border shadow-sm transition hover:scale-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
						style="background: {gradientToCss(preset)}"
						title={name}
						aria-label="Preset {name}"
						disabled={controller.isReadOnly}
						onclick={() => controller.setGradient(preset, `Apply Preset ${name}`)}
					></button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- CSS Code Output -->
	{#if showCss}
		<div class="flex flex-col gap-1 border-t border-border pt-2">
			<div class="flex items-center justify-between">
				<span class="text-[11px] font-medium text-muted-foreground">CSS Code</span>
				<button type="button" class={buttonClass} onclick={copyCss}>
					{copied ? 'Copied!' : 'Copy'}
				</button>
			</div>
			<pre
				class="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground select-all">{gradientToCss(
					gradient
				)}</pre>
		</div>
	{/if}
</div>
