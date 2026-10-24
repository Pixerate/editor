import React, { useEffect, useRef, useState } from 'react';
import {
	GradientController,
	createGradient,
	gradientToCss,
	parseCssGradient
} from '@pixerate/editor/gradient';
import { formatHex, mixColors, parseColor } from '@pixerate/editor/color';
import { ColorPicker } from '../color/ColorPicker';
import { GradientEditor } from './GradientEditor';

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
	modes?: readonly ('solid' | 'gradient')[];
	/** Whether the alpha channel slider is shown on ColorPicker. Default: false. */
	alpha?: boolean;
	/** Preset swatches for ColorPicker. */
	swatches?: readonly string[];
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
	modes = ['solid', 'gradient'],
	alpha = false,
	swatches,
	className,
	disabled = false
}: FillPickerProps) {
	// Check whether incoming value is a gradient
	const parsedGrad = parseCssGradient(value);
	const initialMode: 'solid' | 'gradient' =
		parsedGrad && modes.includes('gradient')
			? 'gradient'
			: modes.includes('solid')
				? 'solid'
				: 'gradient';

	const [mode, setMode] = useState<'solid' | 'gradient'>(initialMode);
	const isDraggingRef = useRef(false);

	// Internal gradient controller
	const controllerRef = useRef<GradientController | null>(null);
	if (!controllerRef.current) {
		const initialGradient = parsedGrad ?? createDefaultGradientFromColor(value);
		controllerRef.current = new GradientController({
			value: initialGradient,
			readOnly: disabled,
			onChange: (g) => {
				if (mode === 'gradient') {
					onChange(gradientToCss(g));
				}
			}
		});
	}
	const controller = controllerRef.current;

	// Synchronise with incoming value when not dragging
	useEffect(() => {
		if (isDraggingRef.current) return;
		const incomingGradient = parseCssGradient(value);
		if (incomingGradient) {
			if (modes.includes('gradient')) {
				setMode('gradient');
				controller.setGradient(incomingGradient);
			}
		} else {
			if (modes.includes('solid')) {
				setMode('solid');
			}
		}
	}, [value, modes, controller]);

	const handleGestureStart = () => {
		isDraggingRef.current = true;
		onGestureStart?.();
	};

	const handleGestureEnd = () => {
		isDraggingRef.current = false;
		onGestureEnd?.();
	};

	const switchToSolid = () => {
		setMode('solid');
		const stops = controller.getGradient().stops;
		const solidColor = stops[0]?.color ?? '#000000';
		onChange(solidColor);
	};

	const switchToGradient = () => {
		setMode('gradient');
		const newGrad = createDefaultGradientFromColor(value);
		controller.setGradient(newGrad);
		onChange(gradientToCss(newGrad));
	};

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
				<GradientEditor controller={controller} />
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
				<GradientEditor controller={controller} />
			)}
		</div>
	);
}
