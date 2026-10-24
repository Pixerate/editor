<script lang="ts" module>
	export type FillMode = 'solid' | 'gradient';
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import {
		GradientController,
		createGradient,
		gradientToCss,
		parseCssGradient
	} from '@pixerate/editor/gradient';
	import { formatHex, mixColors, parseColor, resolveColor } from '@pixerate/editor/color';
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
		modes?: readonly FillMode[];
		/** Whether the alpha channel slider is shown on ColorPicker. Default: false. */
		alpha?: boolean;
		/** Preset swatches for ColorPicker. */
		swatches?: readonly string[];
		/** Whether the gradient editor shows preset buttons. Default: true. */
		showPresets?: boolean;
		/** Whether the gradient editor shows the CSS output with a copy button. Default: false. */
		showCss?: boolean;
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
		showPresets = true,
		showCss = false,
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

	// The controller and mode start from the first value; the effect below follows later ones.
	const initialValue = untrack(() => value);
	const initialGradient = parseCssGradient(initialValue);
	const allows = (m: FillMode) => untrack(() => modes).includes(m);

	let mode = $state<FillMode>(
		initialGradient && allows('gradient') ? 'gradient' : allows('solid') ? 'solid' : 'gradient'
	);
	let isDragging = false;
	// The last CSS this picker emitted, so the echo of our own change isn't loaded back in.
	let emitted: string | null = null;
	let loading = false;

	const controller = new GradientController({
		value: initialGradient ?? createDefaultGradientFromColor(initialValue),
		readOnly: () => disabled,
		onChange: (g) => {
			if (loading || mode !== 'gradient') return;
			emit(gradientToCss(g));
		}
	});

	function emit(v: string) {
		emitted = v;
		emitChange(v);
	}

	function loadQuietly(next: unknown) {
		loading = true;
		try {
			controller.load(next);
		} finally {
			loading = false;
		}
	}

	// Follow the incoming value, without an undo step, unless it is our own change coming back.
	$effect(() => {
		const incoming = parseCssGradient(value);
		const allowsGradient = modes.includes('gradient');
		const allowsSolid = modes.includes('solid');
		untrack(() => {
			if (isDragging) return;
			if (incoming && allowsGradient) {
				mode = 'gradient';
				if (value !== emitted) loadQuietly(incoming);
			} else if (!incoming && allowsSolid) {
				mode = 'solid';
			}
		});
	});

	function switchToSolid() {
		if (mode === 'solid') return;
		mode = 'solid';
		const first = controller.getGradient().stops[0]?.color ?? '#000000';
		// A dual stop has no single solid equivalent; keep its light half.
		emit(resolveColor(first, 'light') ?? '#000000');
	}

	function switchToGradient() {
		if (mode === 'gradient') return;
		mode = 'gradient';
		loadQuietly(createDefaultGradientFromColor(value));
		emit(gradientToCss(controller.getGradient()));
	}

	function gradientGestureStart() {
		isDragging = true;
		emitGestureStart();
	}

	function gradientGestureEnd() {
		isDragging = false;
		emitGestureEnd();
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
		<GradientEditor
			{controller}
			{showPresets}
			{showCss}
			ongesturestart={gradientGestureStart}
			ongestureend={gradientGestureEnd}
		/>
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
			<GradientEditor
			{controller}
			{showPresets}
			{showCss}
			ongesturestart={gradientGestureStart}
			ongestureend={gradientGestureEnd}
		/>
		{/if}
	</div>
{/if}
