<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		ondelete: () => void;
		children: Snippet;
		disabled?: boolean;
	}

	let { ondelete, children, disabled = false }: Props = $props();

	let containerEl = $state<HTMLElement | null>(null);
	let offsetX = $state(0);
	let swiping = $state(false);
	let confirmed = $state(false);
	let deleting = $state(false);

	// Touch tracking
	let startX = 0;
	let startY = 0;
	let locked = false; // locked to horizontal swipe
	let dismissed = false; // ignore vertical-dominant swipes

	const DELETE_THRESHOLD = 100;
	const LOCK_DISTANCE = 10;

	function onTouchStart(e: TouchEvent) {
		if (disabled || confirmed || deleting) return;
		const touch = e.touches[0];
		startX = touch.clientX;
		startY = touch.clientY;
		locked = false;
		dismissed = false;
		swiping = true;
		offsetX = 0;
	}

	function onTouchMove(e: TouchEvent) {
		if (!swiping || dismissed || disabled) return;
		const touch = e.touches[0];
		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;

		// Determine swipe direction lock
		if (!locked && (Math.abs(dx) > LOCK_DISTANCE || Math.abs(dy) > LOCK_DISTANCE)) {
			if (Math.abs(dy) > Math.abs(dx)) {
				// Vertical swipe — let scroll happen
				dismissed = true;
				swiping = false;
				offsetX = 0;
				return;
			}
			locked = true;
		}

		if (locked) {
			e.preventDefault(); // prevent scroll while swiping horizontally
			// Only allow left swipe (negative dx)
			offsetX = Math.min(0, dx);
		}
	}

	function onTouchEnd() {
		if (!swiping && !locked) return;
		swiping = false;

		if (offsetX < -DELETE_THRESHOLD) {
			// Snap to show full delete zone
			confirmed = true;
			offsetX = -DELETE_THRESHOLD;
		} else {
			// Snap back
			offsetX = 0;
		}
		locked = false;
	}

	async function executeDelete() {
		deleting = true;
		// Animate out
		offsetX = -(containerEl?.offsetWidth ?? 400);
		// Wait for animation then call delete
		setTimeout(() => {
			ondelete();
		}, 300);
	}

	function cancelDelete() {
		confirmed = false;
		offsetX = 0;
	}
</script>

<div
	bind:this={containerEl}
	class="swipe-container relative overflow-hidden"
	role="group"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<!-- Delete background (revealed by swipe) -->
	<div
		class="absolute inset-y-0 right-0 flex items-center justify-end bg-error transition-opacity duration-150"
		style="width: {DELETE_THRESHOLD}px; opacity: {Math.min(1, Math.abs(offsetX) / DELETE_THRESHOLD)}"
	>
		{#if confirmed}
			<button
				class="flex flex-col items-center justify-center w-full h-full text-error-content gap-0.5"
				onclick={executeDelete}
				disabled={deleting}
			>
				{#if deleting}
					<span class="loading loading-spinner loading-sm"></span>
				{:else}
					<span class="text-lg">🗑</span>
					<span class="text-[10px] font-semibold uppercase tracking-wide">Delete</span>
				{/if}
			</button>
		{:else}
			<div class="flex flex-col items-center justify-center w-full h-full text-error-content gap-0.5 pointer-events-none">
				<span class="text-lg">🗑</span>
				<span class="text-[10px] font-semibold uppercase tracking-wide">Delete</span>
			</div>
		{/if}
	</div>

	<!-- Swipeable content -->
	<div
		class="relative bg-base-100 z-10"
		class:swipe-transition={!swiping}
		style="transform: translateX({offsetX}px)"
	>
		{@render children()}
	</div>

	<!-- Tap-away overlay to cancel confirmed state -->
	{#if confirmed && !deleting}
		<button
			class="absolute inset-0 z-20 cursor-default"
			style="background: transparent"
			onclick={cancelDelete}
			aria-label="Cancel delete"
		></button>
		<!-- Keep the delete button clickable above the cancel overlay -->
		<div
			class="absolute inset-y-0 right-0 z-30 flex items-center justify-end"
			style="width: {DELETE_THRESHOLD}px"
		>
			<button
				class="flex flex-col items-center justify-center w-full h-full text-error-content gap-0.5 bg-error"
				onclick={executeDelete}
				disabled={deleting}
			>
				{#if deleting}
					<span class="loading loading-spinner loading-sm"></span>
				{:else}
					<span class="text-lg">🗑</span>
					<span class="text-[10px] font-semibold uppercase tracking-wide">Delete</span>
				{/if}
			</button>
		</div>
	{/if}
</div>

<style>
	.swipe-transition {
		transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
	}
</style>
