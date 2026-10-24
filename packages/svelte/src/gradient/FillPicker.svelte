<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		GradientController,
		createGradient,
		gradientToCss,
		parseCssGradient
	} from '@pixerate/editor/gradient';
	import { formatHex, mixColors, parseColor } from '@pixerate/editor/color';
	import ColorPicker from '../color/ColorPicker.svelte';
	import GradientEditor from './GradientEditor.svelte';

	interface Props {
		/** Active CSS colour (hex/rgb/hsl etc.) or CSS gradient string. */
		value: string;
		/** Called when the fill value changes. */
		onchange?: (value: string) => void;
		onChange?: (value: string) => void;
		/** Called when a continuous pointer drag starts. */
		ongesturestart?: () => void;
		onGestureStart?: () => void;
		/** Called when a continuous pointer drag ends. */
		ongestureend?: () => void;
		onGestureEnd?: () => void;
		/** Allowed fill modes. Default: ['solid', 'gradient']. */
		modes?: readonly ('solid' | 'gradient')[];
		/** Whether the alpha channel slider is shown on ColorPicker. Default: false. */
		alpha?: boolean;
		/** Preset swatches for ColorPicker. */
		swatches?: readonly string[];
		/** Additional CSS class names. */
		class?: string;
		className?: string;
		/** Whether the picker is disabled. */
		disabled?: boolean;
	}

	let {
		value,
		onchange,
		onChange,
		ongesturestart,
		onGestureStart,
		ongestureend,
		onGestureEnd,
		modes = ['solid', 'gradient'],
		alpha = false,
		swatches,
		class: klass = '',
		className = '',
		disabled = false
	}: Props = $props();

	function emitChange(v: string) {
		onchange?.(v);
		onChange?.(v);
	}

	function emitGestureStart() {
		ongesturestart?.();
		onGestureStart?.();
	}

	function emitGestureEnd() {
		ongestureend?.();
		onGestureEnd?.();
	}

	function createDefaultGradientFromColor(colorStr: string) {
		const parsed = parseColor(colorStr);
		const baseHex = parsed ? formatHex(parsed) : '#3b82f6';
		const lighterHex = mixColors(baseHex, '#ffffff', 0.35, { space: 'oklab' }) ?? '#ffffff';
		return createGradient([baseHex, lighterHex]);
	}

	const parsedGrad = parseCssGradient(value);
	const initialMode: 'solid' | 'gradient' =
		parsedGrad && modes.includes('gradient')
			? 'gradient'
			: modes.includes('solid')
				? 'solid'
				: 'gradient';

	let mode = $state<'solid' | 'gradient'>(initialMode);
	let isDragging = false;

	const controller = new GradientController({
		value: parsedGrad ?? createDefaultGradientFromColor(value),
		readOnly: disabled,
		onChange: (g) => {
			if (mode === 'gradient') {
				emitChange(gradientToCss(g));
			}
		}
	});

	$effect(() => {
		if (isDragging) return;
		const incomingGrad = parseCssGradient(value);
		if (incomingGrad) {
			if (modes.includes('gradient')) {
				mode = 'gradient';
				controller.setGradient(incomingGrad);
			}
		} else {
			if (modes.includes('solid')) {
				mode = 'solid';
			}
		}
	});

	function switchToSolid() {
		mode = 'solid';
		const stops = controller.getGradient().stops;
		const solidColor = stops[0]?.color ?? '#000000';
		emitChange(solidColor);
	}

	function switchToGradient() {
		mode = 'gradient';
		const newGrad = createDefaultGradientFromColor(value);
		controller.setGradient(newGrad);
		emitChange(gradientToCss(newGrad));
	}

	const buttonClass =
		'inline-flex h-7 items-center justify-center rounded border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
</script>

{#if modes.length === 1 && modes[0] === 'solid'}
	<div class="{klass} {className}" data-testid="fill-picker">
		<ColorPicker
			{value}
			onchange={emitChange}
			ongesturestart={emitGestureStart}
			ongestureend={emitGestureEnd}
			{alpha}
			{swatches}
			{disabled}
		/>
	</div>
{:else if modes.length === 1 && modes[0] === 'gradient'}
	<div class="{klass} {className}" data-testid="fill-picker">
		<GradientEditor {controller} />
	</div>
{:else}
	<div class="flex flex-col gap-2.5 {klass} {className}" data-testid="fill-picker">
		<!-- Mode toggle tabs -->
		<div class="flex rounded-md border border-border p-0.5">
			<button
				type="button"
				class="flex-1 {buttonClass}"
				aria-pressed={mode === 'solid'}
				{disabled}
				onclick={switchToSolid}
			>
				Solid
			</button>
			<button
				type="button"
				class="flex-1 {buttonClass}"
				aria-pressed={mode === 'gradient'}
				{disabled}
				onclick={switchToGradient}
			>
				Gradient
			</button>
		</div>

		{#if mode === 'solid'}
			<ColorPicker
				{value}
				onchange={emitChange}
				ongesturestart={() => {
					isDragging = true;
					emitGestureStart();
				}}
				ongestureend={() => {
					isDragging = false;
					emitGestureEnd();
				}}
				{alpha}
				{swatches}
				{disabled}
			/>
		{:else}
			<GradientEditor {controller} />
		{/if}
	</div>
{/if}
