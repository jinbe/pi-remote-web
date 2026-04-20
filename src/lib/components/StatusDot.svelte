<script lang="ts">
	/**
	 * Session/service status indicator.
	 *
	 * Moravec brand: solid square, never a circle, never animated.
	 * Status colour expresses state; motion is reserved for live data deltas.
	 *
	 * States:
	 *   streaming  – orange (live)
	 *   idle       – slate (active but quiet)
	 *   inactive   – muted (cold)
	 *   info       – slate (background service e.g. dev server)
	 */

	type Status = 'streaming' | 'idle' | 'inactive' | 'info';
	type Size = 'xs' | 'sm' | 'md';

	let {
		status = 'inactive',
		size = 'sm'
	}: {
		status?: Status;
		size?: Size;
	} = $props();

	const sizeClasses: Record<Size, string> = {
		xs: 'h-1.5 w-1.5',
		sm: 'h-2 w-2',
		md: 'h-2.5 w-2.5'
	};

	const colorMap: Record<Status, string> = {
		streaming: 'bg-accent',
		idle: 'bg-secondary',
		inactive: 'bg-base-content/30',
		info: 'bg-secondary'
	};

	const s = $derived(sizeClasses[size]);
	const color = $derived(colorMap[status]);
</script>

<span class="inline-block flex-shrink-0 {s} {color}"></span>
