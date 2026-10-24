import React, { useState, useId } from 'react';
import {
	normalizeDualColor,
	setDualColorSide,
	deriveDualColor,
	checkDualColorContrast,
	resolveColor,
	DEFAULT_SCHEME_SURFACES,
	type ColorScheme,
	type ColorValue,
	type DualColor
} from '@pixerate/editor/color';
import { ColorPicker } from './ColorPicker';

export interface DualColorPickerProps {
	/** Active color value: plain CSS colour, light-dark() string, or { light, dark } object. */
	value: ColorValue;
	/** Called when either half changes. Always receives normalised DualColor with hex values. */
	onChange: (value: DualColor) => void;
	/** Called when a continuous dragging gesture begins in the inner picker or during derivation. */
	onGestureStart?: () => void;
	/** Called when a continuous dragging gesture ends in the inner picker or during derivation. */
	onGestureEnd?: () => void;
	/** Which scheme half is currently selected for editing ('light' or 'dark'). */
	scheme?: ColorScheme;
	/** Called when the selected scheme half changes. */
	onSchemeChange?: (scheme: ColorScheme) => void;
	/** Background surfaces for light and dark previews. Default { light: '#ffffff', dark: '#0b0b0f' }. */
	surfaces?: DualColor;
	/** Contrast reference target to measure against in both schemes. */
	contrastAgainst?: ColorValue;
	/** Whether alpha transparency is enabled. Default false. */
	alpha?: boolean;
	/** Swatch palette colours. */
	swatches?: string[];
	/** Whether interactions are disabled. Default false. */
	disabled?: boolean;
	/** Additional CSS class name. */
	className?: string;
}

export function DualColorPicker({
	value,
	onChange,
	onGestureStart,
	onGestureEnd,
	scheme: controlledScheme,
	onSchemeChange,
	surfaces = DEFAULT_SCHEME_SURFACES,
	contrastAgainst,
	alpha = false,
	swatches,
	disabled = false,
	className = ''
}: DualColorPickerProps): React.ReactElement {
	const sameId = useId();

	// Scheme selection state (controlled or uncontrolled)
	const [internalScheme, setInternalScheme] = useState<ColorScheme>('light');
	const activeScheme = controlledScheme ?? internalScheme;

	const handleSchemeSelect = (nextScheme: ColorScheme) => {
		if (onSchemeChange) {
			onSchemeChange(nextScheme);
		} else {
			setInternalScheme(nextScheme);
		}
	};

	// Parse current DualColor
	const dual = normalizeDualColor(value) ?? { light: '#000000', dark: '#000000' };
	const isSame = dual.light.toLowerCase() === dual.dark.toLowerCase();

	// "Same in both" state
	const [sameInBoth, setSameInBoth] = useState<boolean>(isSame);

	const handleSameToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
		const nextSame = e.target.checked;
		setSameInBoth(nextSame);
		if (nextSame) {
			const activeVal = activeScheme === 'dark' ? dual.dark : dual.light;
			onChange({ light: activeVal, dark: activeVal });
		}
	};

	const handleDerive = () => {
		if (disabled) return;
		onGestureStart?.();
		const currentActive = activeScheme === 'dark' ? dual.dark : dual.light;
		const derived = deriveDualColor(currentActive, {
			from: activeScheme,
			// An unreadable surfaces prop falls back to the defaults rather than throwing.
			surfaces: normalizeDualColor(surfaces) ?? DEFAULT_SCHEME_SURFACES
		});
		onChange(derived);
		onGestureEnd?.();
	};

	const handleInnerChange = (hex: string) => {
		if (sameInBoth) {
			onChange({ light: hex, dark: hex });
		} else {
			const updated = setDualColorSide(dual, activeScheme, hex);
			onChange(updated);
		}
	};

	const activeColor = activeScheme === 'dark' ? dual.dark : dual.light;
	const activeContrastTarget = contrastAgainst
		? resolveColor(contrastAgainst, activeScheme) ?? undefined
		: undefined;

	// Contrast evaluations for both modes
	// An unreadable contrastAgainst shows no badges rather than throwing during render.
	const dualContrast = contrastAgainst && normalizeDualColor(contrastAgainst)
		? checkDualColorContrast(dual, contrastAgainst)
		: null;

	return (
		<div
			className={`pixerate-dual-color-picker ${className}`}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '12px',
				padding: '12px',
				background: '#1a1d24',
				color: '#e2e8f0',
				borderRadius: '10px',
				boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
				width: '260px',
				fontFamily: 'system-ui, -apple-system, sans-serif',
				fontSize: '13px',
				boxSizing: 'border-box'
			}}
		>
			{/* Segmented Control */}
			<div
				role="tablist"
				aria-label="Color scheme mode"
				style={{
					display: 'flex',
					background: '#111318',
					borderRadius: '6px',
					padding: '2px',
					gap: '2px'
				}}
			>
				<button
					type="button"
					role="tab"
					aria-selected={activeScheme === 'light'}
					onClick={() => handleSchemeSelect('light')}
					disabled={disabled}
					style={{
						flex: 1,
						padding: '6px 8px',
						border: 'none',
						borderRadius: '4px',
						background: activeScheme === 'light' ? '#2d3342' : 'transparent',
						color: activeScheme === 'light' ? '#ffffff' : '#8c95a6',
						fontWeight: activeScheme === 'light' ? 600 : 400,
						cursor: disabled ? 'not-allowed' : 'pointer',
						fontSize: '12px',
						transition: 'all 0.15s ease'
					}}
				>
					Light
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeScheme === 'dark'}
					onClick={() => handleSchemeSelect('dark')}
					disabled={disabled}
					style={{
						flex: 1,
						padding: '6px 8px',
						border: 'none',
						borderRadius: '4px',
						background: activeScheme === 'dark' ? '#2d3342' : 'transparent',
						color: activeScheme === 'dark' ? '#ffffff' : '#8c95a6',
						fontWeight: activeScheme === 'dark' ? 600 : 400,
						cursor: disabled ? 'not-allowed' : 'pointer',
						fontSize: '12px',
						transition: 'all 0.15s ease'
					}}
				>
					Dark
				</button>
			</div>

			{/* Previews side by side */}
			<div style={{ display: 'flex', gap: '8px' }}>
				{/* Light Preview */}
				<button
					type="button"
					onClick={() => handleSchemeSelect('light')}
					disabled={disabled}
					title="Edit light mode colour"
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: '6px',
						padding: '8px',
						background: surfaces.light,
						color: '#000000',
						border: activeScheme === 'light' ? '2px solid #3b82f6' : '1px solid #333842',
						borderRadius: '6px',
						cursor: disabled ? 'not-allowed' : 'pointer',
						outline: 'none'
					}}
				>
					<span
						style={{
							width: '100%',
							height: '24px',
							borderRadius: '4px',
							background: dual.light,
							border: '1px solid rgba(0,0,0,0.15)'
						}}
					/>
					<span style={{ fontSize: '11px', fontWeight: 600 }}>Light</span>
				</button>

				{/* Dark Preview */}
				<button
					type="button"
					onClick={() => handleSchemeSelect('dark')}
					disabled={disabled}
					title="Edit dark mode colour"
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: '6px',
						padding: '8px',
						background: surfaces.dark,
						color: '#ffffff',
						border: activeScheme === 'dark' ? '2px solid #3b82f6' : '1px solid #333842',
						borderRadius: '6px',
						cursor: disabled ? 'not-allowed' : 'pointer',
						outline: 'none'
					}}
				>
					<span
						style={{
							width: '100%',
							height: '24px',
							borderRadius: '4px',
							background: dual.dark,
							border: '1px solid rgba(255,255,255,0.15)'
						}}
					/>
					<span style={{ fontSize: '11px', fontWeight: 600 }}>Dark</span>
				</button>
			</div>

			{/* Controls: Same in both & Derive */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: '8px',
					padding: '2px 0'
				}}
			>
				<label
					htmlFor={sameId}
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '6px',
						cursor: disabled ? 'not-allowed' : 'pointer',
						userSelect: 'none',
						fontSize: '12px',
						color: '#c4cad4'
					}}
				>
					<input
						id={sameId}
						type="checkbox"
						checked={sameInBoth}
						onChange={handleSameToggle}
						disabled={disabled}
						style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
					/>
					<span>Same in both</span>
				</label>

				<button
					type="button"
					onClick={handleDerive}
					disabled={disabled}
					style={{
						padding: '4px 10px',
						background: '#2d3342',
						color: '#e2e8f0',
						border: '1px solid #3b4252',
						borderRadius: '4px',
						fontSize: '11px',
						fontWeight: 500,
						cursor: disabled ? 'not-allowed' : 'pointer'
					}}
				>
					Derive
				</button>
			</div>

			{/* Dual Contrast Badges (if contrastAgainst is provided) */}
			{dualContrast && (
				<div
					data-testid="dual-contrast-summary"
					style={{
						display: 'flex',
						justifyContent: 'space-between',
						background: '#111318',
						padding: '6px 8px',
						borderRadius: '6px',
						fontSize: '11px',
						color: '#8c95a6'
					}}
				>
					<span>
						Light:{' '}
						<strong style={{ color: dualContrast.light.level === 'fail' ? '#ef4444' : '#22c55e' }}>
							{dualContrast.light.ratio.toFixed(2)} ({dualContrast.light.level})
						</strong>
					</span>
					<span>
						Dark:{' '}
						<strong style={{ color: dualContrast.dark.level === 'fail' ? '#ef4444' : '#22c55e' }}>
							{dualContrast.dark.ratio.toFixed(2)} ({dualContrast.dark.level})
						</strong>
					</span>
				</div>
			)}

			{/* Inner ColorPicker */}
			<ColorPicker
				value={activeColor}
				onChange={handleInnerChange}
				onGestureStart={onGestureStart}
				onGestureEnd={onGestureEnd}
				contrastAgainst={activeContrastTarget}
				alpha={alpha}
				swatches={swatches}
				disabled={disabled}
			/>
		</div>
	);
}
