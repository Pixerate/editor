<script lang="ts">
	import { onMount } from 'svelte';

	let {
		targetElement = null,
		totalWidth = 1000,
		minHeightAboveFold = 80
	}: {
		targetElement?: HTMLDivElement | null;
		totalWidth?: number;
		minHeightAboveFold?: number;
	} = $props();

	let scrollbarRef = $state<HTMLDivElement | null>(null);
	let isVisible = $state(false);
	let barLeft = $state(0);
	let barWidth = $state(0);

	// The scrollLeft last mirrored into the floating bar from the target. The bar's
	// scroll event for that write arrives a frame later, by which point a smooth
	// scroll on the target has moved on; writing the stale value back would cancel
	// that smooth scroll. Only a bar position that differs from what we mirrored
	// came from the user dragging the bar.
	let mirroredLeft: number | null = null;

	function updateMetrics() {
		if (!targetElement) {
			isVisible = false;
			return;
		}

		const rect = targetElement.getBoundingClientRect();
		const hasHorizontalOverflow = targetElement.scrollWidth > targetElement.clientWidth;
		const isTopInView = rect.top < window.innerHeight;
		const isBottomBelowViewport = rect.bottom > window.innerHeight;
		const isBottomAboveTop = rect.bottom > minHeightAboveFold;

		// Visible only when canvas is in viewport and its natural bottom scrollbar is off-screen
		const shouldShow =
			hasHorizontalOverflow && isTopInView && isBottomBelowViewport && isBottomAboveTop;
		isVisible = shouldShow;

		if (shouldShow) {
			const left = Math.max(0, rect.left);
			const right = Math.min(window.innerWidth, rect.right);
			barLeft = left;
			barWidth = Math.max(0, right - left);

			if (scrollbarRef && Math.abs(scrollbarRef.scrollLeft - targetElement.scrollLeft) > 1) {
				scrollbarRef.scrollLeft = targetElement.scrollLeft;
				mirroredLeft = scrollbarRef.scrollLeft;
			}
		}
	}

	function handleFloatingScroll() {
		if (!scrollbarRef || !targetElement) return;
		const left = scrollbarRef.scrollLeft;
		if (mirroredLeft !== null && Math.abs(left - mirroredLeft) <= 1) return;
		mirroredLeft = null;
		if (Math.abs(targetElement.scrollLeft - left) > 1) {
			targetElement.scrollLeft = left;
		}
	}

	onMount(() => {
		updateMetrics();

		const onScrollOrResize = () => {
			updateMetrics();
		};

		window.addEventListener('scroll', onScrollOrResize, { passive: true });
		window.addEventListener('resize', onScrollOrResize, { passive: true });

		const target = targetElement;
		if (target) {
			target.addEventListener('scroll', onScrollOrResize, { passive: true });
		}

		return () => {
			window.removeEventListener('scroll', onScrollOrResize);
			window.removeEventListener('resize', onScrollOrResize);
			if (target) {
				target.removeEventListener('scroll', onScrollOrResize);
			}
		};
	});

	$effect(() => {
		// Re-evaluate whenever targetElement or totalWidth changes
		if (targetElement) {
			updateMetrics();
		}
	});

	// A target can change size with no window or target event (a CSS variable
	// written in an animation frame, a sidebar closing), which would leave the bar
	// at the old left and width. Guarded because jsdom has no ResizeObserver.
	$effect(() => {
		const target = targetElement;
		if (!target || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => updateMetrics());
		observer.observe(target);
		return () => observer.disconnect();
	});
</script>

{#if isVisible}
	<div
		bind:this={scrollbarRef}
		onscroll={handleFloatingScroll}
		class="fixed bottom-0 z-50 overflow-x-auto overflow-y-hidden border-t border-border/40 bg-background/80 shadow-md backdrop-blur-sm transition-opacity duration-150"
		style="left: {barLeft}px; width: {barWidth}px; height: 14px;"
		role="scrollbar"
		aria-controls={targetElement?.id}
		aria-orientation="horizontal"
		aria-valuenow={targetElement?.scrollLeft ?? 0}
		aria-valuemin={0}
		aria-valuemax={(targetElement?.scrollWidth ?? totalWidth) - (targetElement?.clientWidth ?? 0)}
	>
		<div style="width: {Math.max(totalWidth, targetElement?.scrollWidth ?? 0)}px; height: 1px;"></div>
	</div>
{/if}
