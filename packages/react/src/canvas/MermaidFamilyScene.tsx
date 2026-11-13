import React, { useId, useRef, useState } from 'react';
import { diagramTextBaseline, isDiagramDrag, previewDiagramDrag, type DiagramDrag, type DiagramMark, type DiagramScene } from '@pixerate/editor/canvas';

export interface MermaidFamilySceneProps {
	/** The family's picture (`useMermaidDiagram().scene`, or `mermaidToScene`). */
	scene: DiagramScene;
	/** Room around the drawing in px (default 16). */
	padding?: number;
	/** Marks with a target get a pointer and report clicks (default true). */
	interactive?: boolean;
	/** A mark was clicked: its node, edge, group or `::title` target (null: the background). */
	onSelect?: (target: string | null, event: React.MouseEvent) => void;
	/** A mark was double-clicked (rename it with `diagramRenameOp`). */
	onOpen?: (target: string, event: React.MouseEvent) => void;
	/**
	 * Makes marks with a `drag` kind draggable (pass a scene from `withDiagramDragHandles`, as
	 * `useMermaidDiagram().scene` is when editable): the node follows the pointer, and the
	 * finished drag is reported for `useMermaidDiagram().drop` (or `planDiagramDrag`).
	 */
	onDragEnd?: (drag: DiagramDrag) => void;
	/** Colour of selected marks' outline (default `var(--primary, #2563eb)`). */
	selectionColor?: string;
	/** Arrow head colour (default `var(--muted-foreground, #64748b)`). */
	markerColor?: string;
	className?: string;
	style?: React.CSSProperties;
	/** Accessible name (default: the family). */
	title?: string;
}

/**
 * Headless renderer for a Mermaid family drawn as its own picture (pie, Gantt, sequence,
 * quadrant, timeline, journey, gitGraph, mindmap, C4, architecture, XY and radar charts):
 * one SVG of the scene's marks, sized to the drawing. Clicking a mark selects its node,
 * edge or group; double-clicking opens it for renaming.
 */
export function MermaidFamilyScene({
	scene,
	padding = 16,
	interactive = true,
	onSelect,
	onOpen,
	onDragEnd,
	selectionColor = 'var(--primary, #2563eb)',
	markerColor = 'var(--muted-foreground, #64748b)',
	className = '',
	style,
	title
}: MermaidFamilySceneProps) {
	const uid = useId().replace(/:/g, '');
	const svgRef = useRef<SVGSVGElement>(null);
	const [drag, setDrag] = useState<DiagramDrag | null>(null);
	/** Set when a press turned into a drag, so the click that follows is not a selection. */
	const dragged = useRef(false);
	const toScene = (event: { clientX: number; clientY: number }): [number, number] => {
		const ctm = svgRef.current?.getScreenCTM?.();
		if (!ctm) return [event.clientX, event.clientY];
		const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
		return [p.x, p.y];
	};
	const overAt = (event: { clientX: number; clientY: number }, self: string): string | null => {
		const hit = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('[data-target]')?.getAttribute('data-target') ?? null;
		return hit && hit !== self ? hit : null;
	};
	const startDrag = (mark: DiagramMark, event: React.PointerEvent) => {
		if (!interactive || !onDragEnd || !mark.drag || !mark.target || event.button !== 0) return;
		event.stopPropagation();
		const start = toScene(event);
		let current: DiagramDrag = { kind: mark.drag, target: mark.target, start, pointer: start };
		dragged.current = false;
		const move = (ev: PointerEvent) => {
			current = { ...current, pointer: toScene(ev), over: mark.drag === 'connect' ? overAt(ev, mark.target!) : null };
			if (isDiagramDrag(current)) dragged.current = true;
			setDrag(current);
		};
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			current = { ...current, pointer: toScene(ev), over: mark.drag === 'connect' ? overAt(ev, mark.target!) : null };
			setDrag(null);
			if (isDiagramDrag(current)) onDragEnd(current);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};
	const shown = drag ? previewDiagramDrag(scene, drag, { theme: { selection: selectionColor } }) : scene;
	const marker = (kind?: 'arrow' | 'arrowclosed') => (kind ? `url(#${uid}-${kind})` : undefined);
	const x = scene.x - padding;
	const y = scene.y - padding;
	const width = Math.max(1, scene.width + padding * 2);
	const height = Math.max(1, scene.height + padding * 2);
	const handlers = (mark: DiagramMark) =>
		interactive && mark.target
			? {
					onClick: (event: React.MouseEvent) => {
						event.stopPropagation();
						if (dragged.current) {
							dragged.current = false;
							return;
						}
						onSelect?.(mark.target!, event);
					},
					onPointerDown: (event: React.PointerEvent) => startDrag(mark, event),
					onDoubleClick: (event: React.MouseEvent) => {
						event.stopPropagation();
						onOpen?.(mark.target!, event);
					},
					cursor: onDragEnd && mark.drag ? (mark.drag === 'move-x' ? 'ew-resize' : mark.drag === 'resize' ? 'col-resize' : mark.drag === 'score' || mark.drag === 'order' || mark.drag === 'move-y' ? 'ns-resize' : mark.drag === 'connect' ? 'crosshair' : 'move') : 'pointer'
				}
			: { pointerEvents: 'none' as const };
	const shift = (mark: DiagramMark) => (mark.offset && (mark.offset[0] || mark.offset[1]) ? `translate(${mark.offset[0]} ${mark.offset[1]})` : undefined);
	const stroke = (mark: { stroke?: string; strokeWidth?: number; selected?: boolean }) =>
		mark.selected ? { stroke: selectionColor, strokeWidth: Math.max(2, mark.strokeWidth ?? 0) } : { stroke: mark.stroke, strokeWidth: mark.strokeWidth };
	return (
		<svg
			ref={svgRef}
			className={`pixerate-diagram-scene ${className}`.trim()}
			data-family={scene.family}
			role="img"
			aria-label={title ?? `${scene.family} diagram`}
			viewBox={`${x} ${y} ${width} ${height}`}
			width={width}
			height={height}
			style={{ display: 'block', maxWidth: '100%', height: 'auto', overflow: 'visible', ...style }}
			onClick={interactive ? (event) => (dragged.current ? (dragged.current = false) : onSelect?.(null, event)) : undefined}
		>
			<defs>
				<marker id={`${uid}-arrowclosed`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
					<path d="M0,0 L10,5 L0,10 Z" style={{ fill: markerColor }} />
				</marker>
				<marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
					<path d="M0,0 L10,5 L0,10" style={{ fill: 'none', stroke: markerColor, strokeWidth: 1.5 }} />
				</marker>
			</defs>
			{shown.marks.map((mark) => {
				const common = {
					'data-role': mark.role,
					'data-target': mark.target,
					'data-drag': onDragEnd ? mark.drag : undefined,
					'data-selected': mark.selected ? '' : undefined,
					opacity: mark.opacity,
					transform: mark.kind === 'text' ? undefined : shift(mark),
					...handlers(mark)
				};
				switch (mark.kind) {
					case 'rect':
						return (
							<rect
								key={mark.key}
								{...common}
								x={mark.x}
								y={mark.y}
								width={Math.max(0, mark.width)}
								height={Math.max(0, mark.height)}
								rx={mark.radius}
								strokeDasharray={mark.dash}
								style={{ fill: mark.fill, ...stroke(mark) }}
							/>
						);
					case 'circle':
						return <circle key={mark.key} {...common} cx={mark.cx} cy={mark.cy} r={mark.r} style={{ fill: mark.fill, ...stroke(mark) }} />;
					case 'line':
						return (
							<line
								key={mark.key}
								{...common}
								x1={mark.x1}
								y1={mark.y1}
								x2={mark.x2}
								y2={mark.y2}
								strokeDasharray={mark.dash}
								markerEnd={marker(mark.markerEnd)}
								markerStart={marker(mark.markerStart)}
								style={{ stroke: mark.selected ? selectionColor : mark.stroke, strokeWidth: mark.strokeWidth ?? 1 }}
							/>
						);
					case 'path':
						return (
							<path
								key={mark.key}
								{...common}
								d={mark.d}
								strokeDasharray={mark.dash}
								strokeLinejoin="round"
								markerEnd={marker(mark.markerEnd)}
								markerStart={marker(mark.markerStart)}
								style={{ fill: mark.fill ?? 'none', ...stroke(mark) }}
							/>
						);
					case 'text':
						return (
							<text
								key={mark.key}
								{...common}
								x={mark.x}
								y={mark.y}
								textAnchor={mark.anchor}
								dominantBaseline={diagramTextBaseline(mark.baseline)}
								transform={[shift(mark), mark.rotate ? `rotate(${mark.rotate} ${mark.x} ${mark.y})` : ''].filter(Boolean).join(' ') || undefined}
								style={{
									fill: mark.selected ? selectionColor : mark.fill,
									fontSize: mark.size,
									fontWeight: mark.weight,
									fontStyle: mark.italic ? 'italic' : undefined,
									userSelect: 'none'
								}}
							>
								{mark.text}
							</text>
						);
				}
			})}
		</svg>
	);
}
