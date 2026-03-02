<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { setContext } from 'svelte';

	let { children } = $props();

	let theme = $state<'dark' | 'light'>(
		browser ? (localStorage.getItem('pi-theme') as 'dark' | 'light') || 'dark' : 'dark'
	);

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		if (browser) localStorage.setItem('pi-theme', theme);
	}

	setContext('theme', { get theme() { return theme; }, toggleTheme });
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<title>Pi Dashboard</title>
</svelte:head>

<div data-theme={theme} class="fixed inset-0 bg-base-100 text-base-content overflow-hidden">
	{@render children()}
</div>
