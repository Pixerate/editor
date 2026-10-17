import React from 'react';
import type { PresenceStore } from '@pixerate/editor/diagram';
import { usePresenceState } from './useDiagramDirector.js';

export interface DiagramPresenceLayerProps {
	presence: PresenceStore;
	/** The canvas viewport (React Flow's `useViewport()`), to place cursors given in canvas coordinates. */
	viewport: { x: number; y: number; zoom: number };
	className?: string;
}

/** Agent cursors and their notes over a canvas, from a `PresenceStore` (see `DiagramDirector`). */
export function DiagramPresenceLayer({ presence, viewport, className = '' }: DiagramPresenceLayerProps) {
	const { actors } = usePresenceState(presence);
	if (!actors.length) return null;
	return (
		<div className={`pixerate-diagram-presence ${className}`.trim()} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 50 }}>
			{actors.map((a) => (
				<div key={a.id} data-actor={a.id} style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${a.x * viewport.zoom + viewport.x}px, ${a.y * viewport.zoom + viewport.y}px)` }}>
					<svg width="18" height="20" viewBox="0 0 12 18" style={{ display: 'block', transform: a.pressed ? 'scale(0.85)' : undefined, transformOrigin: '0 0' }}>
						<path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style={{ fill: a.color, stroke: '#ffffff', strokeWidth: 1 }} />
					</svg>
					<span style={{ position: 'absolute', left: 14, top: 16, whiteSpace: 'nowrap', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600, color: '#ffffff', background: a.color }}>
						{a.message ?? a.name}
					</span>
				</div>
			))}
		</div>
	);
}
