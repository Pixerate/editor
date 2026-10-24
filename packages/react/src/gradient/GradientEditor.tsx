import React, { useCallback, useRef } from 'react';
import {
	GRADIENT_PRESETS,
	type GradientController,
	type GradientInterpolation,
	type GradientType,
	angleFromPointer,
	gradientKeyStep,
	gradientToCss,
	gradientToCssFallback,
	gradientTrackBackground,
	isDualGradient
} from '@pixerate/editor/gradient';
import { formatDualColor, type ColorScheme } from '@pixerate/editor/color';
import { ColorPicker } from '../color/ColorPicker';
import { DualColorPicker } from '../color/DualColorPicker';
import { useGradientState } from './useGradientController';

export interface GradientEditorProps {
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
	onGestureStart?: () => void;
	/** Called when that edit ends. */
	onGestureEnd?: () => void;
	/** Additional CSS class name. */
	className?: string;
}

const DEFAULT_TYPES: readonly GradientType[] = ['linear', 'radial', 'conic'];
const INTERPOLATIONS: readonly GradientInterpolation[] = ['oklab', 'oklch', 'srgb', 'srgb-linear'];

const buttonClass =
	'inline-flex h-7 items-center justify-center rounded border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const selectClass =
	'h-7 rounded border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';
const inputClass =
	'h-7 w-16 rounded border border-border bg-background px-1.5 text-center text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

export function GradientEditor({
	controller,
	types = DEFAULT_TYPES,
	showPresets = true,
	showCss = false,
	dual: controlledDual,
	onGestureStart,
	onGestureEnd,
	className
}: GradientEditorProps) {
	const state = useGradientState(controller);
	// A gesture is one undo step in the controller and is reported to the host.
	const beginGesture = (label: string) => {
		controller.beginGesture(label);
		onGestureStart?.();
	};
	const endGesture = () => {
		controller.endGesture();
		onGestureEnd?.();
	};
	const gradient = state.gradient;
	const selectedStopId = state.selectedStopId;

	const isDual = controlledDual ?? isDualGradient(gradient);
	const [activeScheme, setActiveScheme] = React.useState<ColorScheme>('light');
	const [copied, setCopied] = React.useState(false);

	const trackRef = useRef<HTMLDivElement>(null);
	const angleDialRef = useRef<HTMLDivElement>(null);

	const selectedStop = gradient.stops.find((s) => s.id === selectedStopId) ?? gradient.stops[0];

	// Preview CSS calculation
	const previewCss = isDual
		? gradientToCssFallback(gradient, 16, activeScheme)
		: gradientToCss(gradient);

	const trackCss = gradientTrackBackground(gradient);

	// Handle track click to add stop
	const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (controller.isReadOnly) return;
		const rect = e.currentTarget.getBoundingClientRect();
		if (rect.width <= 0) return;
		const offset = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		controller.addStop(offset);
	};

	// Handle stop drag
	const handleStopPointerDown = (e: React.PointerEvent, stopId: string) => {
		if (controller.isReadOnly) return;
		e.stopPropagation();
		controller.selectStop(stopId);
		beginGesture('Move Stop');

		const startY = e.clientY;
		const track = trackRef.current;
		const rect = track?.getBoundingClientRect();

		const onPointerMove = (moveEvent: PointerEvent) => {
			if (!rect || rect.width <= 0) return;
			// Remove if dragged more than 32px below the track and we have > 2 stops
			if (moveEvent.clientY - startY > 32 && controller.getGradient().stops.length > 2) {
				// Dragged down off track
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
	};

	// Stop keyboard navigation
	const handleStopKeyDown = (e: React.KeyboardEvent, stopId: string) => {
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
	};

	// Angle dial interaction
	const handleAngleDialPointerDown = (e: React.PointerEvent) => {
		if (controller.isReadOnly) return;
		const dial = angleDialRef.current;
		if (!dial) return;
		beginGesture('Change Angle');
		const rect = dial.getBoundingClientRect();
		const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

		const update = (pe: PointerEvent) => {
			const deg = angleFromPointer(center, { x: pe.clientX, y: pe.clientY }, pe.shiftKey ? 15 : 1);
			controller.setAngle(deg);
		};
		update(e.nativeEvent);

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
	};

	const copyCss = useCallback(() => {
		const text = gradientToCss(gradient);
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [gradient]);

	return (
		<div
			className={`flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm ${className ?? ''}`}
			data-testid="gradient-editor"
		>
			{/* Preview box */}
			<div className="relative h-20 w-full overflow-hidden rounded-md border border-border">
				<div
					className="absolute inset-0"
					style={{
						backgroundImage:
							'linear-gradient(45deg, #e0e0e0 25%, transparent 25%), linear-gradient(-45deg, #e0e0e0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e0e0e0 75%), linear-gradient(-45deg, transparent 75%, #e0e0e0 75%)',
						backgroundSize: '16px 16px',
						backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px'
					}}
				/>
				<div
					className="absolute inset-0 transition-all"
					style={{ background: previewCss }}
					data-testid="gradient-preview"
				/>
			</div>

			{/* Stop Track */}
			<div className="flex flex-col gap-1">
				<div
					ref={trackRef}
					role="button"
					tabIndex={0}
					aria-label="Add gradient stop"
					className="relative h-6 w-full cursor-pointer rounded border border-border"
					style={{ background: trackCss }}
					onClick={handleTrackClick}
					data-testid="gradient-track"
				>
					{gradient.stops.map((stop, idx) => {
						const isSelected = stop.id === selectedStopId;
						const pct = Math.round(stop.offset * 100);
						return (
							<button
								key={stop.id}
								type="button"
								role="slider"
								aria-label={`Stop ${idx + 1}, ${stop.color} at ${pct}%`}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={pct}
								aria-pressed={isSelected}
								disabled={controller.isReadOnly}
								className={`absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded border border-white shadow-sm transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
									isSelected ? 'scale-110 ring-2 ring-primary z-10' : 'hover:scale-105'
								}`}
								style={{
									left: `${stop.offset * 100}%`,
									backgroundColor: stop.color.startsWith('light-dark(') ? '#888' : stop.color
								}}
								onClick={(e) => {
									e.stopPropagation();
									controller.selectStop(stop.id);
								}}
								onPointerDown={(e) => handleStopPointerDown(e, stop.id)}
								onKeyDown={(e) => handleStopKeyDown(e, stop.id)}
								data-testid={`gradient-stop-${stop.id}`}
							/>
						);
					})}
				</div>
				<div className="flex justify-between px-0.5 text-[10px] text-muted-foreground">
					<span>0%</span>
					<span>50%</span>
					<span>100%</span>
				</div>
			</div>

			{/* Geometry and Types toolbar */}
			<div className="flex flex-wrap items-center gap-2">
				{types.length > 1 && (
					<div className="flex rounded-md border border-border p-0.5">
						{types.map((t) => (
							<button
								key={t}
								type="button"
								className={buttonClass}
								aria-pressed={gradient.type === t}
								disabled={controller.isReadOnly}
								onClick={() => controller.setType(t)}
							>
								{t.charAt(0).toUpperCase() + t.slice(1)}
							</button>
						))}
					</div>
				)}

				{(gradient.type === 'linear' || gradient.type === 'conic') && (
					<div className="flex items-center gap-1.5">
						<div
							ref={angleDialRef}
							role="slider"
							tabIndex={0}
							aria-label="Gradient angle"
							aria-valuemin={0}
							aria-valuemax={360}
							aria-valuenow={gradient.angle ?? 180}
							className="relative h-7 w-7 cursor-crosshair rounded-full border border-border bg-muted/40 shadow-inner flex items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
							onPointerDown={handleAngleDialPointerDown}
						>
							<div
								className="h-2.5 w-0.5 rounded-full bg-foreground"
								style={{
									transform: `rotate(${gradient.angle ?? 180}deg) translateY(-50%)`,
									transformOrigin: '50% 100%'
								}}
							/>
						</div>
						<input
							type="number"
							aria-label="Angle in degrees"
							className={inputClass}
							min={0}
							max={360}
							value={Math.round(gradient.angle ?? 180)}
							disabled={controller.isReadOnly}
							onChange={(e) => controller.setAngle(Number(e.target.value) % 360)}
						/>
						<span className="text-xs text-muted-foreground">°</span>
					</div>
				)}

				{gradient.type === 'radial' && (
					<div className="flex items-center gap-1">
						<button
							type="button"
							className={buttonClass}
							aria-pressed={(gradient.shape ?? 'ellipse') === 'circle'}
							disabled={controller.isReadOnly}
							onClick={() =>
								controller.setShape((gradient.shape ?? 'ellipse') === 'circle' ? 'ellipse' : 'circle')
							}
						>
							{(gradient.shape ?? 'ellipse') === 'circle' ? 'Circle' : 'Ellipse'}
						</button>
					</div>
				)}

				<select
					aria-label="Interpolation space"
					className={selectClass}
					value={gradient.interpolation ?? 'oklab'}
					disabled={controller.isReadOnly}
					onChange={(e) => controller.setInterpolation(e.target.value as GradientInterpolation)}
				>
					{INTERPOLATIONS.map((space) => (
						<option key={space} value={space}>
							{space}
						</option>
					))}
				</select>

				<div className="flex items-center gap-1 ml-auto">
					<button
						type="button"
						className={buttonClass}
						title="Reverse stops"
						aria-label="Reverse stops"
						disabled={controller.isReadOnly}
						onClick={() => controller.reverse()}
					>
						⇄
					</button>
					<button
						type="button"
						className={buttonClass}
						title="Distribute stops evenly"
						aria-label="Distribute stops evenly"
						disabled={controller.isReadOnly}
						onClick={() => controller.distribute()}
					>
						⫶⫶
					</button>
					{gradient.stops.length > 2 && selectedStop && (
						<button
							type="button"
							className={buttonClass}
							title="Delete selected stop"
							aria-label="Delete selected stop"
							disabled={controller.isReadOnly}
							onClick={() => controller.removeStop(selectedStop.id)}
						>
							✕
						</button>
					)}
				</div>
			</div>

			{/* Selected stop colour editor */}
			{selectedStop && (
				<div className="rounded-md border border-border p-2">
					<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
						<span>Selected Stop ({Math.round(selectedStop.offset * 100)}%)</span>
						<div className="flex items-center gap-1">
							<span>Offset:</span>
							<input
								type="number"
								aria-label="Stop offset percentage"
								className={inputClass}
								min={0}
								max={100}
								value={Math.round(selectedStop.offset * 100)}
								disabled={controller.isReadOnly}
								onChange={(e) =>
									controller.updateStop(selectedStop.id, {
										offset: Math.max(0, Math.min(100, Number(e.target.value))) / 100
									})
								}
							/>
							<span>%</span>
						</div>
					</div>

					{isDual ? (
						<DualColorPicker
							value={selectedStop.color}
							scheme={activeScheme}
							onSchemeChange={setActiveScheme}
							onChange={(dualColor) => {
								controller.updateStop(selectedStop.id, {
									color: formatDualColor(dualColor)
								});
							}}
							onGestureStart={() => beginGesture('Change Stop Color')}
							onGestureEnd={() => endGesture()}
							disabled={controller.isReadOnly}
						/>
					) : (
						<ColorPicker
							value={selectedStop.color}
							alpha={true}
							onChange={(color) => {
								controller.updateStop(selectedStop.id, { color });
							}}
							onGestureStart={() => beginGesture('Change Stop Color')}
							onGestureEnd={() => endGesture()}
							disabled={controller.isReadOnly}
						/>
					)}
				</div>
			)}

			{/* Presets */}
			{showPresets && (
				<div className="flex flex-col gap-1">
					<span className="text-[11px] font-medium text-muted-foreground">Presets</span>
					<div className="flex flex-wrap gap-1.5" data-testid="gradient-presets">
						{Object.entries(GRADIENT_PRESETS).map(([name, preset]) => (
							<button
								key={name}
								type="button"
								className="h-6 w-10 rounded border border-border shadow-sm transition hover:scale-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
								style={{ background: gradientToCss(preset) }}
								title={name}
								aria-label={`Preset ${name}`}
								disabled={controller.isReadOnly}
								onClick={() => controller.setGradient(preset, `Apply Preset ${name}`)}
							/>
						))}
					</div>
				</div>
			)}

			{/* CSS Code Output */}
			{showCss && (
				<div className="flex flex-col gap-1 border-t border-border pt-2">
					<div className="flex items-center justify-between">
						<span className="text-[11px] font-medium text-muted-foreground">CSS Code</span>
						<button type="button" className={buttonClass} onClick={copyCss}>
							{copied ? 'Copied!' : 'Copy'}
						</button>
					</div>
					<pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground select-all">
						{gradientToCss(gradient)}
					</pre>
				</div>
			)}
		</div>
	);
}
