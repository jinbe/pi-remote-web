<script lang="ts">
	import '../app.css';

	let { children } = $props();

	let theme = $state<'dark' | 'light'>('dark');

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<title>Pi Dashboard</title>
</svelte:head>

<div data-theme={theme} class="fixed inset-0 bg-base-100 text-base-content overflow-hidden">
	<div class="fixed top-2 right-2 z-50">
		<button class="btn btn-ghost btn-xs btn-circle" onclick={toggleTheme} title="Toggle theme">
			{#if theme === 'dark'}☀️{:else}🌙{/if}
		</button>
	</div>
	{@render children()}
</div>
