<script lang="ts">
	import {
		calculateCursorArrowRotation,
		formatAgentCursorName,
		getCursorTransitionDuration,
		isAgentCursor,
		type CanvasAgentCursor
	} from '@pixerate/editor/canvas';

	interface Props {
		cursors?: CanvasAgentCursor[];
		cursor?: CanvasAgentCursor;
		flowToScreenPosition?: (pos: { x: number; y: number }) => { x: number; y: number };
		darkMode?: boolean;
		class?: string;
	}

	let {
		cursors,
		cursor,
		flowToScreenPosition,
		darkMode = false,
		class: className = ''
	}: Props = $props();

	const activeCursors = $derived(cursors ?? (cursor ? [cursor] : []));

	interface CursorRenderState {
		lastX: number;
		lastY: number;
		durationMs: number;
		ease: string;
		tiltDeg: number;
		rotationDeg: number;
		hasMoved: boolean;
	}

	let renderStates = $state<Record<string, CursorRenderState>>({});

	$effect(() => {
		for (const c of activeCursors) {
			const prev = renderStates[c.id];
			const isAgent = Boolean(c.isAgent || isAgentCursor(c));
			const isServiceAccount = Boolean(c.isServiceAccount);
			const rot = calculateCursorArrowRotation(
				c,
				c.targetNodeCenter ?? null,
				isAgent || isServiceAccount,
				c.isModalOpen,
				prev?.rotationDeg ?? 0
			);

			if (!prev) {
				renderStates[c.id] = {
					lastX: c.x,
					lastY: c.y,
					durationMs: c.transitionDurationMs ?? 420,
					ease: c.customEase ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
					tiltDeg: 0,
					rotationDeg: rot.rotationDeg,
					hasMoved: false
				};
				continue;
			}

			const dx = c.x - prev.lastX;
			const dy = c.y - prev.lastY;
			const dist = Math.hypot(dx, dy);

			if (dist > 1) {
				const durationMs = c.transitionDurationMs ?? getCursorTransitionDuration(dist, c.id);
				const ease =
					c.customEase ??
					(dist < 60
						? 'cubic-bezier(0.2, 0.8, 0.2, 1)'
						: dist < 300
							? 'cubic-bezier(0.16, 1, 0.3, 1)'
							: 'cubic-bezier(0.22, 1, 0.36, 1)');
				const tiltDeg = Math.abs(dx) > 10 ? Math.max(-8, Math.min(8, (dx / dist) * 7)) : 0;

				renderStates[c.id] = {
					lastX: c.x,
					lastY: c.y,
					durationMs,
					ease,
					tiltDeg,
					rotationDeg: rot.rotationDeg,
					hasMoved: true
				};
			} else if (rot.rotationDeg !== prev.rotationDeg) {
				renderStates[c.id] = {
					...prev,
					rotationDeg: rot.rotationDeg
				};
			}
		}
	});

	function toScreenCoords(pos: { x: number; y: number }): { x: number; y: number } {
		if (flowToScreenPosition) {
			return flowToScreenPosition(pos);
		}
		return pos;
	}

	function resolveColor(c: CanvasAgentCursor, isAgent: boolean): string {
		if (c.color) return c.color;
		return isAgent ? '#8E51FF' : '#10b981';
	}

	function resolveDisplayName(c: CanvasAgentCursor, isAgent: boolean): string {
		if (isAgent) {
			return formatAgentCursorName(c.username || c.userId || c.id);
		}
		return c.username || 'User';
	}
</script>

{#if activeCursors.length > 0}
	<div
		class="pixerate-presence agent-presence pixerate-agent-cursor-presence pointer-events-none absolute inset-0 z-40 overflow-hidden select-none {className}"
		aria-hidden="true"
	>
		{#each activeCursors as c (c.id)}
			{@const pos = toScreenCoords({ x: c.x, y: c.y })}
			{@const state = renderStates[c.id]}
			{@const isAgent = Boolean(c.isAgent || isAgentCursor(c))}
			{@const isServiceAccount = Boolean(c.isServiceAccount)}
			{@const colorHex = resolveColor(c, isAgent)}
			{@const displayName = resolveDisplayName(c, isAgent)}
			{@const statusLabel = c.statusText || c.role || ''}
			{@const narration = c.message || c.note || ''}
			{@const rot = calculateCursorArrowRotation(
				c,
				c.targetNodeCenter ?? null,
				isAgent || isServiceAccount,
				c.isModalOpen,
				state?.rotationDeg ?? 0
			)}
			{@const arrowDeg = rot.shouldPoint ? rot.rotationDeg : (state?.tiltDeg ?? 0)}
			<div
				class="absolute pointer-events-none will-change-transform"
				data-agent-cursor-id={c.id}
				style="transform: translate3d({pos.x}px, {pos.y}px, 0); {state?.hasMoved
					? `transition: transform ${state.durationMs}ms ${state.ease};`
					: ''}"
			>
				<div class="flex items-start gap-1">
					<!-- Cursor SVG Arrow Pointer -->
					<div class="relative shrink-0">
						<svg
							width="24"
							height="28"
							viewBox="0 0 24 28"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							class="drop-shadow-md shrink-0 -translate-x-1 -translate-y-1 transition-transform duration-200 ease-out {c.isClicking
								? 'scale-75 !duration-75'
								: ''}"
							style="transform-origin: center; transform: rotate({arrowDeg}deg);"
						>
							<path
								d="M2.5 2.5L10.5 24.5L14.5 15.5L23.5 11.5L2.5 2.5Z"
								fill={colorHex}
								stroke={darkMode ? 'black' : 'white'}
								stroke-width="2"
								stroke-linejoin="round"
							/>
						</svg>
					</div>

					<div class="flex flex-col items-start gap-1">
						<!-- Glassmorphic Presence Pill -->
						<div
							class="flex items-center gap-1.5 px-2.5 py-1 rounded-full shadow-lg border backdrop-blur-md transition-colors bg-white/90 text-slate-900 dark:bg-slate-900/90 dark:text-slate-100"
							style="border-color: {colorHex};"
						>
							{#if c.avatarUrl}
								<img
									src={c.avatarUrl}
									alt={displayName}
									class="w-4 h-4 rounded-full object-cover shrink-0"
								/>
							{:else}
								<div
									class="w-4 h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center shrink-0"
									style="background: {isAgent
										? 'linear-gradient(135deg, #8E51FF 0%, #e12afb 100%)'
										: colorHex};"
								>
									{displayName.charAt(0).toUpperCase()}
								</div>
							{/if}

							<div class="flex flex-col leading-none pr-1 min-w-0 max-w-[200px]">
								<span
									class="text-[11px] font-semibold whitespace-nowrap truncate max-w-full"
									title={displayName}
								>
									{displayName}
								</span>
								{#if statusLabel}
									<span
										class="text-[9px] font-medium opacity-75 whitespace-nowrap truncate max-w-full"
										title={statusLabel}
									>
										{statusLabel}
									</span>
								{/if}
							</div>
						</div>

						<!-- Speech Narration Bubble -->
						{#if narration}
							<div
								class="px-2.5 py-1 rounded-lg bg-white/95 dark:bg-slate-900/95 text-slate-800 dark:text-slate-100 text-xs font-normal border border-slate-200 dark:border-slate-700 shadow-md max-w-[240px] backdrop-blur-md pointer-events-auto select-text break-words leading-tight"
								style="border-left: 3px solid {colorHex};"
							>
								{narration}
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
