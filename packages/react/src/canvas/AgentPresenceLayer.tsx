import React from 'react';
import type { AgentPresence } from '@pixerate/editor/agent';

export interface AgentPresenceLayerProps {
	presences: AgentPresence[];
	className?: string;
}

/**
 * Visual multiplayer and agent choreography presence layer for React Canvas.
 * Renders floating cursor indicators, agent name tags, and active status tooltips.
 */
export function AgentPresenceLayer({ presences, className = '' }: AgentPresenceLayerProps) {
	if (!presences || presences.length === 0) return null;

	return (
		<div
			className={`pixerate-presence agent-presence pixerate-agent-presence-layer pointer-events-none absolute inset-0 z-50 overflow-hidden ${className}`}
			aria-hidden="true"
		>
			{presences.map((agent) => {
				if (!agent.cursorPosition) return null;
				const { x, y } = agent.cursorPosition;
				const color = agent.color || '#3b82f6';

				return (
					<div
						key={agent.agentId}
						className="absolute transition-transform duration-75 ease-out"
						style={{
							transform: `translate3d(${x}px, ${y}px, 0)`
						}}
					>
						{/* Cursor SVG */}
						<svg
							className="h-5 w-5 drop-shadow-md"
							viewBox="0 0 24 24"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
						>
							<path
								d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z"
								fill={color}
								stroke="white"
								strokeWidth="1"
							/>
						</svg>

						{/* Agent Label Pill */}
						<div
							className="mt-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white shadow-md whitespace-nowrap"
							style={{ backgroundColor: color }}
						>
							<span>{agent.name}</span>
							{agent.statusMessage && (
								<span className="opacity-80 text-[10px]">({agent.statusMessage})</span>
							)}
						</div>

						{/* Narration Bubble (say / note) */}
						{agent.note && (
							<div className="mt-1 max-w-xs rounded-lg bg-white/95 backdrop-blur-sm border border-slate-200 px-2.5 py-1.5 text-xs text-slate-800 shadow-lg dark:bg-slate-900/95 dark:border-slate-700 dark:text-slate-100">
								{agent.note}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
