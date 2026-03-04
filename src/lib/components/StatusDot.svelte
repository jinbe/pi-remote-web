<script lang="ts">
	/**
	 * Session/service status indicator dot.
	 *
	 * States:
	 *   streaming  – pulsing warning (amber) dot
	 *   idle       – solid success (green) dot
	 *   inactive   – muted base-content dot
	 *   info       – solid info (blue) dot (e.g. dev server)
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
		streaming: 'bg-warning',
		idle: 'bg-success',
		inactive: 'bg-base-content/20',
		info: 'bg-info'
	};

	const s = $derived(sizeClasses[size]);
	const color = $derived(colorMap[status]);
	const pulse = $derived(status === 'streaming');
</script>

{#if pulse}
	<span class="relative flex {s} flex-shrink-0">
		<span class="animate-ping absolute inline-flex h-full w-full rounded-full {color} opacity-75"></span>
		<span class="relative inline-flex rounded-full {s} {color}"></span>
	</span>
{:else}
	<span class="inline-block {s} rounded-full {color} flex-shrink-0"></span>
{/if}
