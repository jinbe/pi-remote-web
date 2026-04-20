<script lang="ts">
	import PiMark from './PiMark.svelte';

	let {
		height = 22,
		color = 'currentColor',
		dimOpacity = 0.5,
	}: { height?: number; color?: string; dimOpacity?: number } = $props();

	const fontSize = $derived(height * 0.72);
</script>

<span
	class="inline-flex items-center"
	style="gap: 10px; font-family: 'Public Sans', system-ui, sans-serif; font-size: {fontSize}px; font-weight: 600; letter-spacing: -0.02em; color: {color}; line-height: 1;"
>
	<PiMark size={height} {color} />
	<span style="padding-top: 1px;">
		Pi <span style="color: {color}; opacity: {dimOpacity}; font-weight: 400;">Remote</span>
	</span>
</span>
