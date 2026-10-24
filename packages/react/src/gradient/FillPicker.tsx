import React, { useEffect, useRef, useState } from 'react';
import {
	GradientController,
	createGradient,
	gradientToCss,
	parseCssGradient
} from '@pixerate/editor/gradient';
import { formatHex, mixColors, parseColor, resolveColor } from '@pixerate/editor/color';
import { ColorPicker } from '../color/ColorPicker';
import { GradientEditor } from './GradientEditor';

export type FillMode = 'solid' | 'gradient';

const DEFAULT_MODES: readonly FillMode[] = ['solid', 'gradient'];

export interface FillPickerProps {
	/** Active CSS colour (hex/rgb/hsl etc.) or CSS gradient string. */
	value: string;
	/** Called when the fill value changes. */
	onChange: (value: string) => void;
	/** Called when a continuous pointer drag starts. */
	onGestureStart?: () => void;
	/** Called when a continuous pointer drag ends. */
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
	className?: string;
	/** Whether the picker is disabled. */
	disabled?: boolean;
}

const buttonClass =
	'inline-flex h-7 items-center justify-center rounded border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';

/**
 * Creates a default gradient from a base solid colour by shifting lightness up in OKLCH.
 */
function createDefaultGradientFromColor(colorStr: string) {
	const parsed = parseColor(colorStr);
	const baseHex = parsed ? formatHex(parsed) : '#3b82f6';
	// Lighter colour: blend towards white in OKLab/OKLCH
	const lighterHex = mixColors(baseHex, '#ffffff', 0.35, { space: 'oklab' }) ?? '#ffffff';
	return createGradient([baseHex, lighterHex]);
}

export function FillPicker({
	value,
	onChange,
	onGestureStart,
	onGestureEnd,
	modes = DEFAULT_MODES,
	alpha = false,
	swatches,
	showPresets = true,
	showCss = false,
	className,
	disabled = false
}: FillPickerProps) {
	const allowsSolid = modes.includes('solid');
	const allowsGradient = modes.includes('gradient');
	const modeFor = (v: string): FillMode =>
		parseCssGradient(v) && allowsGradient ? 'gradient' : allowsSolid ? 'solid' : 'gradient';

	const [mode, setModeState] = useState<FillMode>(() => modeFor(value));
	// The controller is created once; its callbacks read the latest props through refs.
	const latest = useRef({ onChange, mode, disabled });
	latest.current.onChange = onChange;
	latest.current.disabled = disabled;
	const setMode = (next: FillMode) => {
		latest.current.mode = next;
		setModeState(next);
	};
	const isDraggingRef = useRef(false);
	// The last CSS this picker emitted, so the echo of our own change isn't loaded back in.
	const emittedRef = useRef<string | null>(null);
	const loadingRef = useRef(false);

	const controllerRef = useRef<GradientController | null>(null);
	if (!controllerRef.current) {
		controllerRef.current = new GradientController({
			value: parseCssGradient(value) ?? createDefaultGradientFromColor(value),
			readOnly: () => latest.current.disabled,
			onChange: (g) => {
				if (loadingRef.current || latest.current.mode !== 'gradient') return;
				const css = gradientToCss(g);
				emittedRef.current = css;
				latest.current.onChange(css);
			}
		});
	}
	const controller = controllerRef.current;

	// Follow the incoming value, without an undo step, unless it is our own change coming back.
	const modesKey = modes.join(',');
	useEffect(() => {
		if (isDraggingRef.current) return;
		const incoming = parseCssGradient(value);
		if (incoming && allowsGradient) {
			setMode('gradient');
			if (value !== emittedRef.current) {
				loadingRef.current = true;
				try {
					controller.load(incoming);
				} finally {
					loadingRef.current = false;
				}
			}
		} else if (!incoming && allowsSolid) {
			setMode('solid');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value, modesKey, controller]);

	const handleGestureStart = () => {
		isDraggingRef.current = true;
		onGestureStart?.();
	};

	const handleGestureEnd = () => {
		isDraggingRef.current = false;
		onGestureEnd?.();
	};

	const emit = (next: string) => {
		emittedRef.current = next;
		onChange(next);
	};

	const switchToSolid = () => {
		if (latest.current.mode === 'solid') return;
		setMode('solid');
		const first = controller.getGradient().stops[0]?.color ?? '#000000';
		// A dual stop has no single solid equivalent; keep its light half.
		emit(resolveColor(first, 'light') ?? '#000000');
	};

	const switchToGradient = () => {
		if (latest.current.mode === 'gradient') return;
		setMode('gradient');
		const next = createDefaultGradientFromColor(value);
		loadingRef.current = true;
		try {
			controller.load(next);
		} finally {
			loadingRef.current = false;
		}
		emit(gradientToCss(controller.getGradient()));
	};

	const gradientEditor = (
		<GradientEditor
			controller={controller}
			showPresets={showPresets}
			showCss={showCss}
			onGestureStart={handleGestureStart}
			onGestureEnd={handleGestureEnd}
		/>
	);

	// If only solid is allowed
	if (modes.length === 1 && modes[0] === 'solid') {
		return (
			<div className={className} data-testid="fill-picker">
				<ColorPicker
					value={value}
					onChange={onChange}
					onGestureStart={onGestureStart}
					onGestureEnd={onGestureEnd}
					alpha={alpha}
					swatches={swatches}
					disabled={disabled}
				/>
			</div>
		);
	}

	// If only gradient is allowed
	if (modes.length === 1 && modes[0] === 'gradient') {
		return (
			<div className={className} data-testid="fill-picker">
				{gradientEditor}
			</div>
		);
	}

	return (
		<div className={`flex flex-col gap-2.5 ${className ?? ''}`} data-testid="fill-picker">
			{/* Mode toggle tabs */}
			<div className="flex rounded-md border border-border p-0.5">
				<button
					type="button"
					className={`flex-1 ${buttonClass}`}
					aria-pressed={mode === 'solid'}
					disabled={disabled}
					onClick={switchToSolid}
				>
					Solid
				</button>
				<button
					type="button"
					className={`flex-1 ${buttonClass}`}
					aria-pressed={mode === 'gradient'}
					disabled={disabled}
					onClick={switchToGradient}
				>
					Gradient
				</button>
			</div>

			{mode === 'solid' ? (
				<ColorPicker
					value={value}
					onChange={onChange}
					onGestureStart={handleGestureStart}
					onGestureEnd={handleGestureEnd}
					alpha={alpha}
					swatches={swatches}
					disabled={disabled}
				/>
			) : (
				gradientEditor
			)}
		</div>
	);
}
