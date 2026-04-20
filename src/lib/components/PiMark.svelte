<script lang="ts">
	let {
		size = 24,
		color = 'currentColor',
		class: cls = '',
	}: { size?: number; color?: string; class?: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 256 256"
	xmlns="http://www.w3.org/2000/svg"
	class={cls}
	style="display: block; flex-shrink: 0;"
	aria-hidden="true"
>
	<g fill={color}>
		<rect x="32" y="60" width="192" height="28" />
		<rect x="64" y="88" width="28" height="108" />
		<rect x="164" y="88" width="28" height="76" />
		<polygon points="164,164 192,164 224,196 196,196" />
	</g>
</svg>
