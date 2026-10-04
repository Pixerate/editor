<script lang="ts">
	import type { AgentPresence } from '@pixerate/editor/agent';

	interface Props {
		presences: AgentPresence[];
		class?: string;
	}

	let { presences = [], class: className = '' }: Props = $props();
</script>

{#if presences.length > 0}
	<div
		class="pixerate-presence agent-presence pixerate-agent-presence-layer pointer-events-none absolute inset-0 z-50 overflow-hidden {className}"
		aria-hidden="true"
	>
		{#each presences as agent (agent.agentId)}
			{#if agent.cursorPosition}
				<div
					class="absolute transition-transform duration-75 ease-out"
					style="transform: translate3d({agent.cursorPosition.x}px, {agent.cursorPosition.y}px, 0);"
				>
					<!-- Cursor SVG -->
					<svg
						class="h-5 w-5 drop-shadow-md"
						viewBox="0 0 24 24"
						fill="none"
						xmlns="http://www.w3.org/2000/svg"
					>
						<path
							d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z"
							fill={agent.color || '#3b82f6'}
							stroke="white"
							stroke-width="1"
						/>
					</svg>

					<!-- Agent Label Pill -->
					<div
						class="mt-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white shadow-md whitespace-nowrap"
						style="background-color: {agent.color || '#3b82f6'};"
					>
						<span>{agent.name}</span>
						{#if agent.statusMessage}
							<span class="opacity-80 text-[10px]">({agent.statusMessage})</span>
						{/if}
					</div>

					<!-- Narration Bubble (say / note) -->
					{#if agent.note}
						<div class="mt-1 max-w-xs rounded-lg bg-white/95 backdrop-blur-sm border border-slate-200 px-2.5 py-1.5 text-xs text-slate-800 shadow-lg dark:bg-slate-900/95 dark:border-slate-700 dark:text-slate-100">
							{agent.note}
						</div>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
{/if}
